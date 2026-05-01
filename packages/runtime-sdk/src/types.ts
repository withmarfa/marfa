/**
 * Cross-handler types used by the runtime SDK.
 *
 * These match the queue message envelopes the control plane and the
 * reactive-run bridge produce. The shapes are stable wire formats —
 * changing them is a coordinated cross-PR change.
 */

/** Cycle-detection metadata that flows from the Myme server's
 *  event_log onto every reactive-run dispatch. The SDK refuses to
 *  call back into the server when hop_count >= budget. */
export interface CycleMetadata {
  originating_connection_id: string | null;
  hop_count: number;
}

/** Common envelope fields every queue message carries. */
export interface QueueEnvelopeBase {
  integration_name: string;
  connection_id: string;
  /** Server-stamped tenant id, when known. Used for permission gates
   *  and for activity emission attribution. */
  tenant_id?: string;
}

/** Triggered by the control plane after verifying an inbound webhook
 *  delivery against the manifest's verification adapter. */
export interface WebhookMessage extends QueueEnvelopeBase {
  kind: "webhook";
  delivery_id: string;
  headers: Record<string, string>;
  /** Raw body. Bodies > 256KB are handed off via R2 with a presigned
   *  URL substituted for `body` and `body_url` populated; the SDK
   *  resolves transparently. R2 wiring lands in Layer 2. */
  body: ArrayBuffer;
  body_url?: string;
  verified_at_ms: number;
}

/** Produced by the per-Connection DO's alarm() when a scheduled poll
 *  is due. The handler's job is to advance the cursor and emit any
 *  resulting items. */
export interface ScheduleMessage extends QueueEnvelopeBase {
  kind: "schedule";
  scheduled_for_ms: number;
}

/** Produced by the server-side reactive-run bridge when an
 *  event_log row matches a connector's subscription. */
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
  /** Bearer key the SDK includes in Myme API calls. */
  api_key: string;
  /** ISO timestamp the credential expires. The SDK refreshes
   *  preemptively at 80% of the issued TTL. */
  expires_at: string;
  /** The connection_id this credential was minted for. The runtime
   *  refuses to use a cached credential against a different
   *  connection_id (defence in depth against cache mix-ups). */
  connection_id: string;
}
