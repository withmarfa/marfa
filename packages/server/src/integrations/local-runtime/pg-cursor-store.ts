/**
 * Per-Connection state for the runtime, stored in reserved extension
 * namespaces on the `system.connection` item, read and written
 * directly via the storage layer.
 *
 * State is split across two namespaces because the two halves have
 * different writers:
 *
 *   `connection.runtime` — dispatch-owned. Written by the supervisor
 *   while it holds the per-Connection advisory lock.
 *
 *     { cursors: { [key]: unknown },
 *       recent_errors: [{ timestamp_ms, reason }],
 *       next_run_at_ms: number | null }
 *
 *   `connection.runtime.idempotency` — receipt-owned. Written by the
 *   inbound webhook route on the HTTP thread, which takes no lock.
 *
 *     { [delivery_key]: recorded_at_ms }
 *
 * Concurrency: every mutation below goes through
 * `metadata.mutateExtension`, which performs the read / mutate / write
 * inside one row-locked transaction. That is what keeps an unlocked
 * writer (webhook receipt, dead-letter worker) from committing a stale
 * snapshot over a cursor advance the dispatch path just made — the
 * advisory lock alone cannot, because it does not cover the receipt
 * path. The namespace split additionally keeps the two from contending
 * over the same value at all.
 */
import type { Storage } from "../../storage/interface.js";

export interface ConnectionRuntimeState {
  cursors: Record<string, unknown>;
  recent_errors: ConnectionRuntimeError[];
  next_run_at_ms: number | null;
}

export interface ConnectionRuntimeError {
  timestamp_ms: number;
  reason: string;
  attempts?: number;
  message_kind?: string;
}

/** Reserved namespace for dispatch-owned per-Connection runtime state. */
export const CONNECTION_RUNTIME_NAMESPACE = "connection.runtime";

/** Reserved namespace for the inbound-delivery idempotency window. */
export const CONNECTION_IDEMPOTENCY_NAMESPACE =
  "connection.runtime.idempotency";

/** Recent-errors tail size kept on the connection state. */
const RECENT_ERRORS_SIZE = 16;

/**
 * Idempotency cache size — drop the oldest entries past this.
 *
 * The window is a single JSON value that is read and rewritten on
 * every receipt (not one row per delivery), so it needs a size bound
 * as well as a TTL bound. A Connection taking more
 * than this many distinct deliveries inside the TTL evicts its oldest
 * entries early, and a redelivery of an evicted key re-processes; echo
 * suppression and handler-side idempotency are the backstop.
 */
const IDEMPOTENCY_WINDOW_SIZE = 256;

function parseRuntimeState(
  raw: Record<string, unknown>,
): ConnectionRuntimeState {
  return {
    cursors: (raw.cursors as Record<string, unknown> | undefined) ?? {},
    recent_errors:
      (raw.recent_errors as ConnectionRuntimeError[] | undefined) ?? [],
    next_run_at_ms:
      typeof raw.next_run_at_ms === "number" ? raw.next_run_at_ms : null,
  };
}

/**
 * Drop empty collections from the persisted form so an idle Connection's
 * extension stays tidy. The parser supplies the defaults on the way back
 * in, so the round-trip is lossless.
 *
 * Rebuilding the payload from the parsed state also retires the
 * `idempotency` key that older builds nested here before the window
 * moved to its own namespace: the first dispatch after an upgrade drops
 * it. Losing an in-flight dedupe window costs at most one re-processed
 * redelivery, which the receipt path already tolerates.
 */
function serializeRuntimeState(
  state: ConnectionRuntimeState,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (Object.keys(state.cursors).length > 0) payload.cursors = state.cursors;
  if (state.recent_errors.length > 0)
    payload.recent_errors = state.recent_errors;
  if (state.next_run_at_ms !== null)
    payload.next_run_at_ms = state.next_run_at_ms;
  return payload;
}

/**
 * Load the dispatch-owned state blob, supplying defaults for any missing
 * fields so callers can treat the return value as a complete record. A
 * missing `connection.runtime` extension means "no state yet" and the
 * helper returns a fully-zeroed value.
 */
export async function readConnectionRuntimeState(
  storage: Storage,
  connectionId: string,
): Promise<ConnectionRuntimeState> {
  const extensions = await storage.metadata.getExtensions(connectionId);
  return parseRuntimeState(extensions[CONNECTION_RUNTIME_NAMESPACE] ?? {});
}

/** Atomic read / mutate / write against the dispatch-owned namespace. */
async function mutateConnectionRuntimeState(
  storage: Storage,
  connectionId: string,
  mutate: (state: ConnectionRuntimeState) => ConnectionRuntimeState,
): Promise<void> {
  await storage.metadata.mutateExtension(
    connectionId,
    CONNECTION_RUNTIME_NAMESPACE,
    (raw) => serializeRuntimeState(mutate(parseRuntimeState(raw))),
  );
}

/**
 * Apply a cursor delta from one handler dispatch back to the live
 * `connection.runtime` extension. `cursorUpdates` carries written values
 * (last write wins) and `cursorDeletes` carries explicit deletions.
 *
 * Called by the supervisor under the per-Connection advisory lock that
 * gated the dispatch. The flow is:
 *
 *   1. supervisor takes lock on hashtext(connection_id)
 *   2. supervisor reads state, snapshots cursors into the dispatch
 *      request
 *   3. worker runs handler; returns cursor delta
 *   4. supervisor re-reads state inside the mutation, applies the delta,
 *      writes back
 *   5. supervisor releases the lock
 *
 * Step 4 re-reads deliberately — another writer (the dead-letter worker,
 * or an admin operator) might have mutated unrelated fields while the
 * worker ran. The cursor delta is the only thing the handler
 * authoritatively owns; everything else is merged.
 */
export async function applyCursorDelta(
  storage: Storage,
  connectionId: string,
  cursorUpdates: Record<string, unknown>,
  cursorDeletes: string[],
): Promise<void> {
  await mutateConnectionRuntimeState(storage, connectionId, (state) => {
    const cursors = { ...state.cursors };
    for (const [key, value] of Object.entries(cursorUpdates)) {
      cursors[key] = value;
    }
    for (const key of cursorDeletes) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- cursor keys are integration-supplied; deletes use the value-typed Record shape
      delete cursors[key];
    }
    return { ...state, cursors };
  });
}

/**
 * Append a failure entry to the recent-errors tail and trim to the cap.
 * Best-effort — failures here never block the dispatch outcome. Reached
 * both from inside the dispatch lock and from the dead-letter worker,
 * which holds no lock, so the mutation has to be atomic on its own.
 */
export async function recordRuntimeError(
  storage: Storage,
  connectionId: string,
  error: ConnectionRuntimeError,
): Promise<void> {
  await mutateConnectionRuntimeState(storage, connectionId, (state) => ({
    ...state,
    recent_errors: [...state.recent_errors, error].slice(-RECENT_ERRORS_SIZE),
  }));
}

/**
 * Record an idempotency hit for an inbound webhook delivery. Returns
 * `isDuplicate: false` when the delivery is new (caller should enqueue)
 * or `true` when a recent matching delivery is already on file (caller
 * should short-circuit).
 *
 * The window is bounded by `IDEMPOTENCY_WINDOW_SIZE` entries and a
 * caller-supplied TTL in milliseconds; entries older than `now - ttlMs`
 * are evicted on every call so stale delivery keys don't pile up.
 */
export async function checkAndRecordIdempotency(
  storage: Storage,
  connectionId: string,
  deliveryKey: string,
  ttlMs: number,
  now = Date.now(),
): Promise<{ isDuplicate: boolean }> {
  let isDuplicate = false;
  const minAccept = now - ttlMs;
  await storage.metadata.mutateExtension(
    connectionId,
    CONNECTION_IDEMPOTENCY_NAMESPACE,
    (raw) => {
      const window: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== "number" || value < minAccept) continue;
        window[key] = value;
        if (key === deliveryKey) isDuplicate = true;
      }
      if (!isDuplicate) {
        window[deliveryKey] = now;
      }
      // Cap the map at IDEMPOTENCY_WINDOW_SIZE keeping the freshest entries.
      const keys = Object.keys(window);
      if (keys.length <= IDEMPOTENCY_WINDOW_SIZE) return window;
      return Object.fromEntries(
        keys
          .map((k): [string, number] => [k, window[k] ?? 0])
          .sort(([, a], [, b]) => b - a)
          .slice(0, IDEMPOTENCY_WINDOW_SIZE),
      );
    },
  );
  return { isDuplicate };
}
