/**
 * Per-Connection state lives under the existing `connection.runtime`
 * reserved extension namespace on the `system.connection` item. The
 * Cloudflare substrate keeps the same blob inside its per-Connection
 * Durable Object; the local substrate reads / writes the extension
 * directly via the storage layer.
 *
 * Shape (an object keyed inside `connection.runtime`):
 *
 *   {
 *     cursors: { [key: string]: unknown },
 *     idempotency: { [delivery_id: string]: number },
 *     recent_errors: Array<{ timestamp_ms: number; reason: string }>,
 *     next_run_at_ms: number | null,
 *   }
 *
 * Concurrency: the supervisor's PG advisory lock on `hashtext(connection_id)`
 * serialises all writes against a single Connection, so the read /
 * mutate / write cycle below is race-free with respect to other
 * dispatches.
 */
import type { Storage } from "../../storage/interface.js";

export interface ConnectionRuntimeState {
  cursors: Record<string, unknown>;
  idempotency: Record<string, number>;
  recent_errors: ConnectionRuntimeError[];
  next_run_at_ms: number | null;
}

export interface ConnectionRuntimeError {
  timestamp_ms: number;
  reason: string;
  attempts?: number;
  message_kind?: string;
}

/** Reserved namespace for per-Connection runtime state. */
export const CONNECTION_RUNTIME_NAMESPACE = "connection.runtime";

/** Recent-errors tail size kept on the connection state. */
const RECENT_ERRORS_SIZE = 16;

/** Idempotency cache size — drop the oldest entries past this. */
const IDEMPOTENCY_WINDOW_SIZE = 256;

/**
 * Load the per-Connection state blob, supplying defaults for any
 * missing fields so callers can treat the return value as a complete
 * record. A missing `connection.runtime` extension means "no state yet"
 * and the helper returns a fully-zeroed value.
 */
export async function readConnectionRuntimeState(
  storage: Storage,
  connectionId: string,
): Promise<ConnectionRuntimeState> {
  const extensions = await storage.metadata.getExtensions(connectionId);
  const raw = extensions[CONNECTION_RUNTIME_NAMESPACE] ?? {};
  return {
    cursors: (raw.cursors as Record<string, unknown> | undefined) ?? {},
    idempotency: (raw.idempotency as Record<string, number> | undefined) ?? {},
    recent_errors:
      (raw.recent_errors as ConnectionRuntimeError[] | undefined) ?? [],
    next_run_at_ms:
      typeof raw.next_run_at_ms === "number" ? raw.next_run_at_ms : null,
  };
}

/**
 * Persist a fresh state snapshot. Callers should always go through
 * `mutateConnectionRuntimeState` rather than calling this directly —
 * keeping the read / mutate / write triple in one place lets the
 * supervisor's advisory lock cover the whole cycle.
 */
export async function writeConnectionRuntimeState(
  storage: Storage,
  connectionId: string,
  next: ConnectionRuntimeState,
): Promise<void> {
  // Drop empty maps from the persisted form so an idle Connection's
  // extension stays tidy. The reader supplies the defaults on the way
  // back in, so the round-trip is lossless.
  const payload: Record<string, unknown> = {};
  if (Object.keys(next.cursors).length > 0) payload.cursors = next.cursors;
  if (Object.keys(next.idempotency).length > 0)
    payload.idempotency = next.idempotency;
  if (next.recent_errors.length > 0) payload.recent_errors = next.recent_errors;
  if (next.next_run_at_ms !== null)
    payload.next_run_at_ms = next.next_run_at_ms;
  await storage.metadata.setExtension(
    connectionId,
    CONNECTION_RUNTIME_NAMESPACE,
    payload,
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
 *   4. supervisor reads state again (idempotent), applies the delta,
 *      writes back
 *   5. supervisor releases the lock
 *
 * Step 4 reads a second time deliberately — another job (or an admin
 * operator) might have mutated unrelated fields (recent_errors,
 * next_run_at_ms) while the worker ran. The cursor delta is the only
 * thing the handler authoritatively owns; everything else is merged.
 */
export async function applyCursorDelta(
  storage: Storage,
  connectionId: string,
  cursorUpdates: Record<string, unknown>,
  cursorDeletes: string[],
): Promise<void> {
  const state = await readConnectionRuntimeState(storage, connectionId);
  const cursors = { ...state.cursors };
  for (const [key, value] of Object.entries(cursorUpdates)) {
    cursors[key] = value;
  }
  for (const key of cursorDeletes) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- cursor keys are integration-supplied; deletes use the value-typed Record shape
    delete cursors[key];
  }
  await writeConnectionRuntimeState(storage, connectionId, {
    ...state,
    cursors,
  });
}

/**
 * Append a failure entry to the recent-errors tail and trim to the cap.
 * Best-effort — failures here never block the dispatch outcome.
 */
export async function recordRuntimeError(
  storage: Storage,
  connectionId: string,
  error: ConnectionRuntimeError,
): Promise<void> {
  const state = await readConnectionRuntimeState(storage, connectionId);
  const recent_errors = [...state.recent_errors, error].slice(
    -RECENT_ERRORS_SIZE,
  );
  await writeConnectionRuntimeState(storage, connectionId, {
    ...state,
    recent_errors,
  });
}

/**
 * Record an idempotency hit for an inbound webhook delivery. Returns
 * `true` when the delivery is new (caller should enqueue) or `false`
 * when a recent matching delivery is already on file (caller should
 * short-circuit).
 *
 * The window is bounded by `IDEMPOTENCY_WINDOW_SIZE` entries and a
 * caller-supplied TTL in milliseconds; entries older than `now - ttlMs`
 * are evicted on every call so stale subscription ids don't pile up.
 */
export async function checkAndRecordIdempotency(
  storage: Storage,
  connectionId: string,
  deliveryKey: string,
  ttlMs: number,
  now = Date.now(),
): Promise<{ isDuplicate: boolean }> {
  const state = await readConnectionRuntimeState(storage, connectionId);
  const idempotency = { ...state.idempotency };
  const minAccept = now - ttlMs;
  let isDuplicate = false;
  for (const [key, ts] of Object.entries(idempotency)) {
    if (ts < minAccept) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- map keys are subscription-id strings on a value-typed Record
      delete idempotency[key];
      continue;
    }
    if (key === deliveryKey) {
      isDuplicate = true;
    }
  }
  if (!isDuplicate) {
    idempotency[deliveryKey] = now;
  }
  // Cap the map at IDEMPOTENCY_WINDOW_SIZE keeping the freshest entries.
  const keys = Object.keys(idempotency);
  if (keys.length > IDEMPOTENCY_WINDOW_SIZE) {
    const trimmed = keys
      .map((k): [string, number] => [k, idempotency[k] ?? 0])
      .sort(([, a], [, b]) => b - a)
      .slice(0, IDEMPOTENCY_WINDOW_SIZE);
    for (const key of Object.keys(idempotency)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- map keys are subscription-id strings on a value-typed Record
      delete idempotency[key];
    }
    for (const [k, v] of trimmed) idempotency[k] = v;
  }
  await writeConnectionRuntimeState(storage, connectionId, {
    ...state,
    idempotency,
  });
  return { isDuplicate };
}
