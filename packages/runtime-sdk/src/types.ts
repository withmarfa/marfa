/**
 * Cross-handler types used by the runtime SDK.
 *
 * These match the queue message envelopes the control plane and the
 * reactive-run bridge produce. The shapes are stable wire formats —
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
 * queue producer (or future control-plane path) could enqueue without
 * applying the gate. The SDK's refusal is belt-and-braces.
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
 * handler permanently fails. Routes through the per-Worker DLQ producer
 * binding so `cf-queues-pull` peek surfaces a real reason rather than
 * `null`. Optional because:
 *
 *   - Messages on the main queue never carry this — it's a DLQ marker.
 *   - The wrapper only stamps when a `dlqProducerFor` binding is wired,
 *     so integrations without DLQ-routing keep their existing behavior.
 *   - DLQ landings via Cloudflare's auto-routing (`attempts > max_retries`
 *     on a `retry: true` loop) can't be enriched in flight, so peek
 *     output for those still shows `null` — see the route's fallback.
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
   *  wrapper on permanent failure. Read by `cf-queues-pull` peek to
   *  populate `failure_reason`. */
  _failure_reason?: FailureReason;
}

/** Triggered by the control plane after verifying an inbound webhook
 *  delivery against the manifest's verification adapter. */
export interface WebhookMessage extends QueueEnvelopeBase {
  kind: "webhook";
  delivery_id: string;
  headers: Record<string, string>;
  /**
   * Raw body, base64-encoded so it survives JSON serialization through
   * the Cloudflare Queue. The SDK's `buildConnectionContext` decodes to
   * `ArrayBuffer` and surfaces it as `body` on the handler input.
   * Bodies > 256KB are handed off via R2 with a presigned URL
   * substituted (`body_url` populated); the SDK resolves transparently.
   */
  body_base64: string;
  body_url?: string;
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
  body_url?: string;
  verified_at_ms: number;
}

/** Decode a base64 string to an ArrayBuffer. Works in both Node and
 *  Cloudflare Workers (`atob` is available in both). */
export function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Produced by the per-Connection DO's alarm() when a scheduled poll
 *  is due. The handler's job is to advance the cursor and emit any
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

export type QueueMessage = WebhookMessage | ScheduleMessage | ItemEventMessage;

/** A handler decides how its run reports back. The runtime turns
 *  these into queue ack/retry semantics + system.activity emission. */
export type HandlerResult =
  | { ok: true }
  | { ok: false; retry: boolean; reason: string };

/** The control plane stamps this on every lease response so the SDK
 *  can cache it on the per-Connection DO. */
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
