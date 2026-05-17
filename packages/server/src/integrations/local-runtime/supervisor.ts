/**
 * Supervisor for the local integrations runtime (T-173).
 *
 * The supervisor is the cross-cutting orchestrator that ties together
 * pg-boss (scheduling + queue), the executor (worker_thread pool +
 * direct-dispatch test seam), the connection walker (cron → per-Connection
 * fanout), and the per-Connection state plumbing (cursor / activity
 * delta merge under a Postgres advisory lock).
 *
 * Per dispatch:
 *   1. take coordination lock `connection-dispatch:<connection_id>` —
 *      serialises one execution per Connection at a time, matching the
 *      single-writer guarantee Cloudflare DOs give for free.
 *   2. mint a runtime credential via the credentials short-circuit (no
 *      HTTP round-trip; the SDK still calls `refreshCredential` per
 *      dispatch).
 *   3. snapshot per-Connection cursors from the `connection.runtime`
 *      extension.
 *   4. ship the request to the executor (worker_thread or directDispatch).
 *   5. apply cursor delta + activity emission via the supervisor's
 *      retry/dlq translation; record permanent failures in the
 *      `recent_errors` tail.
 *
 * The retry / dlq semantics mirror `runtime-sdk/queue-consumer.ts`'s
 * `consumeBatch` (which the hosted substrate runs). Documented in the
 * parity sheet.
 */
import {
  ConnectionClient,
  createActivitySink,
  SDK_DEFAULT_HOP_BUDGET,
  type FailureReason,
  type HandlerResult,
  type QueueMessage,
} from "@mymehq/runtime-sdk";
import type { Storage } from "../../storage/interface.js";
import { mintLocalRuntimeCredential } from "./credentials.js";
import type { Executor } from "./executor.js";
import {
  applyCursorDelta,
  readConnectionRuntimeState,
  recordRuntimeError,
} from "./pg-cursor-store.js";
import type {
  LocalIntegrationRegistration,
  LocalRuntime,
  SchedulerEnvelope,
  WorkerDispatchRequest,
  WorkerDispatchResponse,
} from "./types.js";
import { fanOutSchedule } from "./walker.js";
import type { PgBoss } from "./pg-boss-types.js";

const QUEUE_NAME = "myme.integrations.local";
const SCHEDULE_PREFIX = "myme.integrations.local.schedule:";

export interface SupervisorConfig {
  apiUrl: string;
  apiKeySalt: string;
  registrations: LocalIntegrationRegistration[];
  executor: Executor;
  /** Optional pg-boss handle. Tests omit this and call
   *  `dispatchForTest` to drive messages without booting the queue. */
  boss?: PgBoss | null;
  /** Worker concurrency hint for pg-boss. Defaults to a small value;
   *  per-Connection serialisation is enforced via the advisory lock
   *  regardless. */
  workerBatchSize?: number;
}

export function createSupervisor(
  storage: Storage,
  config: SupervisorConfig,
): LocalRuntime {
  const byName = new Map<string, LocalIntegrationRegistration>(
    config.registrations.map((r) => [r.name, r]),
  );
  let started = false;
  let stopped = false;

  /** Dispatch a single message through the per-Connection lock + the
   *  executor; apply the side effects. Returns the HandlerResult for
   *  tests; the queue consumer ignores the result (translation is
   *  inside this function). */
  async function dispatchOne(
    envelope: SchedulerEnvelope,
  ): Promise<HandlerResult> {
    const registration = byName.get(envelope.integration_name);
    if (!registration) {
      // No registration → ack the message and move on. Matches the
      // hosted substrate's envelope-filter ack.
      return { ok: true };
    }
    const message = envelope.message;
    const lockName = `connection-dispatch:${message.connection_id}`;
    // T-008 SDK-side hop-budget refusal mirrors `consumeBatch`. Item-event
    // messages whose hop_count meets/exceeds the budget get acked here so
    // they don't even enter the lock dance.
    const hopBudget = SDK_DEFAULT_HOP_BUDGET;
    if (message.kind === "item-event" && message.cycle.hop_count >= hopBudget) {
      await emitHopBudgetActivity(message, hopBudget);
      return { ok: true };
    }

    const result = await storage.coordination.withJobLock(
      lockName,
      async () => {
        const credential = await mintLocalRuntimeCredential(
          storage,
          config.apiKeySalt,
          message.connection_id,
        );
        const state = await readConnectionRuntimeState(
          storage,
          message.connection_id,
        );
        const request: WorkerDispatchRequest = {
          apiUrl: config.apiUrl,
          credential,
          message,
          integrationName: registration.name,
          echo: registration.echo,
          ...(message.tenant_id !== undefined && {
            tenantId: message.tenant_id,
          }),
          hopBudget,
          cursorSnapshot: state.cursors,
        };
        const response = await config.executor.dispatch(registration, request);
        // Apply cursor delta first — the next dispatch's snapshot should
        // see the writes whether the result was ok or not.
        if (
          Object.keys(response.cursorUpdates).length > 0 ||
          response.cursorDeletes.length > 0
        ) {
          await applyCursorDelta(
            storage,
            message.connection_id,
            response.cursorUpdates,
            response.cursorDeletes,
          );
        }
        await postProcess(message, response);
        return response.result;
      },
    );
    // `withJobLock` returns undefined when another instance / dispatch
    // holds the lock. Mirror the hosted substrate's "another worker is
    // already processing this" semantics by treating the message as
    // ok-and-retry-soon: the caller (queue consumer) ack-and-moves-on,
    // and the next scheduled fanout / webhook tick picks it up.
    return result ?? { ok: true };
  }

  async function postProcess(
    message: QueueMessage,
    response: WorkerDispatchResponse,
  ): Promise<void> {
    if (response.result.ok) return;
    // Surface permanent failure as a system.activity row + recent_errors
    // tail. Retry semantics are pg-boss's job — the supervisor itself
    // doesn't reschedule a message; instead a `{ ok: false, retry: true
    // }` HandlerResult propagates back through the queue worker as a
    // throw, and pg-boss applies its retry policy.
    if (!response.result.retry) {
      const reason: FailureReason = {
        message: response.thrownMessage ?? response.result.reason,
        class_name: response.thrownClassName ?? "HandlerResult",
        attempts: 1,
        failed_at: new Date().toISOString(),
      };
      await recordRuntimeError(storage, message.connection_id, {
        timestamp_ms: Date.now(),
        reason: reason.message,
        message_kind: message.kind,
      }).catch(() => undefined);
      try {
        const credential = await mintLocalRuntimeCredential(
          storage,
          config.apiKeySalt,
          message.connection_id,
        );
        const client = new ConnectionClient({
          apiUrl: config.apiUrl,
          credential,
          refreshCredential: () => Promise.resolve(credential),
        });
        const activity = createActivitySink(client, message.connection_id);
        await activity.emit({
          severity: "action_required",
          summary: `Permanent failure handling ${message.kind} message (local runtime)`,
          detail: {
            reason: response.result.reason,
            connection_id: message.connection_id,
            class_name: reason.class_name,
          },
        });
      } catch {
        // Best-effort — the recent_errors tail above is the primary
        // operator signal.
      }
    }
  }

  /** Throws so pg-boss applies its retry policy on `{ retry: true }`. */
  async function dispatchForQueue(envelope: SchedulerEnvelope): Promise<void> {
    const result = await dispatchOne(envelope);
    if (!result.ok && result.retry) {
      throw new Error(`retryable: ${result.reason}`);
    }
  }

  async function emitHopBudgetActivity(
    message: Extract<QueueMessage, { kind: "item-event" }>,
    hopBudget: number,
  ): Promise<void> {
    try {
      const credential = await mintLocalRuntimeCredential(
        storage,
        config.apiKeySalt,
        message.connection_id,
      );
      const client = new ConnectionClient({
        apiUrl: config.apiUrl,
        credential,
        refreshCredential: () => Promise.resolve(credential),
      });
      const activity = createActivitySink(client, message.connection_id);
      await activity.emit({
        severity: "error",
        summary: `Reactive event dropped — cycle hop budget (${String(hopBudget)}) reached at the local-runtime boundary`,
        detail: {
          connection_id: message.connection_id,
          originating_connection_id: message.cycle.originating_connection_id,
          hop_count: message.cycle.hop_count,
        },
      });
    } catch {
      // Swallow — best-effort.
    }
  }

  const runtime: LocalRuntime = {
    async start() {
      if (started) return;
      started = true;
      if (!config.boss) return;
      const boss = config.boss;
      await boss.createQueue(QUEUE_NAME);
      const batchSize = config.workerBatchSize ?? 4;
      await boss.work<SchedulerEnvelope>(
        QUEUE_NAME,
        { batchSize, pollingIntervalSeconds: 2 },
        async (jobs) => {
          for (const job of jobs) {
            await dispatchForQueue(job.data);
          }
        },
      );
      // Register one schedule per integration that declares a cron.
      for (const reg of config.registrations) {
        if (!reg.scheduleCron) continue;
        const scheduleName = SCHEDULE_PREFIX + reg.name;
        await boss.createQueue(scheduleName);
        // pg-boss invokes the work() callback when the cron fires; the
        // callback fans out to the active local Connections for this
        // integration. No payload needed.
        await boss.work(scheduleName, { batchSize: 1 }, async () => {
          await fanOutSchedule(storage, runtime, reg.name, Date.now());
        });
        await boss.schedule(scheduleName, reg.scheduleCron);
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (config.boss) {
        try {
          for (const reg of config.registrations) {
            if (!reg.scheduleCron) continue;
            await config.boss.unschedule(SCHEDULE_PREFIX + reg.name);
          }
        } catch {
          // Best-effort on shutdown.
        }
        await config.boss.stop({ graceful: true, timeout: 5_000 });
      }
      await config.executor.terminate();
    },
    async enqueue(envelope) {
      if (!config.boss) {
        // No queue → run synchronously. Useful in tests + as the
        // single-process behaviour when an operator wants to verify a
        // dispatch by hand without standing up pg-boss.
        await dispatchForQueue(envelope);
        return;
      }
      await config.boss.send(QUEUE_NAME, envelope);
    },
    async dispatchForTest(envelope) {
      return dispatchOne(envelope);
    },
    getRegistration(name) {
      return byName.get(name);
    },
  };
  return runtime;
}
