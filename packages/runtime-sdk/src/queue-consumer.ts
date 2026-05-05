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
  const client = new ConnectionClient({
    apiUrl: env.apiUrl,
    credential,
    refreshCredential: () => env.mintCredential(message.connection_id),
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
    cycle: message.kind === "item-event" ? message.cycle : null,
  };
}

/** Process a Cloudflare Queue batch. Each message is dispatched
 *  independently. Throws iff at least one handler returned
 *  { retry: true } — Cloudflare then retries the whole batch (the SDK
 *  does not currently use per-message ack; that requires the
 *  MessageBatch API which lands in a follow-up). */
export async function consumeBatch(
  env: ConsumerEnvironment,
  messages: QueueMessage[],
): Promise<ConsumeOutcome> {
  const outcome: ConsumeOutcome = { acked: 0, retried: 0, failed: 0 };
  let retryRequested = false;

  const hopBudget = env.hopBudget ?? SDK_DEFAULT_HOP_BUDGET;

  for (const message of messages) {
    if (message.integration_name !== env.integrationName) {
      // Envelope filter — the queue is shared across integrations.
      // Skip messages addressed to other integrations.
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
      outcome.acked++;
      continue;
    }
    // T-008: SDK-side cycle-budget refusal. The server drops events past
    // its own budget before they hit the queue, but a non-pubsub queue
    // producer could enqueue without applying the gate. Refuse here as
    // a defensive ceiling and surface the failure as an action_required
    // activity so an operator can see the loop.
    if (message.kind === "item-event" && message.cycle.hop_count >= hopBudget) {
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
    let result: HandlerResult;
    try {
      const ctx = await buildConnectionContext(env, message);
      result = await dispatchMessage(ctx, message);
    } catch (err) {
      result = {
        ok: false,
        retry: true,
        reason: `dispatch_threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (result.ok) {
      outcome.acked++;
    } else if (result.retry) {
      outcome.retried++;
      retryRequested = true;
    } else {
      // Permanent failure — try to record an action_required activity
      // so an operator can see the failure in the inbox. Failure to
      // emit the activity is non-fatal; the queue ack still happens.
      outcome.failed++;
      try {
        const ctx = await buildConnectionContext(env, message);
        await ctx.activity.emit({
          severity: "action_required",
          summary: `Permanent failure handling ${message.kind} message`,
          detail: {
            reason: result.reason,
            connection_id: message.connection_id,
          },
        });
      } catch {
        // Swallow — failing to emit the activity is itself logged at
        // the runtime layer (Cloudflare logs).
      }
    }
  }

  if (retryRequested) {
    throw new QueueRetryRequested(outcome);
  }
  return outcome;
}

export class QueueRetryRequested extends Error {
  readonly outcome: ConsumeOutcome;
  constructor(outcome: ConsumeOutcome) {
    super(
      `${String(outcome.retried)} of ${String(
        outcome.acked + outcome.retried + outcome.failed,
      )} messages requested retry`,
    );
    this.name = "QueueRetryRequested";
    this.outcome = outcome;
  }
}
