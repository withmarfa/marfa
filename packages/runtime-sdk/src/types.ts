/**
 * Cross-handler types used by the runtime SDK.
 *
 * These match the queue message envelopes the server's runtime
 * produces — the webhook-receipt route, the schedule walker's fan-out,
 * and the reactive bridge. The shapes are stable wire formats —
 * changing them is a coordinated cross-PR change.
 */

/** Cycle-detection metadata that flows from the Marfa server's
 *  event_log onto every reactive-run dispatch. The SDK refuses to
 *  call back into the server when hop_count >= budget. */
export interface CycleMetadata {
  originating_connection_id: string | null;
  hop_count: number;
}

/**
 * Default per-space hop budget (mirrors `DEFAULT_HOP_BUDGET` on the
 * server). Used by the SDK as a defensive ceiling — the server already
 * drops events past its own budget before enqueuing, but a non-pubsub
 * queue producer could enqueue without applying the gate. The SDK's
 * refusal is belt-and-braces.
 */
export const SDK_DEFAULT_HOP_BUDGET = 5;

/**
 * Compute cycle metadata for a downstream event published from a
 * integration reaction. Mirrors the server-side `nextHopMetadata` — kept
 * here so integration handlers don't roll their own and accidentally
 * skip stamping `originating_connection_id`.
 *
 * Pass the parent's `cycle` (from `ItemEventMessage.cycle`) and the
 * current integration's `connection_id`. The returned metadata stamps:
 *   - `originating_connection_id`: parent's if set, otherwise the
 *     current connection (this integration kicks off the chain).
 *   - `hop_count`: parent's + 1.
 */
export function nextHopMetadata(
  parent: CycleMetadata | null | undefined,
  currentConnectionId: string,
): CycleMetadata {
  const parentHopCount = parent?.hop_count ?? 0;
  const parentOrigin = parent?.originating_connection_id ?? null;
  return {
    originating_connection_id: parentOrigin ?? currentConnectionId,
    hop_count: parentHopCount + 1,
  };
}

/**
 * Stamped on the message body by the queue-consumer wrapper when a
 * handler permanently fails, so whatever drains the dead-letter side
 * can surface a real reason rather than `null`. Optional because:
 *
 *   - Messages on the main queue never carry this — it's a DLQ marker.
 *   - The wrapper only stamps when a `dlqProducerFor` sink is wired,
 *     so consumers without DLQ-routing keep their existing behavior.
 *
 * The server's supervisor mirrors the semantics on pg-boss: exhausted
 * retries land in pg-boss's `failed` rows, which the dead-letter admin
 * surface reads directly.
 */
export interface FailureReason {
  /** The handler-reported reason, or the thrown error's `message`. */
  message: string;
  /** Error class name when the failure path was a throw (e.g. `Error`,
   *  `TypeError`); `"HandlerResult"` when the failure path was a
   *  `{ ok: false, retry: false }` return. */
  class_name: string;
  /** `Message.attempts` at the point the failure was finalized. */
  attempts: number;
  /** ISO timestamp the wrapper produced the enrichment. */
  failed_at: string;
}

/** Common envelope fields every queue message carries. */
export interface QueueEnvelopeBase {
  integration_name: string;
  connection_id: string;
  /** Server-stamped space id, when known. Used for permission gates
   *  and for activity emission attribution. */
  space_id?: string;
  /** Set only on messages routed to a DLQ by the runtime-sdk consumer
   *  wrapper on permanent failure. Read by dead-letter tooling to
   *  populate `failure_reason`. */
  _failure_reason?: FailureReason;
}

/** Triggered by the server's webhook-receipt route after verifying an
 *  inbound webhook delivery against the manifest's verification
 *  adapter. */
export interface WebhookMessage extends QueueEnvelopeBase {
  kind: "webhook";
  delivery_id: string;
  headers: Record<string, string>;
  /**
   * Raw body, base64-encoded so it survives JSON serialization on the
   * queue. The SDK's `buildConnectionContext` decodes to `ArrayBuffer`
   * and surfaces it as `body` on the handler input.
   */
  body_base64: string;
  verified_at_ms: number;
}

/**
 * Decoded handler input for a webhook delivery. The SDK builds this in
 * `buildConnectionContext` from the wire `WebhookMessage`. Handlers
 * receive `body: ArrayBuffer`, never the base64 form.
 */
export interface WebhookHandlerInput {
  delivery_id: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
  verified_at_ms: number;
}

/** Decode a base64 string to an ArrayBuffer without touching Node's
 *  `Buffer`, keeping the module portable across JS runtimes. */
export function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Produced by the schedule walker's fan-out when a scheduled poll is
 *  due. The handler's job is to advance the cursor and emit any
 *  resulting items. */
export interface ScheduleMessage extends QueueEnvelopeBase {
  kind: "schedule";
  scheduled_for_ms: number;
}

/** Produced by the server-side reactive-run bridge when an
 *  event_log row matches an integration's subscription. */
export interface ItemEventMessage extends QueueEnvelopeBase {
  kind: "item-event";
  event_type: string;
  item_id: string;
  cycle: CycleMetadata;
  /** Opaque payload carried over from the event_log row. */
  payload: unknown;
}

/** Produced when somebody asks for a run through
 *  `POST /connections/{id}/run`, rather than by a cron tick.
 *
 *  It carries the same intent as a schedule tick and is dispatched to the
 *  same handler, so an integration needs no code to support it. The kind
 *  is distinct only so the origin survives into logs and activity: "this
 *  ran because a person asked" and "this ran because the hour turned" are
 *  different facts about the same work. */
export interface ManualMessage extends QueueEnvelopeBase {
  kind: "manual";
  requested_at_ms: number;
}

export type QueueMessage =
  WebhookMessage | ScheduleMessage | ItemEventMessage | ManualMessage;

/** A handler decides how its run reports back. The runtime turns
 *  these into queue ack/retry semantics + system.activity emission. */
export type HandlerResult =
  { ok: true } | { ok: false; retry: boolean; reason: string };

/** Minted by the server for the dispatch and handed to the SDK with
 *  it; the SDK caches it for the length of the run. */
export interface RuntimeCredential {
  /** Bearer key the SDK includes in Marfa API calls. */
  api_key: string;
  /** ISO timestamp the credential expires. The SDK refreshes
   *  preemptively at 80% of the issued TTL. */
  expires_at: string;
  /** The connection_id this credential was minted for. The runtime
   *  refuses to use a cached credential against a different
   *  connection_id (defense in depth against cache mix-ups). */
  connection_id: string;
}
