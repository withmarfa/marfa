/**
 * Queue consumer entry. Per-Integration Workers wire this as the
 * `queue` export in their entrypoint. The consumer:
 *
 *   1. For every message in the batch:
 *      a. Mints / refreshes the per-Connection runtime credential via
 *         the control-plane lease broker (cached on the per-Connection
 *         DO with TTL ≤ 5 min).
 *      b. Builds the ConnectionContext (cursor, activity, echo,
 *         marfa client).
 *      c. Dispatches the message via `dispatchMessage`.
 *   2. Translates the HandlerResult:
 *      - { ok: true } → ack the message
 *      - { ok: false, retry: true } → throw to trigger Cloudflare's
 *        exponential-backoff retry
 *      - { ok: false, retry: false } → ack + emit a system.activity
 *        with severity: action_required (operator surface)
 *
 * The actual queue + DO wiring (binding lookups, the broker call site,
 * DO instance acquisition) is left as a per-integration callback — the
 * SDK doesn't know what `env` shape an integration's Worker exposes.
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
import type { ConnectionContext } from "./connection-context.js";
import {
  SDK_DEFAULT_HOP_BUDGET,
  type FailureReason,
  type HandlerResult,
  type QueueMessage,
  type RuntimeCredential,
} from "./types.js";

/**
 * Minimal Cloudflare Queue producer shape — matches the binding the
 * Worker runtime hands the consumer when a `[[queues.producers]]`
 * entry names a queue. The wrapper only needs `send`; `sendBatch` is
 * unused, and the type is widened across queue families so a single
 * `dlqProducerFor` can route by message kind.
 */
export interface DlqProducer {
  send(
    body: unknown,
    options?: { contentType?: "json" | "text" | "v8" },
  ): Promise<void>;
}

export interface ConsumerEnvironment {
  /** Base URL of the Marfa server. */
  apiUrl: string;
  /** Per-Connection storage adapter — usually obtained by stubbing
   *  the integration Worker's DO via
   *  `env.PER_CONNECTION_STATE.idFromName(connection_id).storage`. */
  storageFor: (connectionId: string) => CursorStorageAdapter;
  /** Mints (or refreshes) the per-Connection runtime credential via
   *  the control-plane lease broker. Throws `ConnectionGoneError` when
   *  the broker reports the Connection missing or inactive. */
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
}

interface ConsumeOutcome {
  acked: number;
  retried: number;
  failed: number;
}

/** Build a ConnectionContext for a single message. Exported for
 *  per-integration tests that want to exercise handlers via the same
 *  context the runtime would build. */
export async function buildConnectionContext(
  env: ConsumerEnvironment,
  message: QueueMessage,
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
  return {
    connection_id: message.connection_id,
    integration_name: message.integration_name,
    space_id: message.space_id,
    marfa: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, message.connection_id),
    echo: createEchoSuppression(storage, env.echo),
    mapping: createMappingResolver(client, message.connection_id),
    cycle: cycleParent,
  };
}

/**
 * Maximum exponential-backoff delay (seconds) on a per-message retry.
 * Cloudflare clamps the value internally too; this matches the
 * recommended cap and keeps a runaway exponent from producing absurd
 * delays before the message reaches Cloudflare's max-attempts ceiling
 * and goes to the DLQ.
 */
const MAX_RETRY_DELAY_SECONDS = 60;

/**
 * Compute the next per-message retry delay from `message.attempts`.
 * `attempts` is 1 on first delivery (Cloudflare's `Message.attempts`
 * surface), so a handler-returned `retry: true` on the first attempt
 * stamps `2^0 = 1` second; a second retry is `2^1 = 2`; etc., capped
 * at `MAX_RETRY_DELAY_SECONDS`.
 */
function backoffSecondsFor(attempts: number): number {
  // Math.max guards against `attempts === 0` from a misbehaving runtime
  // — Cloudflare's contract is "first delivery is attempts === 1".
  const exponent = Math.max(0, attempts - 1);
  return Math.min(2 ** exponent, MAX_RETRY_DELAY_SECONDS);
}

/**
 * Process a Cloudflare Queue batch with per-message ack/retry.
 *
 * A single batch-level verdict would make Cloudflare retry the WHOLE
 * batch on any retry, re-running messages that already succeeded — a
 * source of duplicate-write hazards. Per-message ack — `Message.ack()`
 * and `Message.retry({ delaySeconds })` — closes the hazard at its
 * source: a partial-batch failure only retries the failures.
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
 *     persistent programming error — Cloudflare's max-attempts ceiling
 *     would otherwise route the message to the DLQ after a long delay
 *     of repeating the same bad path.
 *   - Envelope-filter / space-mismatch / hop-budget overflow →
 *     `msg.ack()` (acked counter). These messages aren't ours to
 *     process; acking lets Cloudflare drop them from the queue.
 *   - **`ConnectionGoneError`** → `msg.ack()`, plus `disarmSchedule()`
 *     when the message is a `schedule`. The Connection no longer exists
 *     (or is no longer active), so no amount of retrying helps. For a
 *     schedule message, cancel the per-Connection alarm too: it re-arms
 *     itself on every fire, so leaving it running means an orphaned
 *     schedule ticks forever against nothing. Other message kinds ack
 *     without touching the alarm — they carry no evidence about it.
 *
 * `outcome` counters are for telemetry. The function never throws; per-message
 * `retry()` informs Cloudflare directly.
 */
export async function consumeBatch(
  env: ConsumerEnvironment,
  messages: Message<QueueMessage>[],
): Promise<ConsumeOutcome> {
  const outcome: ConsumeOutcome = { acked: 0, retried: 0, failed: 0 };
  const hopBudget = env.hopBudget ?? SDK_DEFAULT_HOP_BUDGET;

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
          summary: `Reactive event dropped — cycle hop budget (${String(hopBudget)}) reached at the SDK boundary`,
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
    let result: HandlerResult;
    let dispatchThrew = false;
    // Captured separately so the DLQ stamp uses the bare error message +
    // class name. result.reason carries a "dispatch_threw: ..." prefix for
    // the activity-emit path; the DLQ path wants the raw message to avoid
    // a double-prefix in the flattened operator string.
    let thrownClassName: string | null = null;
    let thrownMessage: string | null = null;
    try {
      ctx = await buildConnectionContext(env, message);
      result = await dispatchMessage(ctx, message);
      // Deliberate mapping skips surface as one summary row per run, and
      // this is the per-run boundary on this substrate. Best-effort: a
      // summary that cannot land must not fail the dispatch it describes.
      try {
        await ctx.mapping.flushSkipSummary(ctx.activity);
      } catch {
        // The skip count resets either way; the run's own result stands.
      }
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
    }

    if (result.ok) {
      msg.ack();
      outcome.acked++;
      continue;
    }

    // A throw on the first attempt is treated as transient — give the
    // handler one retry to recover. A throw on a retried attempt
    // (attempts > 1) is treated as a persistent programming error and
    // acked-and-logged so it doesn't loop until Cloudflare's max-
    // attempts ceiling hits the DLQ.
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
