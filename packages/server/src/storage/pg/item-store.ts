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
} from "drizzle-orm";
import {
  generateId,
  isValidId,
  getTypeSchema,
  TYPE_REGISTRY,
  validateProperties,
  validateTransition,
  parseFilter,
  MymeError,
  ErrorCode,
  SYSTEM_DEFAULT_STATE,
} from "@mymehq/shared";
import { resolveMergePolicy } from "../policy.js";
import { filterToSqlConditions } from "../filter-sql.js";
import type {
  Item,
  CreateItemInput,
  UpdateItemInput,
  ConflictResponse,
  ItemState,
  PaginatedResult,
} from "@mymehq/shared";
import type { ItemStore, ItemFilters } from "../interface.js";
import { encodeCursor, decodeCursor } from "../interface.js";
import { detectConflict } from "../conflict.js";
import { items, metadata } from "./schema.js";
import type { PgDb } from "./connection.js";
import type { PgVersionStore } from "./version-store.js";
import type { PgSearchStore } from "./search-store.js";
import { rowToItem } from "./helpers.js";

export class PgItemStore implements ItemStore {
  constructor(
    private db: PgDb,
    private versionStore: PgVersionStore,
    private searchStore: PgSearchStore,
    private versionSnapshotIntervalMs = 600_000,
  ) {}

  private tenantWhere(id: string, tenantId?: string) {
    return tenantId
      ? and(eq(items.id, id), eq(items.tenant_id, tenantId))
      : eq(items.id, id);
  }

  async create(input: CreateItemInput, tenantId?: string): Promise<Item> {
    const id = input.id ?? generateId();
    if (input.id && !isValidId(input.id)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    // Validate properties against type schema if registered; accept unknown types
    // Empty properties {} are treated as a draft — skip validation
    const typeSchema = getTypeSchema(input.type);
    if (typeSchema && Object.keys(input.properties).length > 0) {
      const validation = validateProperties(input.type, input.properties);
      if (!validation.success) {
        throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid properties", {
          errors: validation.errors,
        });
      }
    }

    const now = new Date().toISOString();
    const state = input.state ?? SYSTEM_DEFAULT_STATE;

    return await this.db.transaction(async (tx) => {
      if (input.source && input.source_id) {
        const dedupConditions = [
          eq(items.source, input.source),
          eq(items.source_id, input.source_id),
        ];
        if (tenantId) dedupConditions.push(eq(items.tenant_id, tenantId));
        const [existing] = await tx
          .select({ id: items.id })
          .from(items)
          .where(and(...dedupConditions));
        if (existing) {
          throw new MymeError(
            ErrorCode.DUPLICATE_SOURCE,
            `Item with source=${input.source} source_id=${input.source_id} already exists`,
            { existing_id: existing.id },
          );
        }
      }

      const schemaVersion = getTypeSchema(input.type)?.version ?? 1;

      await tx.insert(items).values({
        id,
        tenant_id: tenantId,
        type: input.type,
        state,
        tier: input.tier ?? "library",
        properties: JSON.stringify(input.properties),
        created_at: now,
        updated_at: now,
        timestamp: input.timestamp ?? now,
        source: input.source,
        source_id: input.source_id,
        origin: input.origin,
        version: 1,
        schema_version: schemaVersion,
        device: input.device,
        capture_latitude: input.capture_latitude,
        capture_longitude: input.capture_longitude,
      });

      await tx.insert(metadata).values({
        item_id: id,
        tags: JSON.stringify(input.tags ?? []),
      });

      await this.searchStore.index(id, input.properties, input.type);

      return {
        id,
        type: input.type,
        state: state,
        tier: input.tier ?? "library",
        properties: input.properties,
        created_at: now,
        updated_at: now,
        timestamp: input.timestamp ?? now,
        version: 1,
        schema_version: schemaVersion,
        source: input.source ?? "unknown",
        ...(input.source_id != null && { source_id: input.source_id }),
        origin: input.origin ?? "user",
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

  async get(id: string, tenantId?: string): Promise<Item | null> {
    const [row] = await this.db
      .select()
      .from(items)
      .where(this.tenantWhere(id, tenantId));
    if (!row) return null;
    if (row.state === "trashed") return null;
    return rowToItem(row);
  }

  // Internal get that includes trashed items (for restore, delete, transition)
  private async getRaw(id: string, tenantId?: string): Promise<Item | null> {
    const [row] = await this.db
      .select()
      .from(items)
      .where(this.tenantWhere(id, tenantId));
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
    const conditions = [
      eq(items.source, source),
      eq(items.source_id, sourceId),
    ];
    if (tenantId) conditions.push(eq(items.tenant_id, tenantId));
    const [row] = await this.db
      .select()
      .from(items)
      .where(and(...conditions));
    if (!row) return null;
    if (row.state === "trashed") return null;
    return rowToItem(row);
  }

  async getMany(ids: string[], tenantId?: string): Promise<Map<string, Item>> {
    const out = new Map<string, Item>();
    if (ids.length === 0) return out;
    const unique = Array.from(new Set(ids));
    const where = tenantId
      ? and(inArray(items.id, unique), eq(items.tenant_id, tenantId))
      : inArray(items.id, unique);
    const rows = await this.db.select().from(items).where(where);
    for (const row of rows) {
      if (row.state === "trashed") continue;
      out.set(row.id, rowToItem(row));
    }
    return out;
  }

  async list(filters: ItemFilters): Promise<PaginatedResult<Item>> {
    const sortField = filters.sort ?? "created_at";
    const dir = filters.direction ?? "desc";
    const limit = Math.min(filters.limit ?? 50, 200);

    const conditions = [];

    if (filters.state) {
      conditions.push(eq(items.state, filters.state));
    } else {
      conditions.push(ne(items.state, "trashed"));
    }

    if (filters.type) {
      if (filters.type.endsWith(".*")) {
        conditions.push(like(items.type, filters.type.slice(0, -1) + "%"));
      } else {
        // Include subtypes: core.entity matches core.entity, core.entity.person, etc.
        const typeClause = or(
          eq(items.type, filters.type),
          like(items.type, filters.type + ".%"),
        );
        if (typeClause) conditions.push(typeClause);
      }
    }

    if (filters.tenantId)
      conditions.push(eq(items.tenant_id, filters.tenantId));
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

    // Timestamp range filters — uses COALESCE(timestamp, created_at) as effective date
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

    // Tags filter — items must have ALL specified tags (Postgres jsonb containment)
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        conditions.push(
          sql`EXISTS (
            SELECT 1 FROM metadata m
            WHERE m.item_id = ${items.id}
              AND m.tags::jsonb @> ${JSON.stringify([tag])}::jsonb
          )`,
        );
      }
    }

    if (filters.allowed_types) {
      const typeClauses = filters.allowed_types.map((pattern) => {
        if (pattern === "*") return sql`1=1`;
        if (pattern.endsWith(".*")) {
          return like(items.type, pattern.slice(0, -1) + "%");
        }
        return eq(items.type, pattern);
      });
      if (typeClauses.length > 0) {
        const clause = or(...typeClauses);
        if (clause) conditions.push(clause);
      }
    }

    if (filters.filter) {
      const expr = parseFilter(filters.filter);
      const filterConds = filterToSqlConditions(
        expr,
        "pg",
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

    if (filters.cursor) {
      const { v, id } = decodeCursor(filters.cursor);
      const sortCol =
        sortField === "updated_at"
          ? items.updated_at
          : sortField === "timestamp"
            ? items.timestamp
            : items.created_at;
      if (dir === "desc") {
        const clause = or(
          lt(sortCol, v),
          and(eq(sortCol, v), lt(items.id, id)),
        );
        if (clause) conditions.push(clause);
      } else {
        const clause = or(
          gt(sortCol, v),
          and(eq(sortCol, v), gt(items.id, id)),
        );
        if (clause) conditions.push(clause);
      }
    }

    const sortCol =
      sortField === "updated_at"
        ? items.updated_at
        : sortField === "timestamp"
          ? items.timestamp
          : items.created_at;
    const orderBy =
      dir === "desc"
        ? [desc(sortCol), desc(items.id)]
        : [asc(sortCol), asc(items.id)];

    const rows = await this.db
      .select()
      .from(items)
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(rowToItem);
    let cursor: string | null = null;

    if (hasMore) {
      const last = data.at(-1);
      if (!last) throw new Error("unreachable: hasMore but data is empty");
      const sortValue =
        sortField === "updated_at"
          ? last.updated_at
          : sortField === "timestamp"
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
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(items)
        .where(this.tenantWhere(id, tenantId));
      if (!row) {
        throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
      }
      if (row.state === "trashed") {
        throw new MymeError(
          ErrorCode.INVALID_TRANSITION,
          "Cannot update trashed item",
        );
      }

      const currentProps = safeJsonParse<Record<string, unknown>>(
        row.properties,
        {},
        "item update properties",
      );
      const now = new Date().toISOString();
      const deviceId = row.device ?? undefined;

      // Fast path: version omitted — always merge, no conflict detection
      if (input.version === undefined || row.version === input.version) {
        const latestTs = await this.versionStore.getLatestTimestamp(id, tx);
        if (
          shouldCreateVersion(
            latestTs,
            this.versionSnapshotIntervalMs,
            false,
            input.snapshot === true,
          )
        ) {
          await this.versionStore.create(
            id,
            row.version,
            currentProps,
            deviceId,
            tx,
          );
        }

        const merged = input.properties
          ? { ...currentProps, ...input.properties }
          : currentProps;
        const newVersion = row.version + 1;
        const newTier = input.tier ?? row.tier;

        const setClause: Record<string, unknown> = {
          properties: JSON.stringify(merged),
          version: newVersion,
          updated_at: now,
          ...(input.tier !== undefined && { tier: input.tier }),
          ...(input.timestamp !== undefined && { timestamp: input.timestamp }),
        };

        await tx
          .update(items)
          .set(setClause)
          .where(this.tenantWhere(id, tenantId));

        await this.searchStore.remove(id);
        await this.searchStore.index(id, merged, row.type);

        return rowToItem({
          ...row,
          properties: JSON.stringify(merged),
          version: newVersion,
          updated_at: now,
          tier: newTier,
        });
      }

      // Conflict detection path — look up the ancestor version
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
          conflicting_fields: Object.keys(input.properties ?? {}),
          merge_policy: resolveMergePolicy(row.type, TYPE_REGISTRY),
        } satisfies ConflictResponse;
      }

      const result = detectConflict({
        clientProperties: input.properties ?? {},
        currentProperties: currentProps,
        ancestorProperties: ancestor.properties,
      });

      if (result.type === "conflict") {
        return {
          error: { code: "version_conflict" as const, status: 409 as const },
          current: { version: row.version, properties: currentProps },
          ancestor: {
            version: input.version,
            properties: ancestor.properties,
          },
          conflicting_fields: result.conflicting_fields,
          merge_policy: resolveMergePolicy(row.type, TYPE_REGISTRY),
        } satisfies ConflictResponse;
      }

      // Auto-merge
      const mergeLatestTs = await this.versionStore.getLatestTimestamp(id, tx);
      if (
        shouldCreateVersion(
          mergeLatestTs,
          this.versionSnapshotIntervalMs,
          false,
          input.snapshot === true,
        )
      ) {
        await this.versionStore.create(
          id,
          row.version,
          currentProps,
          deviceId,
          tx,
        );
      }
      const newVersion = row.version + 1;
      const newTier = input.tier ?? row.tier;

      const mergeSet: Record<string, unknown> = {
        properties: JSON.stringify(result.merged),
        version: newVersion,
        updated_at: now,
        ...(input.tier !== undefined && { tier: input.tier }),
        ...(input.timestamp !== undefined && { timestamp: input.timestamp }),
      };

      await tx
        .update(items)
        .set(mergeSet)
        .where(this.tenantWhere(id, tenantId));

      await this.searchStore.remove(id);
      await this.searchStore.index(id, result.merged, row.type);

      return rowToItem({
        ...row,
        properties: JSON.stringify(result.merged),
        version: newVersion,
        updated_at: now,
        tier: newTier,
      });
    });
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    await this.db
      .update(items)
      .set({ state: "trashed", updated_at: new Date().toISOString() })
      .where(this.tenantWhere(id, tenantId));

    await this.searchStore.remove(id);
  }

  async purge(id: string, tenantId?: string): Promise<void> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    if (row.state !== "trashed") {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Only trashed items can be purged",
      );
    }

    // Cascade: metadata and versions are deleted via ON DELETE CASCADE.
    // Search index must be removed explicitly.
    await this.db.delete(items).where(this.tenantWhere(id, tenantId));
    await this.searchStore.remove(id);
  }

  async bulkPurge(ids: string[], tenantId?: string): Promise<number> {
    if (ids.length === 0) return 0;
    const unique = Array.from(new Set(ids));
    const conditions = [inArray(items.id, unique)];
    if (tenantId) conditions.push(eq(items.tenant_id, tenantId));
    const scopedWhere = and(...conditions);

    return await this.db.transaction(async (tx) => {
      const scopedIds = (
        await tx.select({ id: items.id }).from(items).where(scopedWhere)
      ).map((row) => row.id);
      if (scopedIds.length === 0) return 0;

      // No-op on Postgres (tsvector is computed at query time), but kept
      // to mirror the SQLite path and stay correct if the search store
      // ever materialises rows.
      for (const id of scopedIds) {
        await this.searchStore.remove(id);
      }
      await tx.delete(items).where(inArray(items.id, scopedIds));
      return scopedIds.length;
    });
  }

  async purgeTrashedOlderThan(
    beforeDate: string,
    tenantId?: string,
  ): Promise<number> {
    const baseConditions = [
      eq(items.state, "trashed"),
      lt(items.updated_at, beforeDate),
    ];
    if (tenantId) {
      baseConditions.push(eq(items.tenant_id, tenantId));
    }
    const where = and(...baseConditions);

    return await this.db.transaction(async (tx) => {
      const idRows = await tx.select({ id: items.id }).from(items).where(where);
      if (idRows.length === 0) return 0;

      const ids = idRows.map((row) => row.id);
      // No-op on Postgres — see bulkPurge.
      for (const id of ids) {
        await this.searchStore.remove(id);
      }
      await tx.delete(items).where(inArray(items.id, ids));
      return ids.length;
    });
  }

  async expireFeedOlderThan(
    beforeDate: string,
    tenantId?: string,
  ): Promise<number> {
    const baseConditions = [
      eq(items.tier, "feed"),
      lt(items.updated_at, beforeDate),
    ];
    if (tenantId) {
      baseConditions.push(eq(items.tenant_id, tenantId));
    }
    const where = and(...baseConditions);

    return await this.db.transaction(async (tx) => {
      const idRows = await tx.select({ id: items.id }).from(items).where(where);
      if (idRows.length === 0) return 0;

      const ids = idRows.map((row) => row.id);
      // No-op on Postgres — see bulkPurge.
      for (const id of ids) {
        await this.searchStore.remove(id);
      }
      await tx.delete(items).where(inArray(items.id, ids));
      return ids.length;
    });
  }

  async restore(id: string, tenantId?: string): Promise<Item> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    if (row.state !== "trashed") {
      throw new MymeError(ErrorCode.INVALID_TRANSITION, "Item is not trashed");
    }

    const now = new Date().toISOString();
    await this.db
      .update(items)
      .set({ state: "active", updated_at: now })
      .where(this.tenantWhere(id, tenantId));

    await this.searchStore.index(id, row.properties, row.type);

    return { ...row, state: "active" as ItemState, updated_at: now };
  }

  async transition(
    id: string,
    state: ItemState,
    tenantId?: string,
  ): Promise<Item> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const error = validateTransition(row.type, row.state, state);
    if (error) {
      throw new MymeError(ErrorCode.INVALID_TRANSITION, error);
    }

    // State transitions always create a version snapshot
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
      .where(this.tenantWhere(id, tenantId));

    if (state === "trashed") {
      await this.searchStore.remove(id);
    } else if (row.state === "trashed") {
      await this.searchStore.index(id, row.properties, row.type);
    }

    return { ...row, state, updated_at: now };
  }

  async stats(
    tenantId?: string,
    allowedTypes?: string[],
  ): Promise<Record<string, number>> {
    const conditions = [];
    if (tenantId) {
      conditions.push(eq(items.tenant_id, tenantId));
    }
    if (allowedTypes && allowedTypes.length > 0) {
      conditions.push(inArray(items.type, allowedTypes));
    }

    // Use ::int (matches sibling counters in version-store, webhook-store,
    // type-store). ::bigint is serialized as a string by node-postgres, which
    // breaks the numeric reduce in the /metrics route; ::int is returned as
    // a JS number. Per-state item counts safely fit in int.
    const rows = await this.db
      .select({
        state: items.state,
        count: sql<number>`count(*)::int`,
      })
      .from(items)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(items.state);

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.state] = row.count;
    }
    return result;
  }
}
