import { eq, ne, and, or, lt, gt, desc, asc, like, sql } from "drizzle-orm";
import {
  generateId,
  isValidId,
  getTypeSchema,
  validateProperties,
  validateTransition,
  parseFilter,
  ProtocolError,
  ErrorCode,
} from "@myme/shared";
import { filterToSqlConditions } from "../filter-sql.js";
import type {
  Item,
  CreateItemInput,
  UpdateItemInput,
  ConflictResponse,
  ItemState,
  PaginatedResult,
} from "@myme/shared";
import type { ItemStore, ItemFilters } from "../interface.js";
import { encodeCursor, decodeCursor } from "../interface.js";
import { detectConflict } from "../conflict.js";
import { items, metadata, threads } from "./schema.js";
import type { PgDb } from "./connection.js";
import type { PgVersionStore } from "./version-store.js";
import type { PgSearchStore } from "./search-store.js";
import { rowToItem } from "./helpers.js";

export class PgItemStore implements ItemStore {
  constructor(
    private db: PgDb,
    private versionStore: PgVersionStore,
    private searchStore: PgSearchStore,
  ) {}

  private tenantWhere(id: string, tenantId?: string) {
    return tenantId ? and(eq(items.id, id), eq(items.tenant_id, tenantId)) : eq(items.id, id);
  }

  async create(input: CreateItemInput, tenantId?: string): Promise<Item> {
    const id = input.id ?? generateId();
    if (input.id && !isValidId(input.id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    // Validate properties against type schema if registered; accept unknown types
    const typeSchema = getTypeSchema(input.type);
    if (typeSchema) {
      const validation = validateProperties(input.type, input.properties);
      if (!validation.success) {
        throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid properties", {
          errors: validation.errors,
        });
      }
    }

    const now = new Date().toISOString();
    const state = input.state ?? typeSchema?.default_state ?? "new";

    return await this.db.transaction(async (tx) => {
      if (input.source && input.source_id) {
        const dedupConditions = [eq(items.source, input.source), eq(items.source_id, input.source_id)];
        if (tenantId) dedupConditions.push(eq(items.tenant_id, tenantId));
        const [existing] = await tx
          .select({ id: items.id })
          .from(items)
          .where(and(...dedupConditions));
        if (existing) {
          throw new ProtocolError(
            ErrorCode.DUPLICATE_SOURCE,
            `Item with source=${input.source} source_id=${input.source_id} already exists`,
            { existing_id: existing.id },
          );
        }
      }

      if (input.parent_id) {
        const [parent] = await tx
          .select({ id: items.id })
          .from(items)
          .where(eq(items.id, input.parent_id));
        if (!parent) {
          throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Parent item not found");
        }
      }

      if (input.thread_id) {
        const [thread] = await tx
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, input.thread_id));
        if (!thread) {
          throw new ProtocolError(ErrorCode.THREAD_NOT_FOUND, "Thread not found");
        }
      }

      await tx.insert(items).values({
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
      });

      await tx.insert(metadata).values({
        item_id: id,
        tags: JSON.stringify(input.tags ?? []),
        about: JSON.stringify(input.about ?? []),
      });

      await this.searchStore.index(id, input.properties);

      if (input.thread_id) {
        await tx
          .update(threads)
          .set({ updated_at: now })
          .where(eq(threads.id, input.thread_id));
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
        ...(input.parent_id != null && { parent_id: input.parent_id }),
        ...(input.thread_id != null && { thread_id: input.thread_id }),
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
        conditions.push(eq(items.type, filters.type));
      }
    }

    if (filters.tenantId) conditions.push(eq(items.tenant_id, filters.tenantId));
    if (filters.source) conditions.push(eq(items.source, filters.source));
    if (filters.parent_id) conditions.push(eq(items.parent_id, filters.parent_id));
    if (filters.thread_id) conditions.push(eq(items.thread_id, filters.thread_id));

    // Tags filter — items must have ALL specified tags (Postgres jsonb containment)
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        conditions.push(
          sql`EXISTS (
            SELECT 1 FROM metadata m
            WHERE m.item_id = ${items.id}
              AND m.tags::jsonb @> ${JSON.stringify(tag)}::jsonb
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
      const filterConds = filterToSqlConditions(expr, "pg", items);
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
        const clause = or(lt(sortCol, v), and(eq(sortCol, v), lt(items.id, id)));
        if (clause) conditions.push(clause);
      } else {
        const clause = or(gt(sortCol, v), and(eq(sortCol, v), gt(items.id, id)));
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
      dir === "desc" ? [desc(sortCol), desc(items.id)] : [asc(sortCol), asc(items.id)];

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
        throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
      }
      if (row.state === "trashed") {
        throw new ProtocolError(
          ErrorCode.INVALID_TRANSITION,
          "Cannot update trashed item",
        );
      }

      const currentProps = JSON.parse(row.properties) as Record<string, unknown>;
      const now = new Date().toISOString();
      const deviceId = row.device_id ?? undefined;

      // Fast path: version omitted — always merge, no conflict detection
      if (input.version === undefined || row.version === input.version) {
        await this.versionStore.create(id, row.version, currentProps, deviceId, tx);

        const merged = { ...currentProps, ...input.properties };
        const newVersion = row.version + 1;

        await tx
          .update(items)
          .set({
            properties: JSON.stringify(merged),
            version: newVersion,
            updated_at: now,
          })
          .where(this.tenantWhere(id, tenantId));

        await this.searchStore.remove(id);
        await this.searchStore.index(id, merged);

        return rowToItem({
          ...row,
          properties: JSON.stringify(merged),
          version: newVersion,
          updated_at: now,
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
        } satisfies ConflictResponse;
      }

      // Auto-merge
      await this.versionStore.create(id, row.version, currentProps, deviceId, tx);
      const newVersion = row.version + 1;

      await tx
        .update(items)
        .set({
          properties: JSON.stringify(result.merged),
          version: newVersion,
          updated_at: now,
        })
        .where(this.tenantWhere(id, tenantId));

      await this.searchStore.remove(id);
      await this.searchStore.index(id, result.merged);

      return rowToItem({
        ...row,
        properties: JSON.stringify(result.merged),
        version: newVersion,
        updated_at: now,
      });
    });
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    await this.db
      .update(items)
      .set({ state: "trashed", updated_at: new Date().toISOString() })
      .where(this.tenantWhere(id, tenantId));

    await this.searchStore.remove(id);
  }

  async restore(id: string, tenantId?: string): Promise<Item> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    if (row.state !== "trashed") {
      throw new ProtocolError(
        ErrorCode.INVALID_TRANSITION,
        "Item is not trashed",
      );
    }

    const now = new Date().toISOString();
    await this.db
      .update(items)
      .set({ state: "active", updated_at: now })
      .where(this.tenantWhere(id, tenantId));

    await this.searchStore.index(id, row.properties);

    return { ...row, state: "active" as ItemState, updated_at: now };
  }

  async transition(id: string, state: ItemState, tenantId?: string): Promise<Item> {
    const row = await this.getRaw(id, tenantId);
    if (!row) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const error = validateTransition(row.type, row.state, state);
    if (error) {
      throw new ProtocolError(ErrorCode.INVALID_TRANSITION, error);
    }

    const now = new Date().toISOString();
    await this.db
      .update(items)
      .set({ state, updated_at: now })
      .where(this.tenantWhere(id, tenantId));

    if (state === "trashed") {
      await this.searchStore.remove(id);
    } else if (row.state === "trashed") {
      await this.searchStore.index(id, row.properties);
    }

    return { ...row, state, updated_at: now };
  }
}
