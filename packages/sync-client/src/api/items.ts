/**
 * Items API namespace. Mirrors `@mymehq/sdk`'s items namespace, with
 * the local-first reshaping:
 *
 *   - **Reads** (`get`, `list`) merge the optimistic in-memory store
 *     on top of PGlite (the canonical, Electric-replicated layer).
 *   - **Writes** (`create`, `update`, `delete`, `restore`, `transition`,
 *     `purge`) stage in the optimistic store and enqueue for the
 *     drain loop. They never touch PGlite directly — that's reserved
 *     for `@electric-sql/pglite-sync`. When the server confirms the
 *     write and Electric replicates the canonical row, the
 *     reconciler clears the optimistic delta. On 4xx the rollback
 *     path drops the optimistic delta.
 *
 * This split is the v0.1 fix for Bug 2 (optimistic-write PK
 * collision). Edges + metadata writes still hit PGlite directly and
 * have the same latent bug for replicate-back operations; v0.2 will
 * extend the OptimisticItemStore pattern there. See
 * `CHANGELOG.md` for the precise list of operations still affected.
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
import type { OptimisticItemStore } from "../optimistic/store.js";

export interface ItemsApiOptions {
  pg: PGliteWithSync;
  queue: MutationQueue;
  drain: DrainLoop;
  emitter: SyncEventEmitter;
  optimistic: OptimisticItemStore;
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

  // ── reads (PGlite + optimistic overlay) ────────────────────────────

  async get(id: string): Promise<Item | null> {
    // Optimistic store wins — it represents the user's intent that
    // hasn't yet been confirmed by the server. `undefined` means the
    // store has no opinion; fall through to PGlite.
    const optimistic = this.options.optimistic.get(id);
    if (optimistic !== undefined) return optimistic;
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
    const canonical = result.rows.map(rowToItem);

    // Overlay optimistic state on top of the canonical rows. The
    // overlay drops tombstoned ids, replaces matching applies, and
    // appends optimistic-only rows. Filters are then re-applied so
    // the optimistic apply respects the same predicate (e.g., a
    // staged item with `type = 'core.note'` shows up under
    // `list({ type: 'core.note' })` even before Electric replays).
    const merged = this.options.optimistic.overlay(canonical);
    const filtered = merged.filter((item) => matchesFilters(item, filters));
    // Re-sort + re-limit. `updated_at` desc is the canonical order
    // for both PGlite and optimistic (the optimistic apply stamps
    // `updated_at = now()` on every mutation).
    filtered.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return filtered.slice(0, limit);
  }

  // ── writes (optimistic in-memory + enqueue) ────────────────────────

  /**
   * Optimistically create an item. Returns the local representation
   * with a client-generated UUIDv7 id. The mutation is queued; on
   * server confirmation, Electric replicates the canonical row back
   * to PGlite and the reconciler clears the optimistic delta. On
   * 4xx, the client's `mutation.rejected` handler clears the delta
   * (rollback).
   *
   * **Important:** the row is NOT written to PGlite. PGlite is
   * exclusively written by `@electric-sql/pglite-sync`. This is the
   * key invariant that resolves Bug 2.
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

    this.options.optimistic.applyItem(item);

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
    this.options.optimistic.applyItem(merged);

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
    // Optimistic tombstone; the item disappears from local reads
    // immediately. Electric eventually replicates `state = 'trashed'`
    // (the items shape filter excludes trashed rows), so the
    // canonical row drops out of PGlite, and the reconciler clears
    // the tombstone.
    this.options.optimistic.applyTombstone(id);
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
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(
        `restore: item ${id} is not present in the local store.`,
      );
    }
    const restored: Item = {
      ...existing,
      state: "active",
      updated_at: new Date().toISOString(),
    };
    this.options.optimistic.applyItem(restored);
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
    return restored;
  }

  async transition(id: string, state: ItemState): Promise<Item> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(
        `transition: item ${id} is not present in the local store.`,
      );
    }
    const transitioned: Item = {
      ...existing,
      state,
      updated_at: new Date().toISOString(),
    };
    if (state === "trashed") {
      this.options.optimistic.applyTombstone(id);
    } else {
      this.options.optimistic.applyItem(transitioned);
    }
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
    return transitioned;
  }

  async purge(id: string): Promise<void> {
    // Purge is a hard-delete on the server. Tombstone locally so the
    // row reads as gone immediately; the canonical row will
    // disappear from PGlite when Electric stops replicating it.
    this.options.optimistic.applyTombstone(id);
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

function matchesFilters(item: Item, filters: ListFilters): boolean {
  // Replicates the SQL WHERE clause in JS so the optimistic overlay
  // respects the same predicate. Default `state != 'trashed'`
  // applies when no explicit state filter is set.
  if (filters.state !== undefined) {
    if (item.state !== filters.state) return false;
  } else if (item.state === "trashed") {
    return false;
  }
  if (filters.type !== undefined && item.type !== filters.type) return false;
  if (filters.source !== undefined && item.source !== filters.source) {
    return false;
  }
  if (filters.library !== undefined && item.library !== filters.library) {
    return false;
  }
  return true;
}
