/**
 * Writes the timing fields `system.connection` declares.
 *
 * `last_sync_at`, `next_run_at` and `last_error_at` were declared with
 * descriptions and never written by anything, so every consumer rendered a
 * placeholder for a connection that was demonstrably syncing. A type that
 * promises fields the runtime does not populate is worse than one that omits
 * them: it makes consumers write rendering code for data that never arrives.
 *
 * Each stamp is a single shallow-merge update rather than a read-modify-write.
 * Property updates merge shallowly, so sending one key leaves the rest of the
 * connection's properties alone, and the dispatch path pays one statement
 * rather than a round trip plus one.
 *
 * These are best-effort by design. A connection that has just done its work
 * must not have that work reported as a failure because the bookkeeping write
 * afterwards did not land, so a failure here is swallowed and the operator
 * signal stays what it already was: the activity row and the `recent_errors`
 * tail.
 */
import type { Storage } from "../../storage/interface.js";
import { log } from "../../middleware/logger.js";

async function stamp(
  storage: Storage,
  connectionId: string,
  spaceId: string | undefined,
  properties: Record<string, unknown>,
  nullClears: boolean,
): Promise<void> {
  try {
    await storage.items.update(
      connectionId,
      { properties, ...(nullClears ? { null_clears: true } : {}) },
      spaceId,
    );
  } catch (err) {
    log("warn", "Connection timing stamp failed", {
      connection_id: connectionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A run finished successfully. Records when, and clears the error stamp,
 * which the field's own description promises ("cleared on next success").
 * Clearing needs `null_clears`: a shallow merge treats a plain null as
 * "leave unset", so without it the stale timestamp would survive.
 */
export async function stampSyncSuccess(
  storage: Storage,
  connectionId: string,
  spaceId: string | undefined,
  atMs: number,
): Promise<void> {
  await stamp(
    storage,
    connectionId,
    spaceId,
    {
      last_sync_at: new Date(atMs).toISOString(),
      last_error_at: null,
    },
    true,
  );
}

/** A run failed terminally. */
export async function stampSyncFailure(
  storage: Storage,
  connectionId: string,
  spaceId: string | undefined,
  atMs: number,
): Promise<void> {
  await stamp(
    storage,
    connectionId,
    spaceId,
    { last_error_at: new Date(atMs).toISOString() },
    false,
  );
}

/** When this connection is next scheduled to run. */
export async function stampNextRun(
  storage: Storage,
  connectionId: string,
  spaceId: string | undefined,
  nextRunAtMs: number,
): Promise<void> {
  await stamp(
    storage,
    connectionId,
    spaceId,
    { next_run_at: new Date(nextRunAtMs).toISOString() },
    false,
  );
}
