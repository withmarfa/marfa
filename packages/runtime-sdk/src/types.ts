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

/** Any value a cursor or a resume position can hold. */
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * What a handler hands back when it has more to do than one dispatch is
 * allowed to do.
 *
 * `resume` is opaque: the runtime round-trips it into the next slice
 * verbatim and never reads it. That is deliberate rather than lazy. A
 * resume position that survives a third party changing its mind between
 * slices is not a number — the estate already has one built by hand out
 * of an anchor identity, a divergence flag and a run length, and a typed
 * offset would be strictly weaker than what that cursor already holds.
 *
 * It rides the queue message rather than the cursor, because the
 * per-connection lock is released between slices and an unrelated
 * dispatch runs in the gap. The cursor holds durable watermarks; this
 * holds where one run got to.
 */
export interface Continuation {
  /**
   * Correlation id the handler wants this chain to carry.
   *
   * Supplied by the handler rather than minted by the runtime, because a
   * handler that tracks its own chain — `sweep()` records one in the
   * cursor so it can reject a straggler from an abandoned chain — has to
   * agree with the envelope about what that chain is called. Two ids for
   * one chain means the check compares a value against itself under a
   * different name, and every slice after the first is rejected.
   *
   * Omit it and the runtime mints one; a handler that never reads
   * `chain_id` back has nothing to agree with.
   */
  sweepId?: string;
  /** Opaque to the runtime, round-tripped into the next slice verbatim. */
  resume: Json;
  /**
   * Evidence the chain advanced. The runtime compares it and never
   * interprets it: a slice returning the same progress it was handed has
   * not moved, which is a loop rather than slowness.
   */
  progress: {
    /** Units handled in THIS slice. Zero is legitimate; unchanged is not. */
    processed: number;
    /** The author's own summary of where the run reached. */
    watermark?: string;
    /**
     * A digest of the position this slice carried, where it carried one.
     *
     * Folded into the comparison alongside the watermark, because a sweep
     * against a provider with no domain key can still advance: it walks
     * pages of an unordered listing and has a position but nothing to
     * report as a watermark. Without this, such a sweep with a fixed
     * per-slice cap reports an identical fingerprint every slice and is
     * abandoned on its second, which made the watermark mandatory in
     * practice while the type presented it as optional.
     */
    position?: string;
  };
  /**
   * Ask for the chain to be bounded by the slice and wall-clock ceilings
   * alone, because nothing this sweep can report advances.
   *
   * The honest declaration for a provider with no domain key and no
   * carried position. The alternative an author is otherwise pushed
   * towards is reporting an invented watermark purely to keep the
   * comparison moving, which defeats the guard silently rather than
   * saying so.
   */
  stallGuard?: "ceilings";
  /**
   * Earliest the next slice should run, in milliseconds. Clamped by the
   * runtime. This is the honest answer to a rate limit: park with the
   * upstream's own retry delay rather than sleeping inside the budget and
   * spending a whole slice on nothing.
   */
  notBefore?: number;
}

/**
 * What a scheduled sweep reports back.
 *
 * `done` is required rather than optional, and that is the whole point of
 * the shape. An additive variant would have been read as a success by
 * both translations that consume it, so a handler saying "not finished"
 * would have been acknowledged as finished and its continuation dropped —
 * silently, and green in every test. A required discriminant makes that a
 * compile error instead.
 *
 * Webhook and item-event handlers keep `HandlerResult`. A delivery and an
 * item event have nothing to continue, and making them say so is ceremony
 * that teaches nothing.
 */
export type SweepResult =
  | { ok: true; done: true }
  | { ok: true; done: false; continuation: Continuation }
  | { ok: false; retry: boolean; reason: string };

/**
 * What a dispatch of any kind can return.
 *
 * The union exists so the substrate has one thing to hold, and it is a
 * union rather than a widened `HandlerResult` so that reading `done`
 * requires narrowing on `kind` upstream. Both arms answer `ok` and both
 * failure arms answer `retry`, so the retry ladder and the dead-letter
 * translation read it without narrowing at all — which is what stopped
 * this change from reaching every consumer of a result.
 */
export type DispatchResult = HandlerResult | SweepResult;

/**
 * What the runtime hands a continuing slice.
 *
 * `kind` is preserved from whatever started the chain, so a continuation
 * of a manual run is still `manual`. The operator surface cares that a
 * person asked for this, and a fourth message kind would force a fourth
 * branch into every handler including the ones that never continue.
 */
export interface ContinuationInput {
  /** Verbatim from the previous slice. */
  resume: Json;
  /** Stable for the whole chain. A slice carrying a stale one is discarded. */
  chain_id: string;
  /** Zero for the run that started the chain. */
  slice: number;
  /** When the chain started, epoch ms. */
  started_at_ms: number;
  /**
   * What the previous slice reported as progress, flattened.
   *
   * Carried so the runtime can compare one slice's progress against the
   * last without keeping chain state of its own. A chain that stops
   * advancing produces completed jobs and a stale `last_sync_at`, so
   * nothing on the operator surface reports it — the comparison is the
   * only thing that can.
   */
  progress_fingerprint?: string;
  /**
   * Fingerprints already seen on this chain, oldest first and capped.
   *
   * Two consecutive identical fingerprints catch a chain that has stopped
   * dead. This catches the one that alternates — A, B, A, B — which the
   * consecutive check never fires on because no two neighbours match. The
   * cap is what keeps the envelope from growing with the chain; a loop
   * longer than the window is left to the slice and wall-clock ceilings.
   */
  seen_fingerprints?: string[];
}

/** Produced by the schedule walker's fan-out when a scheduled poll is
 *  due. The handler's job is to advance the cursor and emit any
 *  resulting items. */
export interface ScheduleMessage extends QueueEnvelopeBase {
  kind: "schedule";
  scheduled_for_ms: number;
  /** Present only on a slice continuing a chain. */
  continuation?: ContinuationInput;
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
  /** Present only on a slice continuing a chain. */
  continuation?: ContinuationInput;
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
