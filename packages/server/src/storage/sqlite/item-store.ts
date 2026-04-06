import { shouldCreateVersion } from "../version-gating.js";
import { safeJsonParse } from "../json-utils.js";
/* eslint-disable @typescript-eslint/require-await -- sync better-sqlite3 implementing async interface */
import { eq, ne, and, or, lt, gt, desc, asc, like, sql } from "drizzle-orm";
import {
  generateId,
  isValidId,
  getTypeSchema,
  validateProperties,
  validateTransition,
  parseFilter,
  MymeError,
  ErrorCode,
} from "@mymehq/shared";
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
import { items, metadata, threads } from "./schema.js";
import type { DrizzleDb, RawDb } from "./connection.js";
import type { SqliteVersionStore } from "./version-store.js";
import type { SqliteSearchStore } from "./search-store.js";
import { rowToItem } from "./helpers.js";

export class SqliteItemStore implements ItemStore {
  constructor(
    private db: DrizzleDb,
    private raw: RawDb,
    private versionStore: SqliteVersionStore,
    private searchStore: SqliteSearchStore,
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
    const state = input.state ?? typeSchema?.default_state ?? "new";

    const createFn = this.raw.transaction(() => {
      if (input.source && input.source_id) {
        const dedupConditions = [
          eq(items.source, input.source),
          eq(items.source_id, input.source_id),
        ];
        if (tenantId) dedupConditions.push(eq(items.tenant_id, tenantId));
        const existing = this.db
          .select({ id: items.id })
          .from(items)
          .where(and(...dedupConditions))
          .get();
        if (existing) {
          throw new MymeError(
            ErrorCode.DUPLICATE_SOURCE,
            `Item with source=${input.source} source_id=${input.source_id} already exists`,
            { existing_id: existing.id },
          );
        }
      }

      if (input.parent_id) {
        const parent = this.db
          .select({ id: items.id })
          .from(items)
          .where(
            tenantId
              ? and(
                  eq(items.id, input.parent_id),
                  eq(items.tenant_id, tenantId),
                )
              : eq(items.id, input.parent_id),
          )
          .get();
        if (!parent) {
          throw new MymeError(
            ErrorCode.ITEM_NOT_FOUND,
            "Parent item not found",
          );
        }
      }

      if (input.thread_id) {
        const thread = this.db
          .select({ id: threads.id })
          .from(threads)
          .where(
            tenantId
              ? and(
                  eq(threads.id, input.thread_id),
                  eq(threads.tenant_id, tenantId),
                )
              : eq(threads.id, input.thread_id),
          )
          .get();
        if (!thread) {
          throw new MymeError(ErrorCode.THREAD_NOT_FOUND, "Thread not found");
        }
      }

      this.db
        .insert(items)
        .values({
          id,
          tenant_id: tenantId,
          type: input.type,
          state,
          properties: JSON.stringify(input.properties),
          created_at: now,
          updated_at: now,
          timestamp: input.timestamp ?? now,
          source: input.source,
          source_id: input.source_id,
          origin: input.origin,
          version: 1,
          device_id: input.device_id,
          parent_id: input.parent_id,
          thread_id: input.thread_id,
          capture_latitude: input.capture_latitude,
          capture_longitude: input.capture_longitude,
        })
        .run();

      this.db
        .insert(metadata)
        .values({
          item_id: id,
          tags: JSON.stringify(input.tags ?? []),
          about: JSON.stringify(input.about ?? []),
        })
        .run();

      this.searchStore.index(id, input.properties).catch((e: unknown) => {
        console.error("Search index failed:", e);
      });

      if (input.thread_id) {
        this.db
          .update(threads)
          .set({ updated_at: now })
          .where(eq(threads.id, input.thread_id))
          .run();
      }

      return {
        id,
        type: input.type,
        state: state,
        properties: input.properties,
        created_at: now,
        updated_at: now,
        timestamp: input.timestamp ?? now,
        version: 1,
        ...(input.source != null && { source: input.source }),
        ...(input.source_id != null && { source_id: input.source_id }),
        ...(input.origin != null && { origin: input.origin }),
        ...(input.device_id != null && { device_id: input.device_id }),
        parent_id: input.parent_id ?? null,
        thread_id: input.thread_id ?? null,
        ...(input.capture_latitude != null && {
          capture_latitude: input.capture_latitude,
        }),
        ...(input.capture_longitude != null && {
          capture_longitude: input.capture_longitude,
        }),
      } satisfies Item;
    });

    return createFn();
  }

  // Fix 4: trashed items return null (404 to callers)
  async get(id: string, tenantId?: string): Promise<Item | null> {
    const row = this.db
      .select()
      .from(items)
      .where(this.tenantWhere(id, tenantId))
      .get();
    if (!row) return null;
    if (row.state === "trashed") return null;
    return rowToItem(row);
  }

  // Internal get that includes trashed items (for restore, delete, transition)
  private getRaw(id: string, tenantId?: string): Item | null {
    const row = this.db
      .select()
      .from(items)
      .where(this.tenantWhere(id, tenantId))
      .get();
    if (!row) return null;
    return rowToItem(row);
  }

  async list(filters: ItemFilters): Promise<PaginatedResult<Item>> {
    const sortField = filters.sort ?? "created_at";
    const dir = filters.direction ?? "desc";
    const limit = Math.min(filters.limit ?? 50, 200);

    const conditions = [];

    if (filters.tenantId)
      conditions.push(eq(items.tenant_id, filters.tenantId));

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

    if (filters.source) conditions.push(eq(items.source, filters.source));
    if (filters.parent_id)
      conditions.push(eq(items.parent_id, filters.parent_id));
    if (filters.thread_id)
      conditions.push(eq(items.thread_id, filters.thread_id));

    // root_only: only items with no parent
    if (filters.root_only) {
      conditions.push(sql`${items.parent_id} IS NULL`);
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

    // Fix 6: tags filter — items must have ALL specified tags
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
      const filterConds = filterToSqlConditions(expr, "sqlite", items);
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

    const rows = this.db
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
    // Pre-fetch ancestor outside transaction so we can await the async store method
    const ancestor =
      input.version !== undefined
        ? await this.versionStore.getByVersion(id, input.version)
        : null;

    const whereClause = this.tenantWhere(id, tenantId);

    const updateFn = this.raw.transaction(() => {
      const row = this.db.select().from(items).where(whereClause).get();
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
      const deviceId = row.device_id ?? undefined;

      // Fast path: version omitted — always merge, no conflict detection
      if (input.version === undefined || row.version === input.version) {
        const latestTs = this.versionStore.getLatestTimestampSync(id);
        if (
          shouldCreateVersion(
            latestTs,
            this.versionSnapshotIntervalMs,
            false,
            input.snapshot === true,
          )
        ) {
          this.versionStore
            .create(id, row.version, currentProps, deviceId)
            .catch((e: unknown) => {
              console.error("Version create failed:", e);
            });
        }

        const merged = input.properties
          ? { ...currentProps, ...input.properties }
          : currentProps;
        const newVersion = row.version + 1;

        const setClause: Record<string, unknown> = {
          properties: JSON.stringify(merged),
          version: newVersion,
          updated_at: now,
        };
        if (input.parent_id !== undefined) {
          setClause.parent_id = input.parent_id;
        }
        if (input.thread_id !== undefined) {
          setClause.thread_id = input.thread_id;
        }

        this.db.update(items).set(setClause).where(whereClause).run();

        this.searchStore.remove(id).catch((e: unknown) => {
          console.error("Search remove failed:", e);
        });
        this.searchStore.index(id, merged).catch((e: unknown) => {
          console.error("Search index failed:", e);
        });

        return rowToItem({
          ...row,
          properties: JSON.stringify(merged),
          version: newVersion,
          updated_at: now,
          ...(input.parent_id !== undefined && {
            parent_id: input.parent_id,
          }),
          ...(input.thread_id !== undefined && {
            thread_id: input.thread_id,
          }),
        });
      }

      // Fix 5: any version < current is a conflict, not necessarily invalid
      if (!ancestor) {
        // Version doesn't exist in history — still a conflict scenario
        // (client has a version we've never seen, or version 0 meaning "never seen")
        return {
          error: { code: "version_conflict" as const, status: 409 as const },
          current: { version: row.version, properties: currentProps },
          ancestor: { version: input.version, properties: {} },
          conflicting_fields: Object.keys(input.properties ?? {}),
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
          ancestor: { version: input.version, properties: ancestor.properties },
          conflicting_fields: result.conflicting_fields,
        } satisfies ConflictResponse;
      }

      // Auto-merge
      const mergeLatestTs = this.versionStore.getLatestTimestampSync(id);
      if (
        shouldCreateVersion(
          mergeLatestTs,
          this.versionSnapshotIntervalMs,
          false,
          input.snapshot === true,
        )
      ) {
        this.versionStore
          .create(id, row.version, currentProps, deviceId)
          .catch((e: unknown) => {
            console.error("Version create failed:", e);
          });
      }
      const newVersion = row.version + 1;

      const mergeSet: Record<string, unknown> = {
        properties: JSON.stringify(result.merged),
        version: newVersion,
        updated_at: now,
      };
      if (input.parent_id !== undefined) {
        mergeSet.parent_id = input.parent_id;
      }
      if (input.thread_id !== undefined) {
        mergeSet.thread_id = input.thread_id;
      }

      this.db.update(items).set(mergeSet).where(whereClause).run();

      this.searchStore.remove(id).catch((e: unknown) => {
        console.error("Search remove failed:", e);
      });
      this.searchStore.index(id, result.merged).catch((e: unknown) => {
        console.error("Search index failed:", e);
      });

      return rowToItem({
        ...row,
        properties: JSON.stringify(result.merged),
        version: newVersion,
        updated_at: now,
        ...(input.parent_id !== undefined && {
          parent_id: input.parent_id,
        }),
        ...(input.thread_id !== undefined && {
          thread_id: input.thread_id,
        }),
      });
    });

    return updateFn();
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    const row = this.getRaw(id, tenantId);
    if (!row) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    this.db
      .update(items)
      .set({ state: "trashed", updated_at: new Date().toISOString() })
      .where(this.tenantWhere(id, tenantId))
      .run();

    this.searchStore.remove(id).catch((e: unknown) => {
      console.error("Search remove failed:", e);
    });
  }

  async purge(id: string, tenantId?: string): Promise<void> {
    const row = this.getRaw(id, tenantId);
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
    this.db.delete(items).where(this.tenantWhere(id, tenantId)).run();

    this.searchStore.remove(id).catch((e: unknown) => {
      console.error("Search remove failed:", e);
    });
  }

  async restore(id: string, tenantId?: string): Promise<Item> {
    const row = this.getRaw(id, tenantId);
    if (!row) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    if (row.state !== "trashed") {
      throw new MymeError(ErrorCode.INVALID_TRANSITION, "Item is not trashed");
    }

    const now = new Date().toISOString();
    this.db
      .update(items)
      .set({ state: "active", updated_at: now })
      .where(this.tenantWhere(id, tenantId))
      .run();

    this.searchStore.index(id, row.properties).catch((e: unknown) => {
      console.error("Search index failed:", e);
    });

    return { ...row, state: "active" as ItemState, updated_at: now };
  }

  async transition(
    id: string,
    state: ItemState,
    tenantId?: string,
  ): Promise<Item> {
    const row = this.getRaw(id, tenantId);
    if (!row) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const error = validateTransition(row.type, row.state, state);
    if (error) {
      throw new MymeError(ErrorCode.INVALID_TRANSITION, error);
    }

    // State transitions always create a version snapshot
    this.versionStore
      .create(id, row.version, row.properties, row.device_id ?? undefined)
      .catch((e: unknown) => {
        console.error("Version create failed:", e);
      });

    const now = new Date().toISOString();
    this.db
      .update(items)
      .set({ state, updated_at: now })
      .where(this.tenantWhere(id, tenantId))
      .run();

    if (state === "trashed") {
      this.searchStore.remove(id).catch((e: unknown) => {
        console.error("Search remove failed:", e);
      });
    } else if (row.state === "trashed") {
      this.searchStore.index(id, row.properties).catch((e: unknown) => {
        console.error("Search index failed:", e);
      });
    }

    return { ...row, state, updated_at: now };
  }

  stats(
    tenantId?: string,
    allowedTypes?: string[],
  ): Promise<Record<string, number>> {
    let sql = "SELECT state, COUNT(*) as count FROM items WHERE 1=1";
    const params: unknown[] = [];

    if (tenantId) {
      sql += " AND tenant_id = ?";
      params.push(tenantId);
    }

    if (allowedTypes && allowedTypes.length > 0) {
      sql += ` AND type IN (${allowedTypes.map(() => "?").join(", ")})`;
      params.push(...allowedTypes);
    }

    sql += " GROUP BY state";

    const rows = this.raw.prepare(sql).all(...params) as {
      state: string;
      count: number;
    }[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.state] = row.count;
    }
    return Promise.resolve(result);
  }
}
