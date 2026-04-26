/**
 * Items API namespace. Mirrors `@mymehq/sdk`'s items namespace, with
 * the local-first reshaping:
 *
 *   - **Reads** (`get`, `list`) come from the local PGlite — synced by
 *     Electric. They never round-trip to the server.
 *   - **Writes** (`create`, `update`, `delete`, `restore`, `transition`,
 *     `purge`) are enqueued for the drain loop. They optimistically
 *     return the local representation; the canonical version arrives
 *     when Electric replicates the server-confirmed row back.
 *   - **Bulk operations** are pass-through to the server. They run
 *     synchronously on the API call (no optimistic local apply) but
 *     the queue still stamps an Idempotency-Key so retries are safe.
 */

import { uuidv7 } from "uuidv7";
import type {
  CreateItemInput,
  Item,
  ItemState,
} from "@mymehq/shared";
import type { PGliteWithSync } from "../storage/pglite.js";
import type { MutationQueue } from "../queue/queue.js";
import type { DrainLoop } from "../queue/drain.js";
import type { SyncEventEmitter } from "../events/emitter.js";

export interface ItemsApiOptions {
  pg: PGliteWithSync;
  queue: MutationQueue;
  drain: DrainLoop;
  emitter: SyncEventEmitter;
  source: string;
  device: string | undefined;
  defaultOrigin: "user" | "ai" | "worker";
}

export interface ListFilters {
  type?: string;
  state?: ItemState;
  source?: string;
  library?: boolean;
  limit?: number;
}

export class ItemsApi {
  constructor(private readonly options: ItemsApiOptions) {}

  // ── reads (PGlite-backed) ──────────────────────────────────────────

  async get(id: string): Promise<Item | null> {
    const result = await this.options.pg.query<ItemRow>(
      `SELECT * FROM items WHERE id = $1 LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    return row ? rowToItem(row) : null;
  }

  async list(filters: ListFilters = {}): Promise<Item[]> {
    const conditions: string[] = ["state != 'trashed'"];
    const params: (string | boolean)[] = [];
    if (filters.type) {
      params.push(filters.type);
      conditions.push(`type = $${String(params.length)}`);
    }
    if (filters.state) {
      params.push(filters.state);
      conditions.push(`state = $${String(params.length)}`);
    }
    if (filters.source) {
      params.push(filters.source);
      conditions.push(`source = $${String(params.length)}`);
    }
    if (filters.library !== undefined) {
      params.push(filters.library);
      conditions.push(`library = $${String(params.length)}`);
    }
    const whereSql = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 5_000));
    const result = await this.options.pg.query<ItemRow>(
      `SELECT * FROM items ${whereSql}
       ORDER BY updated_at DESC
       LIMIT ${String(limit)}`,
      params,
    );
    return result.rows.map(rowToItem);
  }

  // ── writes (optimistic local apply + enqueue) ──────────────────────

  /**
   * Optimistically create an item. Returns the local representation
   * with a client-generated UUIDv7 id. The mutation is queued; on
   * server confirmation, Electric replicates the canonical row back
   * and PGlite's row replaces the optimistic version.
   *
   * For v0.1 the optimistic apply is to the **PGlite items table
   * directly**. A future TanStack DB collection layer will hold
   * optimistic state in memory instead, leaving Electric as the sole
   * writer to the items table; tracking under v0.2 in CHANGELOG.
   */
  async create(
    input: CreateItemInput & { edges?: Record<string, string[]> },
  ): Promise<Item> {
    const id = input.id ?? uuidv7();
    const now = new Date().toISOString();
    const item: Item = {
      id,
      type: input.type,
      state: input.state ?? "active",
      library: input.library ?? false,
      properties: input.properties,
      created_at: now,
      updated_at: now,
      timestamp: input.timestamp ?? now,
      source: input.source ?? this.options.source,
      source_id: input.source_id ?? id,
      origin: input.origin ?? this.options.defaultOrigin,
      version: 1,
      schema_version: 1,
      ...(input.device ?? this.options.device
        ? { device: input.device ?? this.options.device }
        : {}),
    };

    // Optimistic local insert. We use ON CONFLICT to be idempotent in
    // case Electric has already replicated this id (e.g. when the user
    // re-creates an item by sourceId after a hard reload).
    await this.upsertItemLocally(item);

    const writeId = await this.options.queue.enqueue(
      {
        kind: "createItem",
        payload: { input: { ...input, id, source_id: item.source_id } },
      },
      { targetId: id },
    );
    this.options.emitter.emit("mutation.queued", {
      id: writeId,
      kind: "createItem",
      enqueuedAt: new Date(),
    });
    this.options.drain.wake();
    return item;
  }

  async update(
    id: string,
    properties: Record<string, unknown>,
    options: {
      expectedVersion?: number;
      library?: boolean;
      type?: string;
    } = {},
  ): Promise<Item> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(
        `update: item ${id} is not present in the local store. ` +
          `Wait for the initial sync to complete or call client.performInitialSync().`,
      );
    }
    const expectedVersion = options.expectedVersion ?? existing.version;
    const merged: Item = {
      ...existing,
      properties: { ...existing.properties, ...properties },
      version: expectedVersion + 1,
      updated_at: new Date().toISOString(),
      library: options.library ?? existing.library,
    };
    await this.upsertItemLocally(merged);

    const writeId = await this.options.queue.enqueue(
      {
        kind: "updateItem",
        payload: {
          id,
          properties,
          expectedVersion,
          library: options.library,
          type: options.type ?? existing.type,
        },
      },
      { targetId: id },
    );
    this.options.emitter.emit("mutation.queued", {
      id: writeId,
      kind: "updateItem",
      enqueuedAt: new Date(),
    });
    this.options.drain.wake();
    return merged;
  }

  async delete(id: string): Promise<void> {
    // Optimistic: state -> trashed. Electric will replicate the
    // canonical state on confirm.
    await this.options.pg.query(
      `UPDATE items SET state = 'trashed', updated_at = $2 WHERE id = $1`,
      [id, new Date().toISOString()],
    );
    const writeId = await this.options.queue.enqueue(
      { kind: "deleteItem", payload: { id } },
      { targetId: id },
    );
    this.options.emitter.emit("mutation.queued", {
      id: writeId,
      kind: "deleteItem",
      enqueuedAt: new Date(),
    });
    this.options.drain.wake();
  }

  async restore(id: string): Promise<Item> {
    await this.options.pg.query(
      `UPDATE items SET state = 'active', updated_at = $2 WHERE id = $1`,
      [id, new Date().toISOString()],
    );
    const writeId = await this.options.queue.enqueue(
      { kind: "restoreItem", payload: { id } },
      { targetId: id },
    );
    this.options.emitter.emit("mutation.queued", {
      id: writeId,
      kind: "restoreItem",
      enqueuedAt: new Date(),
    });
    this.options.drain.wake();
    const restored = await this.get(id);
    if (!restored) throw new Error(`restore: item ${id} disappeared locally`);
    return restored;
  }

  async transition(id: string, state: ItemState): Promise<Item> {
    await this.options.pg.query(
      `UPDATE items SET state = $2, updated_at = $3 WHERE id = $1`,
      [id, state, new Date().toISOString()],
    );
    const writeId = await this.options.queue.enqueue(
      { kind: "transitionItem", payload: { id, state } },
      { targetId: id },
    );
    this.options.emitter.emit("mutation.queued", {
      id: writeId,
      kind: "transitionItem",
      enqueuedAt: new Date(),
    });
    this.options.drain.wake();
    const updated = await this.get(id);
    if (!updated) throw new Error(`transition: item ${id} disappeared`);
    return updated;
  }

  async purge(id: string): Promise<void> {
    await this.options.pg.query(`DELETE FROM items WHERE id = $1`, [id]);
    const writeId = await this.options.queue.enqueue(
      { kind: "purgeItem", payload: { id } },
      { targetId: id },
    );
    this.options.emitter.emit("mutation.queued", {
      id: writeId,
      kind: "purgeItem",
      enqueuedAt: new Date(),
    });
    this.options.drain.wake();
  }

  private async upsertItemLocally(item: Item): Promise<void> {
    await this.options.pg.query(
      `INSERT INTO items (
         id, type, state, library, properties, created_at, updated_at,
         timestamp, source, source_id, origin, version, device
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         library = EXCLUDED.library,
         properties = EXCLUDED.properties,
         updated_at = EXCLUDED.updated_at,
         timestamp = EXCLUDED.timestamp,
         source = EXCLUDED.source,
         source_id = EXCLUDED.source_id,
         origin = EXCLUDED.origin,
         version = EXCLUDED.version,
         device = EXCLUDED.device`,
      [
        item.id,
        item.type,
        item.state,
        item.library,
        JSON.stringify(item.properties),
        item.created_at,
        item.updated_at,
        item.timestamp,
        item.source,
        item.source_id ?? null,
        item.origin,
        item.version,
        item.device ?? null,
      ],
    );
  }
}

interface ItemRow {
  id: string;
  tenant_id: string | null;
  type: string;
  state: ItemState;
  library: boolean;
  properties: string;
  created_at: string;
  updated_at: string;
  timestamp: string;
  source: string | null;
  source_id: string | null;
  origin: "user" | "ai" | "worker" | null;
  version: number;
  schema_version: number | null;
  device: string | null;
  capture_latitude: number | null;
  capture_longitude: number | null;
}

function rowToItem(row: ItemRow): Item {
  let properties: Record<string, unknown> = {};
  try {
    properties = JSON.parse(row.properties) as Record<string, unknown>;
  } catch {
    // Stay defensive — corrupt rows are surfaced as items with empty
    // properties rather than throwing.
  }
  const item: Item = {
    id: row.id,
    type: row.type,
    state: row.state,
    library: row.library,
    properties,
    created_at: row.created_at,
    updated_at: row.updated_at,
    timestamp: row.timestamp,
    source: row.source ?? "",
    origin: row.origin ?? "user",
    version: row.version,
    schema_version: row.schema_version ?? 1,
  };
  if (row.source_id !== null) item.source_id = row.source_id;
  if (row.device !== null) item.device = row.device;
  if (row.capture_latitude !== null) item.capture_latitude = row.capture_latitude;
  if (row.capture_longitude !== null)
    item.capture_longitude = row.capture_longitude;
  return item;
}
