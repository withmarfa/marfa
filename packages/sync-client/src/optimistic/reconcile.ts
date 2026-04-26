/**
 * `OptimisticReconciler` — closes the loop between the
 * `OptimisticItemStore` and PGlite.
 *
 * When the queue drains and the server confirms a write, Electric
 * replays the canonical row down the items shape. `pglite-sync`
 * inserts (or updates) the row in the local PGlite. The reconciler
 * watches for that landing and drops the matching optimistic delta
 * — the apply's contribution to read-merge is no longer needed
 * because the canonical row is now visible.
 *
 * Version comparison is the load-bearing piece. A user can update
 * the same item between the canonical-create's land and the
 * optimistic-update's drain: at that instant the optimistic entry
 * holds version v=2 while PGlite still holds v=1. Clearing on
 * "row exists" alone would lose the v=2 staging. The reconciler
 * therefore only clears when PGlite's version >= the optimistic
 * version (for applies) or the row is absent / trashed (for
 * tombstones).
 *
 * v0.1 implementation runs the reconcile pass on every items-table
 * change. The optimistic store is small (≤ a few dozen entries in
 * normal use) and PGlite live queries fire deltas in batches, so
 * the cost is bounded. A future optimization could subscribe per-id
 * if the working set grows.
 */

import type { Item, ItemState } from "@mymehq/shared";
import type { PGliteWithSync } from "../storage/pglite.js";
import type { OptimisticItemStore } from "./store.js";

interface ReconcileRow {
  id: string;
  version: number;
  state: ItemState;
}

export class OptimisticReconciler {
  private subscription: { unsubscribe: () => Promise<void> } | null = null;
  private started = false;

  constructor(
    private readonly pg: PGliteWithSync,
    private readonly store: OptimisticItemStore,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Sentinel live query — fires on every items-table change. The
    // result set is incidental; we just need the change signal.
    const result = await this.pg.live.query<{ id: string }>(
      `SELECT id FROM items LIMIT 1`,
      [],
      () => {
        void this.reconcile();
      },
    );
    this.subscription = result;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.subscription) {
      await this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  /**
   * Drive a reconcile pass manually. Used by the public client when
   * `mutation.confirmed` fires — the queue knows the server-side
   * persist completed, so we can pre-empt the live query and clear
   * faster.
   */
  async reconcile(): Promise<void> {
    const snapshot = this.store.snapshot();
    if (snapshot.size === 0) return;
    const ids = Array.from(snapshot.keys());
    const canonical = await this.fetchCanonical(ids);
    for (const [id, entry] of snapshot) {
      const row = canonical.get(id);
      if (entry.kind === "apply") {
        // Clear when PGlite has caught up to (or past) the optimistic
        // version. Use `>=` so the reconciler is idempotent — if the
        // server applied the update and incremented version twice
        // (rare), the optimistic v=2 delta still drops because v=2
        // is in PGlite.
        if (row && row.version >= entry.item.version) {
          this.store.clear(id);
        }
      } else {
        // Tombstone clears when PGlite has the row in the trashed
        // state or the row has been hard-deleted.
        if (!row || row.state === "trashed") {
          this.store.clear(id);
        }
      }
    }
  }

  private async fetchCanonical(
    ids: string[],
  ): Promise<Map<string, ReconcileRow>> {
    if (ids.length === 0) return new Map();
    const placeholders = ids
      .map((_, i) => `$${String(i + 1)}`)
      .join(", ");
    const result = await this.pg.query<ReconcileRow>(
      `SELECT id, version, state FROM items WHERE id IN (${placeholders})`,
      ids,
    );
    const map = new Map<string, ReconcileRow>();
    for (const row of result.rows) map.set(row.id, row);
    return map;
  }
}

/**
 * Helper exported for the queue replay path: rebuild the optimistic
 * store from the persistent mutation queue at `client.start()`. The
 * queue is durable; the optimistic store is in-memory. Without this
 * replay, an app that restarted with pending mutations would have
 * the queue intact but the optimistic UI state lost — reads would
 * fall back to PGlite (canonical, stale) until drain finished.
 */
export interface QueueRowSnapshot {
  kind: string;
  payload: string;
  target_id: string | null;
}

interface CreateItemPayload {
  input: {
    id?: string;
    type: string;
    state?: ItemState;
    library?: boolean;
    properties: Record<string, unknown>;
    timestamp?: string;
    source?: string;
    source_id?: string;
    origin?: "user" | "ai" | "worker";
    device?: string;
  };
}

interface UpdateItemPayload {
  id: string;
  properties: Record<string, unknown>;
  expectedVersion: number;
  library?: boolean;
  type?: string;
}

interface DeleteItemPayload {
  id: string;
}

interface TransitionItemPayload {
  id: string;
  state: ItemState;
}

export async function rebuildOptimisticStore(
  pg: PGliteWithSync,
  store: OptimisticItemStore,
  defaults: { source: string; defaultOrigin: "user" | "ai" | "worker" },
): Promise<void> {
  const result = await pg.query<QueueRowSnapshot>(
    `SELECT kind, payload, target_id FROM _myme_mutation_queue
      ORDER BY created_at ASC`,
  );

  // Track current optimistic items by id so successive mutations
  // (create followed by update) compose correctly during replay.
  const inflight = new Map<string, Item>();

  for (const row of result.rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    switch (row.kind) {
      case "createItem": {
        const p = parsed as CreateItemPayload;
        const id = p.input.id ?? row.target_id;
        if (!id) continue;
        const now = new Date().toISOString();
        const item: Item = {
          id,
          type: p.input.type,
          state: p.input.state ?? "active",
          library: p.input.library ?? false,
          properties: p.input.properties,
          created_at: now,
          updated_at: now,
          timestamp: p.input.timestamp ?? now,
          source: p.input.source ?? defaults.source,
          source_id: p.input.source_id ?? id,
          origin: p.input.origin ?? defaults.defaultOrigin,
          version: 1,
          schema_version: 1,
        };
        if (p.input.device !== undefined) item.device = p.input.device;
        inflight.set(id, item);
        store.applyItem(item);
        break;
      }
      case "updateItem": {
        const p = parsed as UpdateItemPayload;
        // Resolve the merge target: if a prior queued createItem
        // staged an item, build on that; otherwise read PGlite for
        // the canonical row. If neither exists, drop — the queue is
        // inconsistent and the drain will surface a 404 anyway.
        const prior =
          inflight.get(p.id) ??
          (await readCanonical(pg, p.id));
        if (!prior) continue;
        const merged: Item = {
          ...prior,
          properties: { ...prior.properties, ...p.properties },
          version: p.expectedVersion + 1,
          updated_at: new Date().toISOString(),
          library: p.library ?? prior.library,
        };
        inflight.set(p.id, merged);
        store.applyItem(merged);
        break;
      }
      case "deleteItem": {
        const p = parsed as DeleteItemPayload;
        store.applyTombstone(p.id);
        inflight.delete(p.id);
        break;
      }
      case "restoreItem": {
        const p = parsed as DeleteItemPayload;
        const prior =
          inflight.get(p.id) ??
          (await readCanonical(pg, p.id));
        if (!prior) continue;
        const restored: Item = { ...prior, state: "active" };
        inflight.set(p.id, restored);
        store.applyItem(restored);
        break;
      }
      case "transitionItem": {
        const p = parsed as TransitionItemPayload;
        const prior =
          inflight.get(p.id) ??
          (await readCanonical(pg, p.id));
        if (!prior) continue;
        const transitioned: Item = { ...prior, state: p.state };
        inflight.set(p.id, transitioned);
        if (p.state === "trashed") {
          store.applyTombstone(p.id);
        } else {
          store.applyItem(transitioned);
        }
        break;
      }
      case "purgeItem": {
        const p = parsed as DeleteItemPayload;
        store.applyTombstone(p.id);
        inflight.delete(p.id);
        break;
      }
      default:
        // Edges / metadata / extensions don't yet flow through the
        // optimistic store (v0.2 follow-up).
        break;
    }
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
}

async function readCanonical(
  pg: PGliteWithSync,
  id: string,
): Promise<Item | null> {
  const result = await pg.query<ItemRow>(
    `SELECT * FROM items WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  let properties: Record<string, unknown> = {};
  try {
    properties = JSON.parse(row.properties) as Record<string, unknown>;
  } catch {
    /* defensive */
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
  return item;
}
