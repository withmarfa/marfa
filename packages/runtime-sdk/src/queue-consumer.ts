/**
 * Queue consumer entry. Per-Integration Workers wire this as the
 * `queue` export in their entrypoint. The consumer:
 *
 *   1. For every message in the batch:
 *      a. Mints / refreshes the per-Connection runtime credential via
 *         the control-plane lease broker (cached on the per-Connection
 *         DO with TTL ≤ 5 min).
 *      b. Builds the ConnectionContext (cursor, activity, echo,
 *         myme client).
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
import {
  createCursorStore,
  type CursorStorageAdapter,
} from "./cursor-store.js";
import { createActivitySink } from "./activity.js";
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
  /** Base URL of the Myme server. */
  apiUrl: string;
  /** Per-Connection storage adapter — usually obtained by stubbing
   *  the integration Worker's DO via
   *  `env.PER_CONNECTION_STATE.idFromName(connection_id).storage`. */
  storageFor: (connectionId: string) => CursorStorageAdapter;
  /** Mints (or refreshes) the per-Connection runtime credential via
   *  the control-plane lease broker. */
  mintCredential: (connectionId: string) => Promise<RuntimeCredential>;
  /** Manifest's bidirectional_handling block — drives echo TTL. */
  echo: { echo_ttl_seconds: number; lag_window_seconds?: number };
  /** Integration name from the manifest (envelope filter). */
  integrationName: string;
  /**
   * Tenant id this Worker instance is scoped to (T-017). Per-Worker stamp
   * configured at deploy time. When set, the consumer cross-checks every
   * incoming `message.tenant_id` against it and acks-and-skips any
   * mismatched message — defence in depth against a misrouted (or
   * maliciously-crafted) cross-tenant message that already passed the
   * `connection_id` gate. Optional only to keep self-host setups where
   * the tenant column is null wire-compatible.
   */
  tenantId?: string;
  /**
   * Defensive ceiling for cycle hop count (T-008). When set, the consumer
   * refuses to dispatch a reactive `item-event` whose `cycle.hop_count`
   * meets or exceeds it. The server already drops over-budget events
   * before they hit the queue, but a non-pubsub producer could enqueue
   * without applying the gate. Defaults to `SDK_DEFAULT_HOP_BUDGET`.
   */
  hopBudget?: number;
  /**
   * Resolve a DLQ producer binding for a given message kind (T-103). On
   * permanent failure the wrapper sends an enriched copy of the message
   * (carrying `_failure_reason`) to the resolved DLQ before acking the
   * original. Returning `null` (or omitting the resolver entirely) keeps
   * the pre-T-103 behaviour: ack + activity emit only, message
   * effectively dropped from operator-peekable surfaces.
   *
   * Routing by `message.kind` (webhook / schedule / item-event) lets a
   * Worker that consumes multiple queue families (e.g. task-auto-archive
   * consumes both `schedule` and `item-event`) wire the matching DLQ for
   * each family.
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
  // T-039: thread the parent cycle into the ConnectionClient so every
  // mutating call back into Myme stamps the cycle headers. Schedule /
  // webhook handlers start a fresh chain (cycleParent: null —
  // `nextHopMetadata` sees it and stamps the connector as the chain
  // head); item-event handlers inherit the parent's cycle from the
  // queue message.
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
    tenant_id: message.tenant_id,
    myme: client,
    cursor: createCursorStore(storage),
    activity: createActivitySink(client, message.connection_id),
    echo: createEchoSuppression(storage, env.echo),
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
 * Process a Cloudflare Queue batch with per-message ack/retry (T-043).
 *
 * Pre-T-043 this function returned a single batch-level verdict and
 * Cloudflare retried the WHOLE batch on any retry, including the
 * messages that already processed successfully. That whole-batch retry
 * is the upstream cause of the duplicate-write hazards T-020 (Calendar
 * outbound) and T-038 (server-side natural-key idempotency) defended
 * against. Per-message ack — `Message.ack()` and `Message.retry({
 * delaySeconds })` — closes the hazard at its source: a partial-batch
 * failure only retries the failures.
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
 *   - Envelope-filter / tenant-mismatch / hop-budget overflow →
 *     `msg.ack()` (acked counter). These messages aren't ours to
 *     process; acking lets Cloudflare drop them from the queue.
 *
 * The `outcome` counters stay populated for telemetry compatibility —
 * existing dashboards keyed on `acked / retried / failed` keep
 * working. The function no longer throws on retry: per-message
 * `retry()` has informed Cloudflare directly.
 *
 * T-020's deterministic-id workaround for outbound Calendar writes
 * stays as belt-and-braces. The contract "createItem with `(source,
 * source_id)` is idempotent" is genuinely useful regardless of queue
 * semantics; per-message ack closes the immediate window without
 * removing the underlying contract.
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
    // T-017: defence-in-depth tenant check. The connection_id gate is
    // the primary line of defence; this is the secondary one. A
    // misrouted message that targets the wrong tenant gets acked and
    // skipped without ever invoking the handler.
    if (
      env.tenantId !== undefined &&
      message.tenant_id !== undefined &&
      message.tenant_id !== env.tenantId
    ) {
      msg.ack();
      outcome.acked++;
      continue;
    }
    // T-008: SDK-side cycle-budget refusal. The server drops events past
    // its own budget before they hit the queue, but a non-pubsub queue
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

    // Build the context once and reuse it on the permanent-failure
    // activity emission. If `buildConnectionContext` itself throws (e.g.
    // the credential mint fails), `ctx` stays null and the activity
    // emission falls back to a fresh build — preserving the old
    // semantics where an unmintable credential surfaces as a retry
    // (since the throw happens inside `dispatchThrew`).
    let ctx: ConnectionContext | null = null;
    let result: HandlerResult;
    let dispatchThrew = false;
    // Captured separately for the `_failure_reason` stamp on permanent
    // failure (T-103). We keep `result.reason` carrying the legacy
    // `"dispatch_threw: ..."` prefix because the activity-emit `detail.reason`
    // path has consumed that shape since T-043; the DLQ-stamp path uses
    // the bare error message + class name so the flattened
    // `<class>: <message> (attempts: <n>)` operator string isn't double-prefixed.
    let thrownClassName: string | null = null;
    let thrownMessage: string | null = null;
    try {
      ctx = await buildConnectionContext(env, message);
      result = await dispatchMessage(ctx, message);
    } catch (err) {
      dispatchThrew = true;
      thrownClassName =
        err instanceof Error ? err.constructor.name || "Error" : "unknown";
      thrownMessage = err instanceof Error ? err.message : String(err);
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

    // Permanent failure — handler returned `retry: false`, OR dispatch
    // threw on a retried attempt. Three best-effort observability steps:
    //
    //   1. Stamp `_failure_reason` and forward to the configured DLQ
    //      producer (T-103). Operators peeking the DLQ via
    //      `cf-queues-pull` see a real reason rather than `null`.
    //   2. Ack the original so it leaves the main queue.
    //   3. Emit an `action_required` activity so the Repairs-style
    //      inbox surfaces the failure.
    //
    // The DLQ forward, ack, and activity emit are independent — a
    // failure in one does not block the others.
    //
    // At-least-once: if the DLQ send succeeds and the ack fails (or vice
    // versa) the original message stays on the main queue and gets
    // redelivered. On redelivery it'll fail again and produce a SECOND
    // DLQ entry. This is intentional — losing the operator surface to a
    // transient ack flake is worse than a duplicate DLQ entry, and the
    // peek route already documents at-least-once semantics elsewhere.
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
      // Reuse the dispatch-time ctx if we have it; only rebuild on the
      // edge case where the original build threw and we still want to
      // surface an activity (rare — the only path is "throw on retried
      // attempt and the rebuild succeeds").
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
      // Swallow — failing to emit the activity is itself logged at
      // the runtime layer (Cloudflare logs).
    }
  }

  return outcome;
}
