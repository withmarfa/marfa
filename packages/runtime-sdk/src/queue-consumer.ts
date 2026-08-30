/**
 * The dispatch engine over a batch of queue deliveries. For every
 * message in the batch it:
 *
 *   1. Mints / refreshes the per-Connection runtime credential via the
 *      environment's `mintCredential` callback.
 *   2. Builds the ConnectionContext (cursor, activity, echo, marfa
 *      client).
 *   3. Dispatches the message via `dispatchMessage`.
 *   4. Translates the HandlerResult:
 *      - { ok: true } → ack the message
 *      - { ok: false, retry: true } → retry with backoff
 *      - { ok: false, retry: false } → ack + emit a system.activity
 *        with severity: action_required (operator surface)
 *
 * The server's supervisor mirrors these semantics for live dispatch;
 * the runtime-test harness drives this function directly, so the two
 * stay pinned to one contract.
 */
import { dispatchMessage } from "./handlers.js";
import { ConnectionClient } from "./connection-client.js";
import { ConnectionGoneError } from "./errors.js";
import {
  createCursorStore,
  type CursorStorageAdapter,
} from "./cursor-store.js";
import { createActivitySink } from "./activity.js";
import { createMappingResolver } from "./mapping.js";
import { createEchoSuppression } from "./echo-suppression.js";
import { createBudget } from "./budget.js";
import type { ConnectionContext } from "./connection-context.js";
import {
  SDK_DEFAULT_HOP_BUDGET,
  type Continuation,
  type ContinuationInput,
  type DispatchResult,
  type FailureReason,
  type QueueMessage,
  type RuntimeCredential,
} from "./types.js";

/**
 * Minimal dead-letter producer shape. The consumer only needs `send`;
 * the type is widened across queue families so a single
 * `dlqProducerFor` can route by message kind.
 */
export interface DlqProducer {
  send(
    body: unknown,
    options?: { contentType?: "json" | "text" | "v8" },
  ): Promise<void>;
}

/**
 * The per-delivery envelope `consumeBatch` consumes: the payload plus
 * per-message ack/retry and the delivery counter. Structural on
 * purpose — the runtime-test harness constructs these directly around
 * in-memory payloads.
 */
export interface QueueDeliveryMessage<Body = QueueMessage> {
  readonly body: Body;
  /** 1 on first delivery, incremented per redelivery. */
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ConsumerEnvironment {
  /** Base URL of the Marfa server. */
  apiUrl: string;
  /** Per-Connection storage adapter for cursor + echo state. */
  storageFor: (connectionId: string) => CursorStorageAdapter;
  /** Mints (or refreshes) the per-Connection runtime credential.
   *  Throws `ConnectionGoneError` when the Connection is missing or
   *  inactive. */
  mintCredential: (connectionId: string) => Promise<RuntimeCredential>;
  /**
   * Cancel the Connection's schedule alarm. Called when the consumer
   * learns the Connection is gone, so an orphaned schedule stops
   * re-arming itself instead of ticking forever.
   *
   * Optional: substrates whose scheduler already gates on Connection
   * state (the local runtime's walker does) have nothing to cancel.
   */
  disarmSchedule?: (connectionId: string, reason: string) => Promise<void>;
  /** Manifest's bidirectional_handling block — drives echo TTL. */
  echo: { echo_ttl_seconds: number; lag_window_seconds?: number };
  /**
   * How long a handler on this substrate may run before it should wrap
   * up, in milliseconds.
   *
   * Required rather than defaulted, because whoever drives dispatch is
   * the only party that knows what bound it enforces, and a default here
   * would be this SDK guessing at somebody else's queue. A consumer that
   * genuinely has no bound should say so with a large number rather than
   * leaving a handler to discover the limit by being killed at it — which
   * is what every integration had to do before there was a budget at all.
   */
  softLimitMs: number;
  /** Integration name from the manifest (envelope filter). */
  integrationName: string;
  /**
   * Space id this Worker instance is scoped to. Configured at deploy
   * time. When set, the consumer cross-checks every incoming
   * `message.space_id` against it and acks-and-skips any mismatched
   * message — defense in depth against a misrouted cross-space message
   * that already passed the `connection_id` gate. Optional only to keep
   * self-host setups where the space column is null wire-compatible.
   */
  spaceId?: string;
  /**
   * Defensive ceiling for cycle hop count. When set, the consumer
   * refuses to dispatch a reactive `item-event` whose `cycle.hop_count`
   * meets or exceeds it. The server already drops over-budget events
   * before they hit the queue, but a non-pubsub producer could enqueue
   * without applying the gate. Defaults to `SDK_DEFAULT_HOP_BUDGET`.
   */
  hopBudget?: number;
  /**
   * Resolve a DLQ producer binding for a given message kind. On
   * permanent failure the wrapper sends an enriched copy of the message
   * (carrying `_failure_reason`) to the resolved DLQ before acking the
   * original. Returning `null` (or omitting the resolver entirely) means
   * ack + activity emit only — the message is dropped from
   * operator-peekable surfaces with no DLQ copy.
   *
   * Routing by `message.kind` (webhook / schedule / item-event) lets a
   * Worker that consumes multiple queue families wire the matching DLQ
   * for each family.
   */
  dlqProducerFor?: (kind: QueueMessage["kind"]) => DlqProducer | null;
  /**
   * Enqueue the next slice of a chain whose handler parked.
   *
   * Required, and deliberately not optional. A substrate that cannot
   * enqueue a continuation cannot run this contract, and the failure mode
   * of letting it try is the worst one available: the handler returns
   * `ok: true`, the message is acked, and the unfinished sweep is
   * indistinguishable from a finished one. Making it required means a
   * substrate that has not thought about resumption fails to compile
   * rather than silently dropping every chain it is handed.
   *
   * `notBefore` is the handler's requested delay in epoch ms — the answer
   * to a 429 — already clamped by the caller. The driver may schedule
   * later than asked but must not schedule earlier.
   */
  enqueueContinuation: (
    message: QueueMessage,
    options?: { notBefore?: number },
  ) => Promise<void>;
}

interface ConsumeOutcome {
  acked: number;
  retried: number;
  failed: number;
}

/**
 * Build the queue message for the next slice of a chain.
 *
 * Three things are preserved rather than recomputed, and each has bitten
 * somewhere before:
 *
 * - **`kind`.** A continuation of a manual run stays `manual`. The
 *   operator surface distinguishes "this ran because someone asked" from
 *   "this ran because the cron fired", and a chain that quietly became a
 *   schedule run halfway through would misattribute every slice after the
 *   first.
 * - **`chain_id` and `started_at_ms`.** Both belong to the chain, not the
 *   slice, so they are copied from the inbound continuation when there is
 *   one. Restamping `started_at_ms` per slice would make a wall-clock
 *   chain ceiling unreachable: every slice would look freshly started and
 *   a chain could run forever inside a bound that never elapses.
 * - **the envelope's own identity fields.** Rebuilding them from parts is
 *   how a `space_id` gets dropped, and a message with no space is one the
 *   consumer's own cross-space check cannot evaluate.
 *
 * `slice` counts from 1 for the first continuation, so it reads as "how
 * many extra deliveries has this sweep needed" rather than as an index.
 */
export function nextSlice(
  message: QueueMessage,
  continuation: Continuation,
): QueueMessage {
  if (message.kind !== "schedule" && message.kind !== "manual") {
    // Only a sweep can park. Webhook and item-event handlers return
    // `HandlerResult`, which has no `done`, so this is unreachable
    // through the type system and is here to fail loudly rather than
    // silently produce a malformed envelope if that ever changes.
    throw new Error(`a ${message.kind} message cannot carry a continuation`);
  }
  const inbound = "continuation" in message ? message.continuation : undefined;
  const fingerprint = progressFingerprint(continuation);
  const seen = [...(inbound?.seen_fingerprints ?? []), fingerprint].slice(
    -SEEN_FINGERPRINT_WINDOW,
  );
  return {
    ...message,
    continuation: {
      resume: continuation.resume,
      chain_id: inbound?.chain_id ?? continuation.sweepId ?? newChainId(),
      slice: (inbound?.slice ?? 0) + 1,
      started_at_ms: inbound?.started_at_ms ?? Date.now(),
      progress_fingerprint: fingerprint,
      seen_fingerprints: seen,
    },
  };
}

/**
 * How many slices one chain may run, and how long, before it is
 * abandoned.
 *
 * Deliberately the same numbers the in-process supervisor uses. They are
 * duplicated rather than shared because the supervisor cannot import a
 * constant it also has to document in its own operator notes, but they
 * mean the same thing and should move together.
 */
const MAX_SLICES_PER_CHAIN = 200;
const MAX_CHAIN_WALL_CLOCK_MS = 6 * 60 * 60 * 1000;

/**
 * Why this chain should stop, or `null` to carry on.
 *
 * Wraps `assessChainProgress` with the two ceilings, so a driver has one
 * question to ask rather than three to remember.
 */
export function chainRefusal(
  inbound: ContinuationInput | undefined,
  continuation: Continuation,
): string | null {
  const stalled = assessChainProgress(inbound, continuation);
  if (stalled !== null) return stalled;
  const sliceCount = (inbound?.slice ?? 0) + 1;
  if (sliceCount > MAX_SLICES_PER_CHAIN) {
    return `This sync was stopped after ${String(sliceCount - 1)} continuations without finishing`;
  }
  const ranForMs = Date.now() - (inbound?.started_at_ms ?? Date.now());
  if (ranForMs > MAX_CHAIN_WALL_CLOCK_MS) {
    return `This sync was stopped after running for ${String(Math.round(ranForMs / 60_000))} minutes without finishing`;
  }
  return null;
}

/** How many past fingerprints an envelope carries. Small on purpose: it
 *  rides on every slice, and a loop longer than this is caught by the
 *  slice and wall-clock ceilings instead. */
const SEEN_FINGERPRINT_WINDOW = 16;

/**
 * Flatten a slice's progress into something comparable.
 *
 * A plain string rather than a hash, because the only consumers are an
 * equality check and a human reading a failure reason, and a hash would
 * cost the second to buy nothing for the first.
 */
export function progressFingerprint(continuation: Continuation): string {
  const { processed, watermark } = continuation.progress;
  return `${String(processed)}@${watermark ?? ""}`;
}

/**
 * Whether a chain has stopped getting anywhere.
 *
 * Returns a reason to abandon it, or `null` to continue. Lives here
 * rather than in the substrate so every driver applies the same rule —
 * the check is cheap and the failure it catches is invisible, which is
 * exactly the combination that gets reimplemented differently twice.
 *
 * Both cases are recoverable by design: the watermark is committed as the
 * sweep runs, so abandoning costs only the slices already spent and the
 * next scheduled tick starts a fresh chain from where this one reached.
 * That is what makes it right to be strict here.
 */
export function assessChainProgress(
  inbound: ContinuationInput | undefined,
  continuation: Continuation,
): string | null {
  if (inbound === undefined) return null;

  // A slice that parked asking not to be resumed yet was refused by the
  // provider rather than stalled by itself, and neither guard below can
  // tell the difference. A fully throttled slice writes nothing and holds
  // its watermark, so it reports the fingerprint the slice before it did;
  // a sustained throttle returns to a position it has already reported.
  // Both read as this function's two failure modes and neither is what
  // happened.
  //
  // The outcome of abandoning was arguably right — stop hammering a
  // provider that is refusing — but the explanation was not, and an
  // operator told a sync is looping is being argued out of the one reading
  // that would explain it. The chain stays bounded by the slice and
  // wall-clock ceilings, which is the honest bound for a chain whose
  // progress signal has nothing to say.
  if (continuation.notBefore !== undefined) return null;

  const fingerprint = progressFingerprint(continuation);
  if (inbound.progress_fingerprint === fingerprint) {
    return `This sync stopped making progress: two slices in a row reported the same position (${fingerprint})`;
  }
  if (inbound.seen_fingerprints?.includes(fingerprint) === true) {
    return `This sync is looping: it returned to a position it had already left (${fingerprint})`;
  }
  return null;
}

/**
 * Correlation id for one chain of slices.
 *
 * `crypto.randomUUID` is the Web Crypto standard rather than Node's, so
 * it is available on every substrate this SDK targets — the same reason
 * this package decodes base64 by hand instead of reaching for `Buffer`.
 */
function newChainId(): string {
  return `chain_${crypto.randomUUID()}`;
}

/** Build a ConnectionContext for a single message. Exported for
 *  per-integration tests that want to exercise handlers via the same
 *  context the runtime would build. */
export async function buildConnectionContext(
  env: ConsumerEnvironment,
  message: QueueMessage,
  /**
   * When the driver picked this delivery up, epoch ms. Defaults to now,
   * which is right for a consumer that builds the context immediately;
   * a driver that queued the delivery earlier passes its own timestamp so
   * the wait is charged against the budget rather than forgiven.
   */
  startedAtMs: number = Date.now(),
): Promise<ConnectionContext> {
  const credential = await env.mintCredential(message.connection_id);
  // Thread the parent cycle into the ConnectionClient so every mutating
  // call back into Marfa stamps the cycle headers. Schedule / webhook
  // handlers start a fresh chain (cycleParent: null — `nextHopMetadata`
  // stamps the integration as the chain head); item-event handlers
  // inherit the parent's cycle from the queue message.
  const cycleParent = message.kind === "item-event" ? message.cycle : null;
  const client = new ConnectionClient({
    apiUrl: env.apiUrl,
    credential,
    refreshCredential: () => env.mintCredential(message.connection_id),
    cycleParent,
  });
  const storage = env.storageFor(message.connection_id);
  const { budget, arm } = createBudget({
    startedAtMs,
    softLimitMs: env.softLimitMs,
  });
  // Armed and not handed back. The timer is unref'd, so it cannot hold
  // the process open, and the controller it aborts belongs to this
  // dispatch alone — firing after the handler has returned aborts
  // something nobody is holding, which is a no-op.
  //
  // The in-process substrate's worker DOES cancel its timer, and the
  // difference is lifetime rather than disagreement: its threads are
  // pooled and outlive many dispatches, so an uncancelled timer each time
  // accumulates for the life of the thread. Here the longest anything
  // lives is one batch.
  arm();
  const context: ConnectionContext = {
    connection_id: message.connection_id,
    integration_name: message.integration_name,
    space_id: message.space_id,
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, message.connection_id),
    echo: createEchoSuppression(storage, env.echo),
    mapping: createMappingResolver(client, message.connection_id),
    cycle: cycleParent,
    budget,
  };
  return context;
}

/**
 * Maximum exponential-backoff delay (seconds) on a per-message retry.
 * Keeps a runaway exponent from producing absurd delays before the
 * message reaches the max-attempts ceiling and goes to the DLQ.
 */
const MAX_RETRY_DELAY_SECONDS = 60;

/**
 * Compute the next per-message retry delay from `message.attempts`.
 * `attempts` is 1 on first delivery, so a handler-returned
 * `retry: true` on the first attempt stamps `2^0 = 1` second; a second
 * retry is `2^1 = 2`; etc., capped at `MAX_RETRY_DELAY_SECONDS`.
 */
function backoffSecondsFor(attempts: number): number {
  // Math.max guards against `attempts === 0` from a misbehaving
  // producer — the contract is "first delivery is attempts === 1".
  const exponent = Math.max(0, attempts - 1);
  return Math.min(2 ** exponent, MAX_RETRY_DELAY_SECONDS);
}

/**
 * Process a batch of queue deliveries with per-message ack/retry.
 *
 * A single batch-level verdict would retry the WHOLE batch on any
 * failure, re-running messages that already succeeded — a source of
 * duplicate-write hazards. Per-message `ack()` and
 * `retry({ delaySeconds })` close the hazard at its source: a
 * partial-batch failure only retries the failures.
 *
 * Per-message decision tree:
 *
 *   - Handler `{ ok: true }` → `msg.ack()` (acked counter)
 *   - Handler `{ ok: false, retry: true }` → `msg.retry({ delaySeconds })`
 *     with exponential backoff derived from `msg.attempts` (retried
 *     counter)
 *   - Handler `{ ok: false, retry: false }` → `msg.ack()` + emit an
 *     `action_required` activity (failed counter)
 *   - Handler **throws on first attempt** (`msg.attempts === 1`) →
 *     `msg.retry()` once. Programming errors get one retry; transient
 *     errors (an upstream blip that surfaced as a throw) get a chance
 *     to recover.
 *   - Handler **throws on a retried attempt** (`msg.attempts > 1`) →
 *     `msg.ack()` + emit `action_required`. Don't infinitely retry a
 *     persistent programming error — the queue's max-attempts ceiling
 *     would otherwise route the message to the DLQ after a long delay
 *     of repeating the same bad path.
 *   - Envelope-filter / space-mismatch / hop-budget overflow →
 *     `msg.ack()` (acked counter). These messages aren't ours to
 *     process; acking drops them from the queue.
 *   - **`ConnectionGoneError`** → `msg.ack()`, plus `disarmSchedule()`
 *     when the message is a `schedule`. The Connection no longer exists
 *     (or is no longer active), so no amount of retrying helps. For a
 *     schedule message, cancel the per-Connection alarm too: it re-arms
 *     itself on every fire, so leaving it running means an orphaned
 *     schedule ticks forever against nothing. Other message kinds ack
 *     without touching the alarm — they carry no evidence about it.
 *
 * `outcome` counters are for telemetry. The function never throws;
 * per-message `retry()` carries the verdict.
 */
export async function consumeBatch(
  env: ConsumerEnvironment,
  messages: QueueDeliveryMessage[],
): Promise<ConsumeOutcome> {
  const outcome: ConsumeOutcome = { acked: 0, retried: 0, failed: 0 };
  const hopBudget = env.hopBudget ?? SDK_DEFAULT_HOP_BUDGET;
  // Every message in this batch is charged from when the batch was
  // fetched, because that is when the substrate's own bound started. The
  // messages are handled one after another, so a handler late in the
  // batch has genuinely less of the allowance left than the first — and
  // stamping each one at its own start would hand every message a full
  // allowance the queue has already partly spent. This is the same
  // batch-versus-dispatch confusion the in-process substrate's expiry
  // constant carries a warning about.
  const batchStartedAtMs = Date.now();

  for (const msg of messages) {
    const message = msg.body;

    if (message.integration_name !== env.integrationName) {
      // Envelope filter — the queue is shared across integrations.
      // Ack messages addressed to other integrations so they leave the
      // queue; otherwise they'd retry indefinitely against the wrong
      // consumer.
      msg.ack();
      outcome.acked++;
      continue;
    }
    // Defense-in-depth space check. The connection_id gate is the
    // primary line of defense; this is the secondary one. A misrouted
    // message that targets the wrong space gets acked and skipped
    // without ever invoking the handler.
    if (
      env.spaceId !== undefined &&
      message.space_id !== undefined &&
      message.space_id !== env.spaceId
    ) {
      msg.ack();
      outcome.acked++;
      continue;
    }
    // SDK-side cycle-budget refusal. The server drops events past its
    // own budget before they hit the queue, but a non-pubsub queue
    // producer could enqueue without applying the gate. Refuse here as
    // a defensive ceiling and surface the failure as an action_required
    // activity so an operator can see the loop.
    if (message.kind === "item-event" && message.cycle.hop_count >= hopBudget) {
      msg.ack();
      outcome.acked++;
      try {
        const ctx = await buildConnectionContext(env, message);
        await ctx.activity.emit({
          severity: "error",
          summary: `Reactive event dropped: cycle hop budget (${String(hopBudget)}) reached at the SDK boundary`,
          detail: {
            connection_id: message.connection_id,
            originating_connection_id: message.cycle.originating_connection_id,
            hop_count: message.cycle.hop_count,
          },
        });
      } catch {
        // Swallow — failing to emit the activity is non-fatal.
      }
      continue;
    }

    // ctx is null until buildConnectionContext succeeds; activity emit falls
    // back to a fresh build if it stays null (e.g. credential mint throws).
    let ctx: ConnectionContext | null = null;
    let result: DispatchResult;
    let dispatchThrew = false;
    // Captured separately so the DLQ stamp uses the bare error message +
    // class name. result.reason carries a "dispatch_threw: ..." prefix for
    // the activity-emit path; the DLQ path wants the raw message to avoid
    // a double-prefix in the flattened operator string.
    let thrownClassName: string | null = null;
    let thrownMessage: string | null = null;
    try {
      ctx = await buildConnectionContext(env, message, batchStartedAtMs);
      result = await dispatchMessage(ctx, message);
    } catch (err) {
      // A gone Connection short-circuits the whole ladder. Retrying and
      // dead-lettering both assume the work might one day succeed; this
      // one cannot. Tear down the schedule alarm so the Connection stops
      // manufacturing new messages, then drop this one.
      if (err instanceof ConnectionGoneError) {
        msg.ack();
        outcome.acked++;
        console.error(
          `[runtime-sdk:consumeBatch] connection ${message.connection_id} is gone (${String(err.status)}); dropping ${message.kind} message`,
        );
        // Only a schedule message is evidence about the schedule. A
        // webhook or item-event can sit in the queue long after it was
        // produced, so acting on one would let a stale delivery tear
        // down a live Connection's alarm — and nothing re-arms it.
        if (message.kind === "schedule") {
          try {
            await env.disarmSchedule?.(
              message.connection_id,
              `connection_gone_${String(err.status)}`,
            );
          } catch (disarmErr) {
            console.error(
              `[runtime-sdk:consumeBatch] disarm failed for connection ${message.connection_id}: ${disarmErr instanceof Error ? disarmErr.message : String(disarmErr)}`,
            );
          }
        }
        continue;
      }
      dispatchThrew = true;
      thrownClassName =
        err instanceof Error ? err.constructor.name || "Error" : "unknown";
      thrownMessage = err instanceof Error ? err.message : String(err);
      // console.error is the only operator-visible signal when the throw is a
      // mint failure (credential bootstrap) — the activity-emit backstop
      // can't reach Marfa in that case either, so wrangler tail / CF logs
      // is all there is before the retry ladder consumes the message.
      console.error(
        `[runtime-sdk:consumeBatch] dispatch threw on ${message.kind} for connection ${message.connection_id} (integration=${message.integration_name}, attempts=${String(msg.attempts)}): ${thrownClassName}: ${thrownMessage}`,
      );
      result = {
        ok: false,
        retry: false,
        reason: `dispatch_threw: ${thrownMessage}`,
      };
    } finally {
      // Deliberate mapping skips surface as one summary row per run, and
      // this is the per-run boundary on this substrate. In the finally so
      // skips counted before a late handler throw still surface — the
      // resolver dies with the run, and a summary inside the try died
      // with it. Best-effort both ways: a summary that cannot land must
      // not fail the dispatch it describes.
      if (ctx !== null) {
        try {
          await ctx.mapping.flushSkipSummary(ctx.activity);
        } catch {
          // The skip count resets either way; the run's own result stands.
        }
      }
    }

    if (result.ok) {
      // A parked sweep is acked only once its successor is safely on the
      // queue. Acking first and enqueuing after would lose the chain to
      // any failure in between, and lose it silently: the operator
      // surface would show a completed run.
      if ("done" in result && !result.done) {
        // The same ceilings the in-process substrate applies. They live
        // here too because a chain with no bound is the documented
        // footgun of every runtime that has one, and a driver that parks
        // without checking will loop until something external notices —
        // which for a queue means never.
        const inbound =
          "continuation" in message ? message.continuation : undefined;
        const refusal = chainRefusal(inbound, result.continuation);
        if (refusal !== null) {
          console.error(
            `[runtime-sdk:consumeBatch] abandoning the chain on connection ${message.connection_id}: ${refusal}`,
          );
          try {
            await (
              ctx ?? (await buildConnectionContext(env, message))
            ).activity.emit({
              severity: "action_required",
              summary: "A sync was stopped because it stopped making progress",
              detail: { connection_id: message.connection_id, reason: refusal },
            });
          } catch {
            // Swallow — failing to emit the activity must not turn an
            // abandoned chain into a retried one.
          }
          // Acked, not retried. Redelivering the slice would restart the
          // same loop; the next scheduled tick begins a fresh chain from
          // the committed watermark, which is the actual recovery.
          msg.ack();
          outcome.failed++;
          continue;
        }
        const next = nextSlice(message, result.continuation);
        try {
          await env.enqueueContinuation(
            next,
            result.continuation.notBefore === undefined
              ? undefined
              : { notBefore: result.continuation.notBefore },
          );
        } catch (err) {
          // The slice's own work is already committed, so redelivering it
          // repeats a slice rather than losing one. That is the right
          // trade against dropping the remainder of the sweep.
          console.error(
            `[runtime-sdk:consumeBatch] could not enqueue the next slice for connection ${message.connection_id}; retrying this one: ${err instanceof Error ? err.message : String(err)}`,
          );
          msg.retry({ delaySeconds: backoffSecondsFor(msg.attempts) });
          outcome.retried++;
          continue;
        }
      }
      msg.ack();
      outcome.acked++;
      continue;
    }

    // A throw on the first attempt is treated as transient — give the
    // handler one retry to recover. A throw on a retried attempt
    // (attempts > 1) is treated as a persistent programming error and
    // acked-and-logged so it doesn't loop until the max-attempts
    // ceiling hits the DLQ.
    const isFirstAttemptThrow = dispatchThrew && msg.attempts === 1;
    const wantsRetry = result.retry || isFirstAttemptThrow;

    if (wantsRetry) {
      const delaySeconds = backoffSecondsFor(msg.attempts);
      msg.retry({ delaySeconds });
      outcome.retried++;
      continue;
    }

    // Permanent failure: stamp _failure_reason → DLQ forward → ack → activity emit.
    // All three steps are independent. At-least-once: if the DLQ send succeeds
    // and the ack fails, the original re-delivers and produces a second DLQ entry
    // — intentional; a duplicate entry is preferable to a silent drop.
    const failureReason: FailureReason = {
      // On the throw path use the bare error message (not the
      // `dispatch_threw: …` prefixed `result.reason`) so the flattened
      // peek string isn't double-prefixed alongside `class_name`.
      message: dispatchThrew ? (thrownMessage ?? result.reason) : result.reason,
      class_name: dispatchThrew
        ? (thrownClassName ?? "unknown")
        : "HandlerResult",
      attempts: msg.attempts,
      failed_at: new Date().toISOString(),
    };

    const dlqProducer = env.dlqProducerFor?.(message.kind) ?? null;
    if (dlqProducer) {
      try {
        await dlqProducer.send(
          { ...message, _failure_reason: failureReason },
          { contentType: "json" },
        );
      } catch {
        // Swallow — DLQ enrichment is best-effort. The activity emit
        // below is the backstop operator surface; CF logs the throw.
      }
    }

    msg.ack();
    outcome.failed++;
    try {
      // Reuse ctx if available; rebuild only when the original build threw.
      const activityCtx = ctx ?? (await buildConnectionContext(env, message));
      await activityCtx.activity.emit({
        severity: "action_required",
        summary: `Permanent failure handling ${message.kind} message`,
        detail: {
          reason: result.reason,
          connection_id: message.connection_id,
          attempts: msg.attempts,
        },
      });
    } catch {
      // Swallow — activity emit failure is non-fatal.
    }
  }

  return outcome;
}
