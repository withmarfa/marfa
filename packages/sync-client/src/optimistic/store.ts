/**
 * `OptimisticItemStore` — the in-memory delta layer that holds
 * client-issued items writes until Electric streams the canonical
 * server-confirmed row back into PGlite.
 *
 * Why this exists: pre-fix, optimistic creates were written directly
 * into the PGlite `items` table. When Electric replicated the same
 * row back, `@electric-sql/pglite-sync`'s plain INSERT collided with
 * the optimistic row on the primary key (`23505 items_pkey`). The
 * collision aborted the engine. The architectural fix is the writer
 * split that local-first systems standardise on: optimistic state
 * lives in memory, PGlite is written exclusively by `pglite-sync`,
 * reads merge the two layers.
 *
 * This is the v0.1 minimal version — items only. Edges and metadata
 * still write directly to PGlite via `api/edges.ts` and
 * `api/metadata.ts`; v0.2 will extend the same pattern there. See
 * `CHANGELOG.md` for the precise list of operations still subject to
 * the round-trip collision.
 */

import type { Item } from "@mymehq/shared";

/**
 * The in-memory representation of an optimistic apply. Two flavours:
 *   - `apply` — an item the client has staged that Electric has not
 *     yet replicated. Reads merge this on top of PGlite.
 *   - `tombstone` — the client has staged a delete; reads should
 *     return null for this id even if PGlite still holds the row.
 */
export interface OptimisticApply {
  kind: "apply";
  item: Item;
  /**
   * The local id passed to the queue's `target_id`. Used by the
   * reconciler to find the apply when the server confirms the
   * matching mutation, and by rollback to drop the apply on 4xx.
   */
  targetId: string;
}

export interface OptimisticTombstone {
  kind: "tombstone";
  targetId: string;
}

export type OptimisticEntry = OptimisticApply | OptimisticTombstone;

export type OptimisticChangeListener = (id: string) => void;

export class OptimisticItemStore {
  private readonly entries = new Map<string, OptimisticEntry>();
  private readonly listeners = new Set<OptimisticChangeListener>();

  /**
   * Stage an item write. Replaces any existing entry for the same id
   * (an update on top of an unconfirmed create — fine, the queue
   * already preserves the FIFO order of mutations).
   */
  applyItem(item: Item): void {
    this.entries.set(item.id, { kind: "apply", item, targetId: item.id });
    this.emit(item.id);
  }

  /**
   * Stage a delete. The id reads as null until the canonical row
   * disappears from PGlite (server-confirmed delete) or the
   * tombstone is rolled back (server-rejected delete). The hold of
   * the prior `apply` is replaced — there's only ever one entry per
   * id at a time.
   */
  applyTombstone(id: string): void {
    this.entries.set(id, { kind: "tombstone", targetId: id });
    this.emit(id);
  }

  /**
   * Drop the optimistic entry for an id. Called when:
   *   - The reconciler observes the canonical row landing in PGlite
   *     (server confirmed via Electric).
   *   - The drain reports `mutation.rejected` for a write targeting
   *     this id (rollback path).
   */
  clear(id: string): void {
    if (this.entries.delete(id)) this.emit(id);
  }

  /** Drop everything — used by `client.stop()`. */
  clearAll(): void {
    const ids = Array.from(this.entries.keys());
    this.entries.clear();
    for (const id of ids) this.emit(id);
  }

  /**
   * Read merge for `items.get(id)`:
   *   - `apply`     → the optimistic item.
   *   - `tombstone` → `null` (the row is being deleted).
   *   - no entry    → `undefined` (caller falls through to PGlite).
   */
  get(id: string): Item | null | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return entry.kind === "apply" ? entry.item : null;
  }

  /**
   * Overlay the optimistic delta onto a list of canonical rows. The
   * caller has already filtered + sorted PGlite rows; we splice in
   * the optimistic state and re-apply the contract:
   *   - Tombstoned ids are dropped.
   *   - Optimistic-applied rows replace any PGlite row with the same
   *     id.
   *   - Optimistic-applied rows that aren't in the PGlite list (new
   *     creates whose Electric replay hasn't landed yet) are
   *     appended.
   *
   * Filter and sort are reapplied by the caller after this overlay
   * — the OptimisticItemStore doesn't know what query it's
   * supporting.
   */
  overlay(canonical: Item[]): Item[] {
    if (this.entries.size === 0) return canonical;
    const result: Item[] = [];
    const seen = new Set<string>();
    for (const row of canonical) {
      const entry = this.entries.get(row.id);
      if (!entry) {
        result.push(row);
        continue;
      }
      if (entry.kind === "apply") {
        result.push(entry.item);
      }
      // tombstone: drop
      seen.add(row.id);
    }
    // Append optimistic-only ids (creates not yet confirmed).
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      if (entry.kind === "apply") {
        result.push(entry.item);
      }
    }
    return result;
  }

  /** Subscribe to per-id change notifications. Returns unsubscribe. */
  subscribe(listener: OptimisticChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot the entries for diagnostics + tests. */
  snapshot(): ReadonlyMap<string, OptimisticEntry> {
    return new Map(this.entries);
  }

  private emit(id: string): void {
    for (const listener of this.listeners) {
      try {
        listener(id);
      } catch {
        // listeners must not break the emitter
      }
    }
  }
}
