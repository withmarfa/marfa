import { shouldCreateVersion } from "../version-gating.js";
import { safeJsonParse } from "../json-utils.js";
import {
  eq,
  ne,
  and,
  or,
  lt,
  gt,
  desc,
  asc,
  like,
  sql,
  inArray,
  isNull,
} from "drizzle-orm";
import {
  generateId,
  isValidId,
  getTypeSchema,
  validateProperties,
  coerceNullProperties,
  validateTransition,
  parseFilter,
  MarfaError,
  ErrorCode,
  SYSTEM_DEFAULT_STATE,
} from "@withmarfa/shared";
import { resolveMergePolicy } from "../policy.js";
import { filterToSqlConditions } from "../filter-sql.js";
import type {
  Item,
  CreateItemInput,
  UpdateItemInput,
  ConflictResponse,
  ItemState,
  PaginatedResult,
} from "@withmarfa/shared";
import type { ItemStore, ItemFilters, ItemGetOptions } from "../interface.js";
import {
  encodeCursor,
  decodeCursorNullable,
  parseSortField,
} from "../interface.js";
import { buildPropertySortExpr, propertySortValue } from "../property-sort.js";
import { detectConflict } from "../conflict.js";
import { edges, items, metadata, versions } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import type { SqliteVersionStore } from "./version-store.js";
import type { SqliteSearchStore } from "./search-store.js";
import { rowToItem } from "./helpers.js";

/**
 * Detect a SQLite unique-constraint violation on `idx_items_source_dedup`.
 * Mirrors the PG-side trap (see `pg/item-store.ts`). The route-layer
 * pre-check catches the common case; this covers the narrow race window.
 */
function isSourceDedupViolation(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (
    code.includes("SQLITE_CONSTRAINT") &&
    message.includes("idx_items_source_dedup")
  ) {
    return true;
  }
  if (message.includes("idx_items_source_dedup")) return true;
  return false;
}

/**
 * Detect a primary-key collision on `items.id`. Happens when a caller
 * supplies an explicit `id` that already exists. The tenant-scoped
 * pre-checks (`get(id, tenantId)`) miss the case where the id belongs to
 * ANOTHER tenant — the PK is `id` alone, not `(tenant_id, id)`, so the
 * insert trips the constraint. Surface it as a clean `CONFLICT` (409)
 * instead of an opaque 500. Drizzle wraps the libsql error: the outer
 * Error carries a "Failed query" message with `code: undefined`, while the
 * `cause` carries `SQLITE_CONSTRAINT` + the offending column (`items.id`)
 * in its message. Inspect both. The source-dedup index has its own trap.
 */
function isPrimaryKeyViolation(err: unknown): boolean {
  const cause =
    err != null && typeof err === "object"
      ? (err as { cause?: unknown }).cause
      : undefined;
  for (const layer of [err, cause]) {
    if (layer == null || typeof layer !== "object") continue;
    const e = layer as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" ? e.code : "";
    const message = typeof e.message === "string" ? e.message : "";
    if (message.includes("idx_items_source_dedup")) return false;
    if (
      code.includes("SQLITE_CONSTRAINT") &&
      (message.includes("items.id") || message.includes("PRIMARY KEY"))
    ) {
      return true;
    }
  }
  return false;
}

export class SqliteItemStore implements ItemStore {
  constructor(
    private db: DrizzleDb,
    private versionStore: SqliteVersionStore,
    private searchStore: SqliteSearchStore,
    private versionSnapshotIntervalMs = 600_000,
  ) {}

  private tenantWhere(
    id: string,
    tenantId?: string,
    includePlatformScoped?: boolean,
  ) {
    if (!tenantId) return eq(items.id, id);
    if (includePlatformScoped) {
      // Catalog widening — see `ItemGetOptions.includePlatformScoped`.
      // Only the public `get` path threads `true` here; every other
      // caller (update, delete, transition, ...) leaves the equality
      // fence in place.
      return and(
        eq(items.id, id),
        or(eq(items.tenant_id, tenantId), isNull(items.tenant_id)),
      );
    }
    return and(eq(items.id, id), eq(items.tenant_id, tenantId));
  }

  async create(input: CreateItemInput, tenantId?: string): Promise<Item> {
    const id = input.id ?? generateId();
    if (input.id && !isValidId(input.id)) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    // Every item must carry a registered type. An unregistered identifier has
    // no schema to validate against, so accepting it would let typo'd or
    // ad-hoc types persist with zero conformance checking — the opposite of a
    // typed data layer's promise. Reject before any write. Custom types are
    // loaded into the registry at startup and on `POST /types`, so a legitimate
    // custom type resolves here. The registry is tenant-scoped: a custom type
    // resolves only for its owning tenant, so a tenant cannot create items of
    // another tenant's custom type — the create gate sees `unknown_type`.
    const typeSchema = getTypeSchema(input.type, tenantId);
    if (!typeSchema) {
      throw new MarfaError(
        ErrorCode.UNKNOWN_TYPE,
        `Unknown type: ${input.type}. Register it via POST /types before creating items of this type.`,
        { type: input.type },
      );
    }
    // Validate properties against the type schema. Runs unconditionally —
    // an empty `{}` must still fail required-field checks (a core.note with
    // no body is invalid whether properties is empty or partially filled).
    // Persist the validated (coerced) properties so `null` on an optional
    // field — which validation treats as "unset" — drops out before the write
    // rather than landing as a stored null.
    const validation = validateProperties(input.type, input.properties, {
      tenantId,
    });
    if (!validation.success) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid properties", {
        errors: validation.errors,
      });
    }
    const properties = validation.data;

    const now = new Date().toISOString();
    const state = input.state ?? SYSTEM_DEFAULT_STATE;

    return await this.db.transaction(async (tx) => {
      if (input.source && input.source_id) {
        const dedupConditions = [
          eq(items.source, input.source),
          eq(items.source_id, input.source_id),
        ];
        if (tenantId) dedupConditions.push(eq(items.tenant_id, tenantId));
        const existing = await tx
          .select({ id: items.id })
          .from(items)
          .where(and(...dedupConditions))
          .get();
        if (existing) {
          throw new MarfaError(
            ErrorCode.DUPLICATE_SOURCE,
            `Item with source=${input.source} source_id=${input.source_id} already exists`,
            { existing_id: existing.id },
          );
        }
      }

      const schemaVersion = getTypeSchema(input.type, tenantId)?.version ?? 1;

      try {
        await tx
          .insert(items)
          .values({
            id,
            tenant_id: tenantId,
            type: input.type,
            state,
            tier: input.tier ?? "library",
            properties: JSON.stringify(properties),
            created_at: now,
            updated_at: now,
            timestamp: input.timestamp ?? now,
            source: input.source,
            source_id: input.source_id,
            version: 1,
            schema_version: schemaVersion,
            device: input.device,
            capture_latitude: input.capture_latitude,
            capture_longitude: input.capture_longitude,
          })
          .run();
      } catch (err) {
        if (isPrimaryKeyViolation(err)) {
          throw new MarfaError(
            ErrorCode.CONFLICT,
            `Item with id=${id} already exists`,
            { existing_id: id },
          );
        }
        throw err;
      }

      await tx
        .insert(metadata)
        .values({
          item_id: id,
          tags: JSON.stringify(input.tags ?? []),
        })
        .run();

      await this.searchStore.index(id, properties, input.type, tenantId);

      return {
        id,
        type: input.type,
        state: state,
        tier: input.tier ?? "library",
        properties,
        created_at: now,
        updated_at: now,
        timestamp: input.timestamp ?? now,
        version: 1,
        schema_version: schemaVersion,
        source: input.source ?? "unknown",
        ...(input.source_id != null && { source_id: input.source_id }),
        ...(input.device != null && { device: input.device }),
        ...(input.capture_latitude != null && {
          capture_latitude: input.capture_latitude,
        }),
        ...(input.capture_longitude != null && {
          capture_longitude: input.capture_longitude,
        }),
      } satisfies Item;
    });
  }

  async get(
    id: string,
    tenantId?: string,
    options?: ItemGetOptions,
  ): Promise<Item | null> {
    const row = await this.db
      .select()
      .from(items)
      .where(this.tenantWhere(id, tenantId, options?.includePlatformScoped))
      .get();
    if (!row) return null;
    if (row.state === "trashed") return null;
    return rowToItem(row);
  }

  // Internal get that includes trashed items (for restore, delete, transition)
  private async getRaw(id: string, tenantId?: string): Promise<Item | null> {
    const row = await this.db
      .select()
      .from(items)
      .where(this.tenantWhere(id, tenantId))
      .get();
    if (!row) return null;
    return rowToItem(row);
  }

  getIncludingTrashed(id: string, tenantId?: string): Promise<Item | null> {
    return this.getRaw(id, tenantId);
  }

  async findBySourceId(
    source: string,
    sourceId: string,
    tenantId?: string,
  ): Promise<Item | null> {
    const item = await this.findBySourceIdIncludingTrashed(
      source,
      sourceId,
      tenantId,
    );
    if (item?.state === "trashed") return null;
    return item;
  }

  async findBySourceIdIncludingTrashed(
    source: string,
    sourceId: string,
    tenantId?: string,
  ): Promise<Item | null> {
    const conditions = [
      eq(items.source, source),
      eq(items.source_id, sourceId),
    ];
    if (tenantId) conditions.push(eq(items.tenant_id, tenantId));
    const row = await this.db
      .select()
      .from(items)
      .where(and(...conditions))
      .get();
    if (!row) return null;
    return rowToItem(row);
  }

  async getMany(ids: string[], tenantId?: string): Promise<Map<string, Item>> {
    const out = new Map<string, Item>();
    if (ids.length === 0) return out;
    const unique = Array.from(new Set(ids));
    const where = tenantId
      ? and(inArray(items.id, unique), eq(items.tenant_id, tenantId))
      : inArray(items.id, unique);
    const rows = await this.db.select().from(items).where(where).all();
    for (const row of rows) {
      if (row.state === "trashed") continue;
      out.set(row.id, rowToItem(row));
    }
    return out;
  }

  async list(filters: ItemFilters): Promise<PaginatedResult<Item>> {
    const sort = parseSortField(filters.sort);
    const dir = filters.direction ?? "desc";
    const limit = Math.min(filters.limit ?? 50, 200);

    // For a property sort, the ORDER BY / cursor comparison runs against a
    // JSON-extracted expression rather than a column. NULLS LAST is applied in
    // both directions, with `id` as a stable ascending tiebreak.
    const propertySort =
      sort.kind === "property"
        ? buildPropertySortExpr(
            items.properties,
            sort.field,
            "sqlite",
            filters.type,
            filters.tenantId,
          )
        : null;

    const conditions = [];

    if (filters.tenantId) {
      // Opt-in widening for catalog list endpoints — see
      // `ItemFilters.includePlatformScoped` for why platform-scoped
      // (tenant_id IS NULL) rows surface to tenant callers in this
      // narrow case. Default keeps the strict equality fence.
      if (filters.includePlatformScoped) {
        const tenantClause = or(
          eq(items.tenant_id, filters.tenantId),
          isNull(items.tenant_id),
        );
        if (tenantClause) conditions.push(tenantClause);
      } else {
        conditions.push(eq(items.tenant_id, filters.tenantId));
      }
    }

    if (filters.state) {
      conditions.push(eq(items.state, filters.state));
    } else {
      conditions.push(ne(items.state, "trashed"));
    }

    if (filters.type) {
      if (filters.type.endsWith(".*")) {
        conditions.push(like(items.type, filters.type.slice(0, -1) + "%"));
      } else {
        // Include subtypes: `core.entity` also matches `core.entity.person`, etc.
        const typeClause = or(
          eq(items.type, filters.type),
          like(items.type, filters.type + ".%"),
        );
        if (typeClause) conditions.push(typeClause);
      }
    }

    if (filters.source) conditions.push(eq(items.source, filters.source));

    if (filters.sources && filters.sources.length > 0) {
      conditions.push(inArray(items.source, filters.sources));
    }

    if (filters.tier !== undefined) {
      conditions.push(eq(items.tier, filters.tier));
    }

    if (filters.exclude_system_types) {
      conditions.push(sql`${items.type} NOT LIKE 'system.%'`);
    }

    if (filters.since) {
      conditions.push(
        sql`COALESCE(${items.timestamp}, ${items.created_at}) >= ${filters.since}`,
      );
    }
    if (filters.until) {
      conditions.push(
        sql`COALESCE(${items.timestamp}, ${items.created_at}) <= ${filters.until}`,
      );
    }

    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        conditions.push(
          sql`EXISTS (
            SELECT 1 FROM metadata m, json_each(m.tags) je
            WHERE m.item_id = ${items.id} AND je.value = ${tag}
          )`,
        );
      }
    }

    if (filters.allowed_types) {
      // An empty allowed_types array means "the caller has no readable
      // types" — typically a member-tier credential or an OAuth token
      // whose scopes don't project into any type_permission. The route
      // layer (computeTypeFilter) returns `undefined` for "no filter"
      // (admin / tenant_admin) and an array for "filter to these patterns".
      // An empty array must filter to zero rows.
      if (filters.allowed_types.length === 0) {
        conditions.push(sql`1=0`);
      } else {
        const typeClauses = filters.allowed_types.map((pattern) => {
          if (pattern === "*") return sql`1=1`;
          if (pattern.endsWith(".*")) {
            return like(items.type, pattern.slice(0, -1) + "%");
          }
          return eq(items.type, pattern);
        });
        const clause = or(...typeClauses);
        if (clause) conditions.push(clause);
      }
    }

    if (filters.filter) {
      const expr = parseFilter(filters.filter);
      const filterConds = filterToSqlConditions(
        expr,
        "sqlite",
        items,
        filters.tenantId,
      );
      if (expr.logical === "OR") {
        const orClause = or(...filterConds);
        if (orClause) conditions.push(orClause);
      } else {
        conditions.push(...filterConds);
      }
    }

    const systemSortCol =
      sort.kind === "system"
        ? sort.column === "updated_at"
          ? items.updated_at
          : sort.column === "timestamp"
            ? items.timestamp
            : items.created_at
        : null;

    if (filters.cursor) {
      const { v, id } = decodeCursorNullable(filters.cursor);
      if (propertySort) {
        // Keyset over a nullable, NULLS-LAST expression. `id` is an ascending
        // tiebreak in both directions, so the page boundary is a total order.
        const e = propertySort.expr;
        if (v === null) {
          // Already in the trailing NULL block — only later NULL rows remain.
          conditions.push(and(sql`${e} IS NULL`, gt(items.id, id)));
        } else {
          // Coerce the bound for the numeric path so the value comparison stays
          // numeric; the equality + id tiebreak advances past the boundary row.
          const bound = propertySort.numeric ? Number(v) : v;
          const valueCmp =
            dir === "desc" ? sql`${e} < ${bound}` : sql`${e} > ${bound}`;
          const clause = or(
            valueCmp,
            and(sql`${e} = ${bound}`, gt(items.id, id)),
            sql`${e} IS NULL`,
          );
          if (clause) conditions.push(clause);
        }
      } else if (systemSortCol && v !== null) {
        // System columns are NOT NULL, so the cursor value is always present.
        if (dir === "desc") {
          const clause = or(
            lt(systemSortCol, v),
            and(eq(systemSortCol, v), lt(items.id, id)),
          );
          if (clause) conditions.push(clause);
        } else {
          const clause = or(
            gt(systemSortCol, v),
            and(eq(systemSortCol, v), gt(items.id, id)),
          );
          if (clause) conditions.push(clause);
        }
      }
    }

    let orderBy;
    if (propertySort) {
      const e = propertySort.expr;
      // `(e IS NULL)` is 0 for present values, 1 for NULL — ordering it ascending
      // first pushes NULLs to the end regardless of the value direction.
      const valueOrder = dir === "desc" ? desc(e) : asc(e);
      orderBy = [sql`${e} IS NULL`, valueOrder, asc(items.id)];
    } else {
      const col = systemSortCol ?? items.created_at;
      orderBy =
        dir === "desc"
          ? [desc(col), desc(items.id)]
          : [asc(col), asc(items.id)];
    }

    const rows = await this.db
      .select()
      .from(items)
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(rowToItem);
    let cursor: string | null = null;

    if (hasMore) {
      const last = data.at(-1);
      if (!last) throw new Error("unreachable: hasMore but data is empty");
      const sortValue =
        sort.kind === "property"
          ? propertySortValue(last.properties, sort)
          : sort.column === "updated_at"
            ? last.updated_at
            : sort.column === "timestamp"
              ? last.timestamp
              : last.created_at;
      cursor = encodeCursor(sortValue, last.id);
    }

    return { data, cursor, has_more: hasMore };
  }

  async update(
    id: string,
    input: UpdateItemInput,
    tenantId?: string,
  ): Promise<Item | ConflictResponse> {
    const whereClause = this.tenantWhere(id, tenantId);

    return await this.db.transaction(async (tx) => {
      const row = await tx.select().from(items).where(whereClause).get();
      if (!row) {
        throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
      }
      if (row.state === "trashed") {
        throw new MarfaError(
          ErrorCode.INVALID_TRANSITION,
          "Cannot update trashed item",
        );
      }

      const currentProps = safeJsonParse<Record<string, unknown>>(
        row.properties,
        {},
        "item update properties",
      );
      // Treat `null` on an optional field as "leave unset" — the same
      // semantics the create path applies — so a re-synced payload that emits
      // explicit nulls for absent fields doesn't overwrite stored values with
      // null. Required-field nulls are preserved for any downstream check.
      const incomingProps =
        input.properties !== undefined
          ? coerceNullProperties(row.type, input.properties)
          : undefined;
      const now = new Date().toISOString();
      const deviceId = row.device ?? undefined;

      // Read latest version timestamp inside the tx so the gating decision
      // is consistent with the rest of the update.
      const latestVersionRow = await tx
        .select({ created_at: versions.created_at })
        .from(versions)
        .where(eq(versions.item_id, id))
        .orderBy(desc(versions.version))
        .limit(1)
        .get();
      const latestTs = latestVersionRow?.created_at ?? null;

      const writeVersion = async (
        propertiesToSnapshot: Record<string, unknown>,
      ) => {
        await tx
          .insert(versions)
          .values({
            id: generateId(),
            item_id: id,
            version: row.version,
            properties: JSON.stringify(propertiesToSnapshot),
            created_at: now,
            device: deviceId ?? null,
          })
          .run();
      };

      if (input.version === undefined || row.version === input.version) {
        if (
          shouldCreateVersion(
            latestTs,
            this.versionSnapshotIntervalMs,
            false,
            input.force_snapshot === true,
          )
        ) {
          await writeVersion(currentProps);
        }

        const merged = incomingProps
          ? { ...currentProps, ...incomingProps }
          : currentProps;
        const newVersion = row.version + 1;
        const newTier = input.tier ?? row.tier;

        const setClause: Record<string, unknown> = {
          properties: JSON.stringify(merged),
          version: newVersion,
          updated_at: now,
          ...(input.tier !== undefined && { tier: input.tier }),
          ...(input.timestamp !== undefined && { timestamp: input.timestamp }),
          ...(input.source_id !== undefined && {
            source_id: input.source_id,
          }),
        };

        try {
          await tx.update(items).set(setClause).where(whereClause).run();
        } catch (err) {
          if (isSourceDedupViolation(err)) {
            throw new MarfaError(
              ErrorCode.SOURCE_ID_CONFLICT,
              `source_id "${String(input.source_id)}" is already in use under source "${row.source ?? "unknown"}"`,
              { source: row.source, source_id: input.source_id },
            );
          }
          throw err;
        }

        await this.searchStore.remove(id);
        await this.searchStore.index(id, merged, row.type, tenantId);

        return rowToItem({
          ...row,
          properties: JSON.stringify(merged),
          version: newVersion,
          updated_at: now,
          tier: newTier,
          ...(input.source_id !== undefined && {
            source_id: input.source_id,
          }),
        });
      }

      // Resolve the ancestor version inside the same transaction (passing
      // `tx`) so it's consistent with the item row read above — mirrors the
      // Postgres path. `input.version` is known-defined here: the omitted and
      // equal-version cases returned in the branch above.
      const ancestor = await this.versionStore.getByVersion(
        id,
        input.version,
        tx,
      );

      if (!ancestor) {
        return {
          error: { code: "version_conflict" as const, status: 409 as const },
          current: { version: row.version, properties: currentProps },
          ancestor: { version: input.version, properties: {} },
          conflicting_fields: Object.keys(incomingProps ?? {}),
          merge_policy: resolveMergePolicy(row.type, (id) =>
            getTypeSchema(id, tenantId),
          ),
        } satisfies ConflictResponse;
      }

      const result = detectConflict({
        clientProperties: incomingProps ?? {},
        currentProperties: currentProps,
        ancestorProperties: ancestor.properties,
      });

      if (result.type === "conflict") {
        return {
          error: { code: "version_conflict" as const, status: 409 as const },
          current: { version: row.version, properties: currentProps },
          ancestor: { version: input.version, properties: ancestor.properties },
          conflicting_fields: result.conflicting_fields,
          merge_policy: resolveMergePolicy(row.type, (id) =>
            getTypeSchema(id, tenantId),
          ),
        } satisfies ConflictResponse;
      }

      if (
        shouldCreateVersion(
          latestTs,
          this.versionSnapshotIntervalMs,
          false,
          input.force_snapshot === true,
        )
      ) {
        await writeVersion(currentProps);
      }
      const newVersion = row.version + 1;
      const newTier = input.tier ?? row.tier;

      const mergeSet: Record<string, unknown> = {
        properties: JSON.stringify(result.merged),
        version: newVersion,
        updated_at: now,
        ...(input.tier !== undefined && { tier: input.tier }),
        ...(input.timestamp !== undefined && { timestamp: input.timestamp }),
        ...(input.source_id !== undefined && {
          source_id: input.source_id,
        }),
      };

      try {
        await tx.update(items).set(mergeSet).where(whereClause).run();
      } catch (err) {
        if (isSourceDedupViolation(err)) {
          throw new MarfaError(
            ErrorCode.SOURCE_ID_CONFLICT,
            `source_id "${String(input.source_id)}" is already in use under source "${row.source ?? "unknown"}"`,
            { source: row.source, source_id: input.source_id },
          );
        }
        throw err;
      }

      await this.searchStore.remove(id);
      await this.searchStore.index(id, result.merged, row.type, tenantId);

      return rowToItem({
        ...row,
        properties: JSON.stringify(result.merged),
        version: newVersion,
        updated_at: now,
        tier: newTier,
        ...(input.source_id !== undefined && {
          source_id: input.source_id,
        }),
      });
    });
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    await this.db
      .update(items)
      .set({ state: "trashed", updated_at: new Date().toISOString() })
      .where(this.tenantWhere(id, tenantId))
      .run();

    await this.searchStore.remove(id);
  }

  async purge(id: string, tenantId?: string): Promise<void> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    if (row.state !== "trashed") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Only trashed items can be purged",
      );
    }

    // metadata and versions cascade; search index must be removed explicitly.
    await this.db.delete(items).where(this.tenantWhere(id, tenantId)).run();

    await this.searchStore.remove(id);
  }

  async bulkPurge(ids: string[], tenantId?: string): Promise<number> {
    if (ids.length === 0) return 0;
    const unique = Array.from(new Set(ids));
    const conditions = [inArray(items.id, unique)];
    if (tenantId) conditions.push(eq(items.tenant_id, tenantId));
    const scopedWhere = and(...conditions);

    return await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: items.id })
        .from(items)
        .where(scopedWhere)
        .all();
      const scopedIds = rows.map((row) => row.id);
      if (scopedIds.length === 0) return 0;

      for (const id of scopedIds) {
        await this.searchStore.remove(id);
      }
      await tx.delete(items).where(inArray(items.id, scopedIds)).run();
      return scopedIds.length;
    });
  }

  async purgeTrashedOlderThan(
    beforeDate: string,
    tenantId?: string | null,
  ): Promise<number> {
    const baseConditions = [
      eq(items.state, "trashed"),
      lt(items.updated_at, beforeDate),
    ];
    // tenantId === null filters to rows where tenant_id IS NULL
    // (single-tenant self-host items + any rows with no tenant scope).
    // Empty string is NOT a sentinel here — items.tenant_id is nullable,
    // not empty-string-defaulted like blobs.tenant_id.
    if (tenantId === null) {
      baseConditions.push(isNull(items.tenant_id));
    } else if (tenantId !== undefined) {
      baseConditions.push(eq(items.tenant_id, tenantId));
    }
    const where = and(...baseConditions);

    return await this.db.transaction(async (tx) => {
      const idRows = await tx
        .select({ id: items.id })
        .from(items)
        .where(where)
        .all();
      if (idRows.length === 0) return 0;

      const ids = idRows.map((row) => row.id);
      for (const id of ids) {
        await this.searchStore.remove(id);
      }
      // Edges carry no FK to items, so nothing else ever collects them —
      // without this the background sweep leaves a dangling edge row for
      // every relationship a purged item had. Deleted by id membership
      // rather than by tenant: `ids` is already tenant-resolved above, and
      // an edge pointing at a purged item is garbage whatever its tenant
      // stamp. Same statement shape as the bulk-action purge worker.
      await tx.delete(edges).where(inArray(edges.source_id, ids)).run();
      await tx.delete(edges).where(inArray(edges.target_id, ids)).run();
      await tx.delete(items).where(inArray(items.id, ids)).run();
      return ids.length;
    });
  }

  async restore(id: string, tenantId?: string): Promise<Item> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    if (row.state !== "trashed") {
      throw new MarfaError(ErrorCode.INVALID_TRANSITION, "Item is not trashed");
    }

    const now = new Date().toISOString();
    await this.db
      .update(items)
      .set({ state: "active", updated_at: now })
      .where(this.tenantWhere(id, tenantId))
      .run();

    await this.searchStore.index(id, row.properties, row.type, tenantId);

    return { ...row, state: "active" as ItemState, updated_at: now };
  }

  async transition(
    id: string,
    state: ItemState,
    tenantId?: string,
  ): Promise<Item> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const error = validateTransition(row.type, row.state, state);
    if (error) {
      throw new MarfaError(ErrorCode.INVALID_TRANSITION, error);
    }

    // State transitions always snapshot current properties.
    await this.versionStore.create(
      id,
      row.version,
      row.properties,
      row.device ?? undefined,
    );

    const now = new Date().toISOString();
    await this.db
      .update(items)
      .set({ state, updated_at: now })
      .where(this.tenantWhere(id, tenantId))
      .run();

    if (state === "trashed") {
      await this.searchStore.remove(id);
    } else if (row.state === "trashed") {
      await this.searchStore.index(id, row.properties, row.type, tenantId);
    }

    return { ...row, state, updated_at: now };
  }

  async stats(
    tenantId?: string,
    allowedTypes?: string[],
  ): Promise<Record<string, number>> {
    let sqlText = "SELECT state, COUNT(*) as count FROM items WHERE 1=1";
    const params: unknown[] = [];

    if (tenantId) {
      sqlText += " AND tenant_id = ?";
      params.push(tenantId);
    }

    if (allowedTypes && allowedTypes.length > 0) {
      sqlText += ` AND type IN (${allowedTypes.map(() => "?").join(", ")})`;
      params.push(...allowedTypes);
    }

    sqlText += " GROUP BY state";

    const fragments = sqlText.split("?");
    const builder = sql.empty();
    for (let i = 0; i < fragments.length; i++) {
      builder.append(sql.raw(fragments[i] ?? ""));
      if (i < fragments.length - 1) {
        builder.append(sql`${params[i]}`);
      }
    }
    const rows = await this.db.all<{ state: string; count: number }>(builder);
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.state] = row.count;
    }
    return result;
  }
}
