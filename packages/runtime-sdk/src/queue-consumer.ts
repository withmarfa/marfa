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
  type HandlerResult,
  type QueueMessage,
  type RuntimeCredential,
} from "./types.js";

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
    try {
      ctx = await buildConnectionContext(env, message);
      result = await dispatchMessage(ctx, message);
    } catch (err) {
      dispatchThrew = true;
      result = {
        ok: false,
        retry: false,
        reason: `dispatch_threw: ${err instanceof Error ? err.message : String(err)}`,
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
    // threw on a retried attempt. Ack the message so it leaves the
    // queue, and best-effort emit an action_required activity so an
    // operator sees the failure in the inbox.
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
