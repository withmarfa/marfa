/**
 * Supervisor for the local integrations runtime.
 *
 * The supervisor is the cross-cutting orchestrator that ties together
 * pg-boss (scheduling + queue), the executor (worker_thread pool +
 * direct-dispatch test seam), the connection walker (cron → per-Connection
 * fanout), and the per-Connection state plumbing (cursor / activity
 * delta merge under a Postgres advisory lock).
 *
 * Per dispatch:
 *   1. take coordination lock `connection-dispatch:<connection_id>` —
 *      serializes one execution per Connection at a time, matching the
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
 * `consumeBatch`, which the runtime SDK publishes for anyone driving
 * dispatch from outside the server process. Nothing in this repository
 * calls it; this supervisor is the in-process path.
 */
import {
  SDK_DEFAULT_HOP_BUDGET,
  type HandlerResult,
  type QueueMessage,
} from "@withmarfa/runtime-sdk";
import type { Item } from "@withmarfa/shared";
import { log } from "../../middleware/logger.js";
import { resolveHopBudget } from "../../pubsub.js";
import type { Storage } from "../../storage/interface.js";
import {
  mintLocalRuntimeCredential,
  DISPATCH_JOB_EXPIRY_SECONDS,
} from "./credentials.js";
import type { Executor } from "./executor.js";
import {
  applyCursorDelta,
  readConnectionRuntimeState,
  recordRuntimeError,
} from "./pg-cursor-store.js";
import { stampSyncSuccess, stampSyncFailure } from "./connection-timings.js";
import type {
  LocalIntegrationRegistration,
  LocalRuntime,
  SchedulerEnvelope,
  WorkerDispatchRequest,
  WorkerDispatchResponse,
} from "./types.js";
import { fanOutSchedule } from "./walker.js";
import type { PgBoss } from "pg-boss";

export const QUEUE_NAME = "marfa.integrations.local";
const SCHEDULE_PREFIX = "marfa.integrations.local.schedule.";
export const DEAD_LETTER_QUEUE = "marfa.integrations.local.deadletter";

/** pg-boss 12 restricts queue and schedule names to `[A-Za-z0-9_.\-/]` and
 *  throws on anything else. Map stray characters (a `:` or space in an
 *  integration name) to `_` so a future integration name can't crash the
 *  runtime at boot. */
export function sanitizeQueueName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.\-/]/g, "_");
}

export interface SupervisorConfig {
  apiUrl: string;
  apiKeySalt: string;
  /** Whether this deployment has spaces. Threaded into the mint so a
   *  Connection with no space cannot produce a platform-tier credential
   *  on a multi-space instance. */
  authMode: "hosted" | "keys";
  registrations: LocalIntegrationRegistration[];
  executor: Executor;
  /** Optional pg-boss handle. Tests omit this and call
   *  `dispatchForTest` to drive messages without booting the queue. */
  boss?: PgBoss | null;
  /** Worker concurrency hint for pg-boss. Defaults to a small value;
   *  per-Connection serialization is enforced via the advisory lock
   *  regardless. */
  workerBatchSize?: number;
  /** When `false`, `start()` creates the queues but registers no
   *  pg-boss workers and seeds no schedule crons — the enqueue-only
   *  shape the web role runs, keeping dispatch pinned to the worker
   *  role. Defaults to `true` (the single-process shape). */
  registerWorkers?: boolean;
}

export function createSupervisor(
  storage: Storage,
  config: SupervisorConfig,
): LocalRuntime {
  // A dispatch's `integration_name` comes from the manifest FROZEN on the
  // connection's catalog row, so this map is where a stored name meets the
  // running build. A miss is not an error — `dispatchOne` acks and skips an
  // unknown integration, so a connection whose stored name no longer matches
  // simply stops, with nothing logged and no activity row to find it by.
  const byName = new Map<string, LocalIntegrationRegistration>();
  for (const r of config.registrations) {
    byName.set(r.name, r);
  }
  let started = false;
  let stopped = false;

  /** Dispatch a single message through the per-Connection lock + the
   *  executor; apply the side effects. Returns the HandlerResult for
   *  tests; the queue consumer ignores the result (translation is
   *  inside this function).
   *
   *  `attempt` is the zero-based redelivery count, used to decide
   *  whether a handler throw still earns a retry. */
  async function dispatchOne(
    envelope: SchedulerEnvelope,
    attempt = 0,
  ): Promise<HandlerResult> {
    const registration = byName.get(envelope.integration_name);
    if (!registration) {
      // Unknown integration — ack and skip, mirroring the hosted substrate.
      return { ok: true };
    }
    const message = envelope.message;
    const lockName = `connection-dispatch:${message.connection_id}`;
    // Ack over-budget item-event messages before the lock dance.
    //
    // Resolved per space rather than taken from the SDK constant. The bus
    // already resolves it that way, so a constant here silently capped the
    // space's setting at the default: an operator raising the budget got
    // events past the bus and dropped at this boundary, with the activity row
    // naming a number they had not chosen. The lookup is the same 30-second
    // per-space cache the publish path uses.
    const hopBudget =
      message.kind === "item-event"
        ? await resolveHopBudget(message.space_id)
        : SDK_DEFAULT_HOP_BUDGET;
    if (message.kind === "item-event" && message.cycle.hop_count >= hopBudget) {
      await emitHopBudgetActivity(message, hopBudget);
      return { ok: true };
    }

    const result = await storage.coordination.withJobLock(
      lockName,
      async () => {
        // The gate that survives any stale cache upstream: whatever
        // enqueued this message, a paused connection dispatches nothing.
        // The verdict differs by kind. Schedule ticks and item events are
        // ongoing streams — dropping the queued residue is semantically a
        // no-op, so they ack cleanly. A webhook delivery is a one-off the
        // sender already handed over (the receipt route refuses NEW
        // deliveries while paused, but this one predates the pause), so
        // it retries instead: resume inside the retry ladder and it
        // dispatches; outlast the ladder and it lands on the dead-letter
        // surface, visible and replayable rather than silently gone.
        const target = await storage.items.get(message.connection_id);
        if (
          target?.type === "system.connection" &&
          (target.properties as { runtime_status?: string }).runtime_status ===
            "paused"
        ) {
          if (message.kind === "webhook") {
            return {
              ok: false as const,
              retry: true,
              reason: "connection_paused",
            };
          }
          return { ok: true as const };
        }
        // The only mint in this file, and it runs inside
        // `connection-dispatch:<id>`, which is what makes retiring the
        // connection's other credentials safe: no earlier dispatch on it can
        // still be running.
        const credential = await mintLocalRuntimeCredential(
          storage,
          config.apiKeySalt,
          message.connection_id,
          config.authMode,
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
          ...(message.space_id !== undefined && {
            spaceId: message.space_id,
          }),
          hopBudget,
          cursorSnapshot: state.cursors,
        };
        const response = await config.executor.dispatch(registration, request);
        // Apply cursor delta regardless of result — next dispatch must see these writes.
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
        const result = effectiveResult(response, attempt);
        await postProcess(message, response, result);
        return result;
      },
    );
    // withJobLock returns undefined when another instance holds the lock —
    // treat as ok-and-retry-soon (same semantics as the hosted substrate).
    return result ?? { ok: true };
  }

  /**
   * A handler throw on the first delivery is treated as transient and
   * earns one retry; a throw on a redelivery is a persistent programming
   * error and goes terminal rather than burning the whole retry ladder.
   * Mirrors `consumeBatch`'s first-attempt-throw rule on the hosted
   * substrate, which is the semantic `WorkerDispatchResponse.threw`
   * exists to carry.
   */
  function effectiveResult(
    response: WorkerDispatchResponse,
    attempt: number,
  ): HandlerResult {
    const result = response.result;
    if (result.ok || result.retry || !response.threw || attempt > 0) {
      return result;
    }
    return { ok: false, retry: true, reason: result.reason };
  }

  async function postProcess(
    message: QueueMessage,
    response: WorkerDispatchResponse,
    result: HandlerResult,
  ): Promise<void> {
    if (result.ok) {
      // Only a run that means "sync" records one. An item-event dispatch is
      // a reaction, not a sync run, and stamping every one of them would
      // both misreport the field and put a write behind every reactive
      // event at whatever rate the space produces them.
      if (message.kind === "schedule" || message.kind === "manual") {
        await stampSyncSuccess(
          storage,
          message.connection_id,
          message.space_id,
          Date.now(),
        );
      }
      return;
    }
    // { ok: false, retry: true } propagates back as a throw so pg-boss applies
    // its retry policy and dead-letters after the limit (see the dead-letter
    // worker in start()). Non-retryable failures are terminal now — record them.
    if (!result.retry) {
      await recordTerminalFailure(
        message,
        response.thrownMessage ?? result.reason,
        response.thrownClassName ?? "HandlerResult",
      );
    }
  }

  /** Record a terminal dispatch failure: a `recent_errors` tail entry plus an
   *  `action_required` system.activity the operator can see. Used both for
   *  non-retryable failures and for jobs that exhaust pg-boss retries. */
  async function recordTerminalFailure(
    message: QueueMessage,
    reasonMessage: string,
    className: string,
  ): Promise<void> {
    const failedAtMs = Date.now();
    await recordRuntimeError(storage, message.connection_id, {
      timestamp_ms: failedAtMs,
      reason: reasonMessage,
      message_kind: message.kind,
    }).catch(() => undefined);
    await stampSyncFailure(
      storage,
      message.connection_id,
      message.space_id,
      failedAtMs,
    );
    await emitActivity(message.connection_id, message.space_id, {
      severity: "action_required",
      summary: `Permanent failure handling ${message.kind} message (local runtime)`,
      detail: {
        reason: reasonMessage,
        connection_id: message.connection_id,
        class_name: className,
      },
    });
  }

  /**
   * Write a `system.activity` row for the connection, without a credential.
   *
   * These rows record something the runtime did *to* a message rather than
   * something a handler did, so there is no handler holding a credential to
   * write through and no reason to mint one. Minting here used to retire the
   * connection's other credentials, including the one a dispatch was holding
   * at the time, and the bearer gate refuses a revoked credential exactly as
   * it refuses an expired one, so the dispatch took 401s partway through
   * with nothing logged where the revocation happened.
   *
   * Not minting a non-superseding credential instead: both callers fire on
   * message traffic rather than on dispatches, so nothing retires what they
   * leave until the connection's next dispatch, and the reaper does not help
   * because it only marks credentials already past their expiry. A connection
   * taking a burst of at-budget reactive events would hold every credential
   * it minted for a full TTL.
   *
   * The route stamps `tier: "feed"` on a connection that opted into feed
   * surfacing, so this does too. Skipping it would take exactly the two rows
   * an operator turns that toggle on for out of the feed, while a handler's
   * own rows kept arriving.
   *
   * Two differences from the route are accepted rather than reproduced. The
   * row carries no `source`, because that came from the credential, and
   * nothing keys off it. And a connection that is no longer active gets a
   * row where the mint would have refused one: the dead-letter worker
   * draining jobs queued before an uninstall now says so, which is better
   * than the silence it used to produce.
   */
  async function emitActivity(
    connectionId: string,
    spaceId: string | undefined,
    activity: {
      severity: "info" | "warning" | "error" | "action_required";
      summary: string;
      detail: Record<string, unknown>;
    },
  ): Promise<void> {
    // Read for the connection's own space and its feed preference. The
    // message's space is not a substitute: a manual run carries the
    // caller's space, and a platform admin has none, so keying on it would
    // drop the row for an in-space connection somebody ran by hand.
    //
    // Failing this read must not cost the row. It decides a tier stamp and
    // a fallback space, and on the hop-budget path the row is the only
    // record there is.
    let connection: Item | null = null;
    try {
      connection = await storage.items.get(connectionId);
    } catch {
      // Fall through with what the caller gave us.
    }
    const props =
      connection?.type === "system.connection"
        ? (connection.properties as {
            feed_activity?: unknown;
          })
        : undefined;
    const effectiveSpace = connection?.space_id ?? spaceId;

    // A hosted credential could not be minted for a space-less connection,
    // so this path wrote nothing for one and there is no reason to start.
    // Such a connection is undispatchable anyway, and the row would be
    // invisible to every in-space reader.
    if (config.authMode === "hosted" && effectiveSpace == null) return;

    try {
      await storage.items.create(
        {
          type: "system.activity",
          properties: {
            connection_id: connectionId,
            severity: activity.severity,
            summary: activity.summary,
            detail: activity.detail,
          },
          ...(props?.feed_activity === true ? { tier: "feed" as const } : {}),
        },
        effectiveSpace ?? undefined,
      );
    } catch (err) {
      // Best-effort, but not silent. For a hop-budget drop this row is the
      // only record there is: the publish path writes its own row only
      // above the budget, and an event that reaches this boundary is one it
      // let through, so the two never cover the same event.
      log("error", "Local runtime failed to record an activity row", {
        connection_id: connectionId,
        summary: activity.summary,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Throws so pg-boss applies its retry policy on `{ retry: true }`. */
  async function dispatchForQueue(
    envelope: SchedulerEnvelope,
    attempt = 0,
  ): Promise<void> {
    const result = await dispatchOne(envelope, attempt);
    if (!result.ok && result.retry) {
      throw new Error(`retryable: ${result.reason}`);
    }
  }

  async function emitHopBudgetActivity(
    message: Extract<QueueMessage, { kind: "item-event" }>,
    hopBudget: number,
  ): Promise<void> {
    // Not a duplicate of the publish path's overflow row. That one fires
    // only above the budget and names the originating connection; this
    // boundary drops at it and names the receiving one, so an event
    // reaching here is one the publish path let through and wrote nothing
    // for.
    await emitActivity(message.connection_id, message.space_id, {
      severity: "error",
      summary: `Reactive event dropped: cycle hop budget (${String(hopBudget)}) reached at the local-runtime boundary`,
      detail: {
        connection_id: message.connection_id,
        originating_connection_id: message.cycle.originating_connection_id,
        hop_count: message.cycle.hop_count,
      },
    });
  }

  const runtime: LocalRuntime = {
    async start() {
      if (started) return;
      started = true;
      if (!config.boss) return;
      const boss = config.boss;
      // The dead-letter queue must exist before the dispatch queue can name it.
      await boss.createQueue(DEAD_LETTER_QUEUE);
      // Retries are opt-out in pg-boss 12 (default limit 2). Make the policy
      // explicit and dead-letter exhausted jobs so a persistently failing sync
      // surfaces to the operator instead of silently vanishing.
      // `expireInSeconds` is pinned rather than inherited: the runtime
      // credential minted per dispatch is sized to outlive this bound, and
      // the local substrate cannot refresh a credential mid-run. Leaving it
      // to a library default would let that default drift out from under the
      // credential TTL and start killing long dispatches. Same value
      // pg-boss uses today, so pinning changes no behavior.
      await boss.createQueue(QUEUE_NAME, {
        retryLimit: 3,
        retryBackoff: true,
        expireInSeconds: DISPATCH_JOB_EXPIRY_SECONDS,
        deadLetter: DEAD_LETTER_QUEUE,
      });
      // Enqueue-only mode: the queues exist (an enqueue needs somewhere to
      // land) but no workers are registered and no schedule crons are
      // seeded, so dispatch runs only in the process that opted in. The
      // web role uses this to keep the webhook receipt route and the
      // reactive bridge's enqueue side without ever executing a handler.
      if (config.registerWorkers === false) return;
      const batchSize = config.workerBatchSize ?? 4;
      // `includeMetadata` carries `retryCount`, which the throw-retry rule
      // needs to tell a first delivery from a redelivery.
      await boss.work<SchedulerEnvelope>(
        QUEUE_NAME,
        { batchSize, pollingIntervalSeconds: 2, includeMetadata: true },
        async (jobs) => {
          for (const job of jobs) {
            await dispatchForQueue(job.data, job.retryCount);
          }
        },
      );
      // Jobs that exhaust their retries land on the dead-letter queue carrying
      // their original payload; record the terminal failure for the operator.
      await boss.work<SchedulerEnvelope>(
        DEAD_LETTER_QUEUE,
        { batchSize: 1, pollingIntervalSeconds: 5 },
        async (jobs) => {
          for (const job of jobs) {
            await recordTerminalFailure(
              job.data.message,
              "Exhausted retries (local runtime)",
              "DeadLetter",
            );
          }
        },
      );
      for (const reg of config.registrations) {
        if (!reg.scheduleCron) continue;
        const scheduleName = sanitizeQueueName(SCHEDULE_PREFIX + reg.name);
        // Stately: at most one queued tick per state. pg-boss's timekeeper
        // fires crons from any process that started the boss — including a
        // web-role copy that registered no workers — so with the worker
        // down the ticks keep arriving. Every tick is the same "fan out
        // now" trigger, so collapsing the backlog to one pending job is
        // the correct semantics; an unbounded queue would make the
        // returning worker replay hours of identical fan-outs.
        await boss.createQueue(scheduleName, { policy: "stately" });
        await boss.work(scheduleName, { batchSize: 1 }, async () => {
          await fanOutSchedule(
            storage,
            runtime,
            reg.name,
            Date.now(),
            reg.scheduleCron,
          );
        });
        await boss.schedule(scheduleName, reg.scheduleCron);
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (config.boss) {
        // Unschedule deletes the cron rows cluster-wide, so only the
        // process that seeded them may tear them down — an enqueue-only
        // copy shutting down must not strip the worker's schedules out
        // from under it.
        if (config.registerWorkers !== false) {
          try {
            for (const reg of config.registrations) {
              if (!reg.scheduleCron) continue;
              await config.boss.unschedule(
                sanitizeQueueName(SCHEDULE_PREFIX + reg.name),
              );
            }
          } catch {
            // Best-effort on shutdown.
          }
        }
        await config.boss.stop({ graceful: true, timeout: 5_000 });
      }
      await config.executor.terminate();
    },
    async enqueue(envelope) {
      if (!config.boss) {
        // No queue (test path or no-boss operator mode) — run synchronously.
        // Enqueue-only mode has no synchronous fallback to fall to: running
        // the dispatch here would execute a handler in a process whose role
        // says it must not. Unreachable in production (a Postgres boot
        // always has a boss), so this is a contract guard, not a code path.
        if (config.registerWorkers === false) {
          throw new Error(
            "enqueue-only runtime has no boss to enqueue onto; dispatching synchronously would violate the role split",
          );
        }
        await dispatchForQueue(envelope);
        return;
      }
      await config.boss.send(QUEUE_NAME, envelope);
    },
    async dispatchForTest(envelope, attempt = 0) {
      return dispatchOne(envelope, attempt);
    },
    getRegistration(name) {
      return byName.get(name);
    },
  };
  return runtime;
}
