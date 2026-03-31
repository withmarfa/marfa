import { eq, ne, and, or, lt, gt, desc, asc, like, sql } from "drizzle-orm";
import {
  generateId,
  isValidId,
  getTypeSchema,
  validateProperties,
  validateTransition,
  ProtocolError,
  ErrorCode,
} from "@myme/shared";
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
  ) {}

  create(input: CreateItemInput): Item {
    const id = input.id ?? generateId();
    if (input.id && !isValidId(input.id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const typeSchema = getTypeSchema(input.type);
    if (!typeSchema) {
      throw new ProtocolError(
        ErrorCode.TYPE_NOT_FOUND,
        `Unknown type: ${input.type}`,
      );
    }

    const validation = validateProperties(input.type, input.properties);
    if (!validation.success) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid properties", {
        errors: validation.errors,
      });
    }

    const now = new Date().toISOString();
    const state = input.state ?? typeSchema.default_state;

    const createFn = this.raw.transaction(() => {
      if (input.source && input.source_id) {
        const existing = this.db
          .select({ id: items.id })
          .from(items)
          .where(and(eq(items.source, input.source), eq(items.source_id, input.source_id)))
          .get();
        if (existing) {
          throw new ProtocolError(
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
          .where(eq(items.id, input.parent_id))
          .get();
        if (!parent) {
          throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Parent item not found");
        }
      }

      if (input.thread_id) {
        const thread = this.db
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, input.thread_id))
          .get();
        if (!thread) {
          throw new ProtocolError(ErrorCode.THREAD_NOT_FOUND, "Thread not found");
        }
      }

      this.db
        .insert(items)
        .values({
          id,
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

      this.searchStore.index(id, input.properties);

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
        ...(input.parent_id != null && { parent_id: input.parent_id }),
        ...(input.thread_id != null && { thread_id: input.thread_id }),
        ...(input.capture_latitude != null && { capture_latitude: input.capture_latitude }),
        ...(input.capture_longitude != null && { capture_longitude: input.capture_longitude }),
      } satisfies Item;
    });

    return createFn();
  }

  // Fix 4: trashed items return null (404 to callers)
  get(id: string): Item | null {
    const row = this.db.select().from(items).where(eq(items.id, id)).get();
    if (!row) return null;
    if (row.state === "trashed") return null;
    return rowToItem(row);
  }

  // Internal get that includes trashed items (for restore, delete, transition)
  private getRaw(id: string): Item | null {
    const row = this.db.select().from(items).where(eq(items.id, id)).get();
    if (!row) return null;
    return rowToItem(row);
  }

  list(filters: ItemFilters): PaginatedResult<Item> {
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

    if (filters.source) conditions.push(eq(items.source, filters.source));
    if (filters.parent_id) conditions.push(eq(items.parent_id, filters.parent_id));
    if (filters.thread_id) conditions.push(eq(items.thread_id, filters.thread_id));

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

  update(id: string, input: UpdateItemInput): Item | ConflictResponse {
    const updateFn = this.raw.transaction(() => {
      const row = this.db.select().from(items).where(eq(items.id, id)).get();
      if (!row) {
        throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
      }
      if (row.state === "trashed") {
        throw new ProtocolError(ErrorCode.INVALID_TRANSITION, "Cannot update trashed item");
      }

      const currentProps = JSON.parse(row.properties) as Record<string, unknown>;
      const now = new Date().toISOString();
      const deviceId = row.device_id ?? undefined;

      // Fast path: versions match
      if (row.version === input.version) {
        // Fix 7: include device_id in version snapshot
        this.versionStore.create(id, row.version, currentProps, deviceId);

        const merged = { ...currentProps, ...input.properties };
        const newVersion = row.version + 1;

        this.db
          .update(items)
          .set({
            properties: JSON.stringify(merged),
            version: newVersion,
            updated_at: now,
          })
          .where(eq(items.id, id))
          .run();

        this.searchStore.remove(id);
        this.searchStore.index(id, merged);

        return rowToItem({
          ...row,
          properties: JSON.stringify(merged),
          version: newVersion,
          updated_at: now,
        });
      }

      // Fix 5: any version < current is a conflict, not necessarily invalid
      const ancestor = this.versionStore.getByVersion(id, input.version);
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
      this.versionStore.create(id, row.version, currentProps, deviceId);
      const newVersion = row.version + 1;

      this.db
        .update(items)
        .set({
          properties: JSON.stringify(result.merged),
          version: newVersion,
          updated_at: now,
        })
        .where(eq(items.id, id))
        .run();

      this.searchStore.remove(id);
      this.searchStore.index(id, result.merged);

      return rowToItem({
        ...row,
        properties: JSON.stringify(result.merged),
        version: newVersion,
        updated_at: now,
      });
    });

    return updateFn();
  }

  delete(id: string): void {
    const row = this.getRaw(id);
    if (!row) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    this.db
      .update(items)
      .set({ state: "trashed", updated_at: new Date().toISOString() })
      .where(eq(items.id, id))
      .run();

    this.searchStore.remove(id);
  }

  restore(id: string): Item {
    const row = this.getRaw(id);
    if (!row) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    if (row.state !== "trashed") {
      throw new ProtocolError(ErrorCode.INVALID_TRANSITION, "Item is not trashed");
    }

    const now = new Date().toISOString();
    this.db
      .update(items)
      .set({ state: "active", updated_at: now })
      .where(eq(items.id, id))
      .run();

    this.searchStore.index(id, row.properties);

    return { ...row, state: "active" as ItemState, updated_at: now };
  }

  transition(id: string, state: ItemState): Item {
    const row = this.getRaw(id);
    if (!row) {
      throw new ProtocolError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const error = validateTransition(row.type, row.state, state);
    if (error) {
      throw new ProtocolError(ErrorCode.INVALID_TRANSITION, error);
    }

    const now = new Date().toISOString();
    this.db
      .update(items)
      .set({ state, updated_at: now })
      .where(eq(items.id, id))
      .run();

    if (state === "trashed") {
      this.searchStore.remove(id);
    } else if (row.state === "trashed") {
      this.searchStore.index(id, row.properties);
    }

    return { ...row, state, updated_at: now };
  }
}
