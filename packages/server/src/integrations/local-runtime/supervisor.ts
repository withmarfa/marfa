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
  assessChainProgress,
  expiredEchoMarkerKeys,
  nextSlice,
  settleEchoMarkers,
  type Continuation,
  type DispatchResult,
  type QueueMessage,
} from "@withmarfa/runtime-sdk";
import type { Item } from "@withmarfa/shared";
import { log } from "../../middleware/logger.js";
import { resolveHopBudget } from "../../pubsub.js";
import type { Storage } from "../../storage/interface.js";
import {
  mintLocalRuntimeCredential,
  DISPATCH_JOB_EXPIRY_SECONDS,
  DISPATCH_SOFT_LIMIT_MS,
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
import type { Job, JobWithMetadata, PgBoss } from "pg-boss";

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
  /** How many dispatches this process runs at once. Defaults to 2.
   *
   *  Sized against the session connection pool rather than against
   *  throughput. A dispatch takes `connection-dispatch:<id>` and holds a
   *  reserved session connection for its whole run, which is tens of
   *  seconds rather than the milliseconds a job tick holds one.
   *
   *  **That pool holds at most five connections and no setting raises it.**
   *  It is built as `Math.min(maxPoolSize ?? 10, 5)`, so `MARFA_DB_POOL_SIZE`
   *  can only ever lower it; there is no lever that buys more. Five is also
   *  shared with streaming reads, the consent lock and every other job lock,
   *  and one of those is on a request path that turns a lost reservation
   *  into a user-visible refusal. Two is a standing claim of two of the five
   *  for up to the dispatch bound, which leaves room for the rest.
   *
   *  Raising this is therefore a decision about who else goes without, not
   *  a throughput dial with a matching pool setting. Past three, dispatches
   *  start losing the reservation budget and are acked and dropped at a
   *  lock nobody holds.
   *
   *  Per-Connection serialization does not depend on this: the advisory
   *  lock still admits one dispatch per connection whatever the number.
   *
   *  It should also not exceed `MARFA_INTEGRATION_WORKER_THREADS`, which
   *  defaults to 2. Two dispatches of the same integration need two threads
   *  in its pool; with one thread the second is rejected outright rather
   *  than queued, and surfaces as a handler throw on a healthy connection. */
  dispatchConcurrency?: number;
  /** When `false`, `start()` creates the queues but registers no
   *  pg-boss workers and seeds no schedule crons — the enqueue-only
   *  shape the web role runs, keeping dispatch pinned to the worker
   *  role. Defaults to `true` (the single-process shape). */
  registerWorkers?: boolean;
}

/**
 * How many slices one chain may run before the supervisor abandons it.
 *
 * A ceiling ships with the chain mechanism rather than after it. Temporal
 * defaults its equivalent to unlimited and documents that as its own
 * footgun; a chain that parks without advancing produces completed jobs
 * and a stale `last_sync_at`, so nothing on the operator surface reports
 * it and the only symptom is a connection that quietly never finishes.
 *
 * Abandoning is cheap and that is what buys the right to be aggressive:
 * the watermark is committed per page, so the next cron tick starts a
 * fresh chain from wherever the abandoned one reached. Nothing is lost
 * but the slices already spent.
 */
const MAX_SLICES_PER_CHAIN = 200;

/**
 * How long one chain may run in wall clock before it is abandoned.
 *
 * Independent of the slice ceiling because they catch different faults: a
 * fast handler parking in a tight loop trips the slice count, while one
 * making real but hopeless progress against a provider larger than the
 * window trips this. Measured from the chain's start, which is why
 * `started_at_ms` is copied between slices rather than restamped.
 */
const MAX_CHAIN_WALL_CLOCK_MS = 6 * 60 * 60 * 1000;

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
   *  executor; apply the side effects. Returns the dispatch result for
   *  tests; the queue consumer ignores the result (translation is
   *  inside this function).
   *
   *  `attempt` is the zero-based redelivery count, used to decide
   *  whether a handler throw still earns a retry. */
  async function dispatchOne(
    envelope: SchedulerEnvelope,
    attempt = 0,
    jobSignal?: AbortSignal,
  ): Promise<DispatchResult> {
    // Stamped here rather than beside the request built further down,
    // because the queue's bound started running when this function was
    // entered and everything between — the reclaim check, the hop-budget
    // lookup, the lock, the credential mint, the state read — is spent out
    // of the same allowance the handler is asked to stay inside.
    const startedAtMs = Date.now();
    const registration = byName.get(envelope.integration_name);
    if (!registration) {
      // Unknown integration — ack and skip, mirroring the hosted substrate.
      return { ok: true };
    }
    const message = envelope.message;
    // Nothing to do if the job is already gone. pg-boss fails every job id in
    // a batch when that batch's timer fires, so one hung dispatch takes its
    // batch-mates with it and has already caused each of them to be
    // redelivered. Running them here would repeat in full the work the
    // redelivery is about to do — a credential mint, a handler run and a
    // cursor commit apiece — and then discard the result at the check below.
    // The redelivery is what will actually sync this connection, so this is
    // an ack rather than a recorded failure: nothing went wrong with a run
    // that never started.
    if (jobSignal?.aborted === true) {
      log("info", "local runtime skipped a dispatch: its queue job was gone", {
        connection_id: message.connection_id,
        integration_name: envelope.integration_name,
        message_kind: message.kind,
      });
      return { ok: true };
    }
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
        // Two gates on one read, and the terminal one goes first.
        const target = await storage.items.get(message.connection_id);

        // A connection this runtime can never dispatch on again: revoked,
        // trashed, or gone entirely.
        //
        // The predicate is deliberately the same one the mint refuses on,
        // `type` and then `state`, because the defect this closes was the
        // two reading different fields. The pause gate below tests
        // `properties.runtime_status`, and a revoked connection does not
        // carry `paused` there — the terminal write sets that property to
        // `revoked` — so the message sailed past this point, reached the
        // mint, and threw.
        //
        // A throw out of here is not a verdict. It leaves the lock, leaves
        // `dispatchOne`, and reaches pg-boss as a rejected handler, so the
        // job burns the full retry ladder and dead-letters. A dead letter
        // means "this gave up, someone look"; a revoked connection is
        // settled and no operator action changes it, so the row is one
        // nobody can act on, and it degrades `/health` for the external
        // poller while it sits there. Unactionable rows are how a queue
        // stops being read.
        //
        // Every kind acks, webhooks included, and that is where this parts
        // company with the pause gate below. Pause retries a webhook on
        // purpose: resume inside the ladder and it dispatches, outlast the
        // ladder and it lands somewhere a person can replay it. Neither
        // half survives here. A retry cannot succeed against a terminal
        // state, and the dead letter it would eventually produce can never
        // be replayed — which is the row this gate exists to stop writing.
        //
        // Acking silently would trade a bad row for no record at all, so
        // the drop writes an activity row: visible on the connection
        // without being a dead letter. It needs no report-once marker to
        // stay bounded, because every producer already refuses a connection
        // in this state. The schedule walker and the reactive fan-out both
        // filter on `state === "active"`, and the webhook receipt route
        // answers 410 before it enqueues. What arrives here is the residue
        // that was already queued when the connection was revoked, drained
        // once.
        if (target?.type !== "system.connection" || target.state !== "active") {
          await emitUndispatchableActivity(message, target);
          return { ok: true as const };
        }

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
        if (
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
          startedAtMs,
          softLimitMs: DISPATCH_SOFT_LIMIT_MS,
        };
        const response = await config.executor.dispatch(registration, request);
        // Apply cursor delta regardless of result — next dispatch must see
        // these writes. That holds for a reclaimed job too: the writes the run
        // made before its job was taken away are real, and discarding them
        // would make the next run redo work it cannot know was already done.
        // Echo markers are stamped in a worker thread whose writes are
        // not visible to anything until this moment, so their TTL is
        // rebased onto the commit clock before it is applied. Written
        // from the thread's clock, a marker from a long run arrives
        // already expired and the first echo webhook goes straight
        // through — deleting the record on its way past, so nothing is
        // left to show why.
        const committedAtMs = Date.now();
        settleEchoMarkers(response.cursorUpdates, committedAtMs);
        // Both read paths delete a marker they find expired, which bounds
        // what an integration keeps asking about but not what it stops
        // asking about. Sweeping here is what stops one key per outbound
        // write accumulating on a Connection forever.
        // Read from the PRE-dispatch snapshot, so a key this dispatch has
        // just rewritten has to be excluded: `applyCursorDelta` applies
        // updates and then deletes, so a key in both is deleted, and the
        // marker the handler just wrote would be swept by the sweep meant
        // for the one it replaced. The result is no marker at all on the
        // commonest shape there is — a second write to the same external
        // record — and the next echo webhook re-ingests the integration's
        // own change, which is the exact loop this module exists to stop.
        const staleMarkers = expiredEchoMarkerKeys(
          state.cursors,
          committedAtMs,
        ).filter((key) => !(key in response.cursorUpdates));
        const cursorDeletes =
          staleMarkers.length > 0
            ? [...new Set([...response.cursorDeletes, ...staleMarkers])]
            : response.cursorDeletes;
        if (
          Object.keys(response.cursorUpdates).length > 0 ||
          cursorDeletes.length > 0
        ) {
          await applyCursorDelta(
            storage,
            message.connection_id,
            response.cursorUpdates,
            cursorDeletes,
          );
        }
        const result = effectiveResult(response, attempt);
        // A permanent failure survives the reclaim check. It is a statement
        // about the connection rather than about the queue job, so demoting
        // it to a warning would hide a real fault on exactly the connections
        // that overrun every run and therefore reach this branch every time.
        if (jobSignal?.aborted === true && (result.ok || result.retry)) {
          return recordReclaimedDispatch(message, response);
        }
        // A parked sweep is only a park once its successor is on the
        // queue. Enqueuing here — inside the connection lock, after the
        // cursor delta has landed and after the reclaim check — is what
        // makes the chain durable: the next slice cannot start before
        // this one's writes are visible, and nothing else can dispatch
        // this connection in between.
        //
        // After the reclaim check, not before. A reclaimed job has
        // already been handed out again, so the redelivery re-runs this
        // slice and produces its own successor; enqueuing one here as
        // well forks the chain, and both forks carry the same id, so
        // neither looks stale to the straggler check.
        if (result.ok && "done" in result && !result.done) {
          const chainError = await continueChain(
            envelope,
            message,
            result.continuation,
          );
          if (chainError !== null) return chainError;
        }
        // A sweep that answered without saying whether it finished is a
        // handler built against the previous contract. Treating that as
        // finished is what the required discriminant exists to prevent,
        // and `"done" in result` would do exactly that silently — so it
        // is refused here rather than assumed. Loud during the window
        // between this runtime shipping and the integrations moving onto
        // it; silent and wrong forever otherwise.
        if (
          result.ok &&
          !("done" in result) &&
          (message.kind === "schedule" || message.kind === "manual")
        ) {
          const reason =
            "This integration's scheduled handler did not say whether it finished. " +
            "It is built against an older runtime SDK and needs rebuilding against the current one.";
          await recordTerminalFailure(message, reason, "MissingSweepVerdict");
          return { ok: false as const, retry: false, reason };
        }
        await postProcess(message, response, result);
        return result;
      },
    );
    if (result === undefined) {
      // The lock was not acquired, so this message is dropped rather than
      // queued behind whatever holds it. For the usual cause that is the
      // intended shape: another dispatch is doing this connection's work, and
      // a schedule tick or reactive event arriving mid-run duplicates work
      // already in flight.
      //
      // It is deliberately not phrased as "the connection is busy", because
      // `withJobLock` answers `undefined` for two reasons and cannot say
      // which. The other is failing to reserve a session connection inside
      // its budget, where nothing is holding the lock at all and the
      // coordination store logs its own line saying so. Naming one cause here
      // would misattribute the other.
      //
      // No retry follows, despite what this comment claimed for a long time.
      // It is a try-lock and the caller acks, so the message is gone.
      log("info", "local runtime skipped a dispatch: lock not acquired", {
        connection_id: message.connection_id,
        integration_name: envelope.integration_name,
        message_kind: message.kind,
      });
      return { ok: true };
    }
    return result;
  }

  /**
   * The verdict on a dispatch whose queue job was taken away while it ran.
   *
   * pg-boss arms one timer per fetched batch and hands every job in that batch
   * the same `AbortController`. When the timer fires it aborts that controller
   * and fails every job id in the batch. It cannot reach into a worker thread
   * and nothing here terminates one, so the handler carries on and returns
   * normally, sometimes minutes later. By then the job has been failed and
   * redelivered, and the redelivery has been acked at the advisory lock the
   * original still holds, so it is complete. Whatever the handler reports at
   * that point describes work no queue job is waiting for.
   *
   * **The check has to stay inside the `boss.work` callback**, and that is the
   * load-bearing fact rather than anything about when the timer fires. The
   * same controller is aborted in a `finally`, so it is also aborted on the
   * ordinary success path the instant the batch callback resolves, and again
   * on a graceful shutdown. Reading it from inside the callback is what makes
   * an aborted signal mean "this batch lost its jobs" rather than "the batch
   * finished"; reading it from anywhere downstream would call every healthy
   * run a reclaimed one.
   *
   * Trusting it is what made this indistinguishable from a clean sync: the
   * handler returned `{ ok: true }`, `postProcess` stamped `last_sync_at` and
   * cleared `last_error_at`, and nothing recorded that the run had lost its
   * job. Reading the signal rather than timing the dispatch is what makes the
   * check agree with pg-boss: the budget is per batch, not per dispatch, so a
   * stopwatch around one dispatch misses every overrun a batch shares.
   *
   * `stampSyncFailure` is deliberately not called. A sweep too large for one
   * dispatch is the case resumption exists to serve, and it converges: each
   * run commits its cursor and the next starts further on. Reddening the
   * connection on every leg would report a fault where there is progress. The
   * honest signal is the one already there — `last_sync_at` stays stale until
   * a run genuinely finishes — plus the row this writes.
   *
   * The result is not retryable because pg-boss has already redelivered the
   * job; asking for another delivery would duplicate one that exists.
   */
  async function recordReclaimedDispatch(
    message: QueueMessage,
    response: WorkerDispatchResponse,
  ): Promise<DispatchResult> {
    // The handler's own account of the run is still the most useful detail
    // there is, so it rides along rather than being replaced.
    const handlerDetail =
      response.thrownMessage ??
      (response.result.ok ? undefined : response.result.reason);
    const reason =
      "The queue job for this run was reclaimed before the handler returned, " +
      "so its result was discarded" +
      (handlerDetail === undefined
        ? ""
        : `; the handler reported: ${handlerDetail}`);
    await recordRuntimeError(storage, message.connection_id, {
      timestamp_ms: Date.now(),
      reason,
      message_kind: message.kind,
    }).catch(() => undefined);
    await emitActivity(message.connection_id, message.space_id, {
      severity: "warning",
      summary: "Run discarded: its queue job had already been reclaimed",
      detail: {
        reason,
        connection_id: message.connection_id,
        message_kind: message.kind,
      },
    });
    return { ok: false, retry: false, reason };
  }

  /**
   * Put the next slice of a chain on the queue.
   *
   * Returns `null` when the chain continues, or the result the dispatch
   * should report instead when it does not. A caller that ignored the
   * return would ack a park whose successor never landed, which is the
   * silent-unfinished-sync failure this whole mechanism exists to remove.
   */
  async function continueChain(
    envelope: SchedulerEnvelope,
    message: QueueMessage,
    continuation: Continuation,
  ): Promise<DispatchResult | null> {
    if (message.kind !== "schedule" && message.kind !== "manual") {
      // Only a sweep can park; webhook and item-event handlers return
      // `HandlerResult`, which carries no `done`. Unreachable through the
      // types, and loud rather than silent if that ever changes.
      return {
        ok: false,
        retry: false,
        reason: `a ${message.kind} dispatch returned a continuation`,
      };
    }
    const inbound = message.continuation;
    const sliceCount = (inbound?.slice ?? 0) + 1;
    const chainStartedAtMs = inbound?.started_at_ms ?? Date.now();
    const ranForMs = Date.now() - chainStartedAtMs;

    // Checked before the ceilings, because it names the actual fault. A
    // stalled chain would eventually trip the slice count too, but the
    // reason an operator reads would say "stopped after 200 continuations"
    // rather than "stopped making progress", and only one of those points
    // at the handler.
    const stalled = assessChainProgress(inbound, continuation);
    if (stalled !== null) {
      await recordTerminalFailure(message, stalled, "ChainStalled");
      return { ok: false, retry: false, reason: stalled };
    }

    if (
      sliceCount > MAX_SLICES_PER_CHAIN ||
      ranForMs > MAX_CHAIN_WALL_CLOCK_MS
    ) {
      const reason =
        sliceCount > MAX_SLICES_PER_CHAIN
          ? `This sync was stopped after ${String(sliceCount - 1)} continuations without finishing`
          : `This sync was stopped after running for ${String(Math.round(ranForMs / 60_000))} minutes without finishing`;
      // Terminal rather than retryable. The next scheduled tick starts a
      // fresh chain from the committed watermark, so the recovery is
      // automatic; what is needed here is for somebody to be told, since
      // a chain that keeps parking looks like health on every other
      // surface.
      await recordTerminalFailure(message, reason, "ChainCeiling");
      return { ok: false, retry: false, reason };
    }

    const next = nextSlice(message, continuation);
    if (!config.boss) {
      // `runtime.enqueue`'s no-boss fallback dispatches synchronously,
      // which for a chain means each slice calling the next one inside
      // the previous one's stack until a ceiling stops it. Refusing is
      // both safer and more honest: a substrate with no queue cannot run
      // a chain, and saying so beats a recursion that looks like a hang.
      const reason =
        "this runtime has no queue, so a continuation cannot be scheduled";
      await recordTerminalFailure(message, reason, "NoQueue");
      return { ok: false, retry: false, reason };
    }
    try {
      await config.boss.send(
        QUEUE_NAME,
        { integration_name: envelope.integration_name, message: next },
        {
          // Below the default so a continuation never overtakes a fresh
          // webhook delivery. A long chain is background work; a delivery
          // is somebody waiting.
          priority: -1,
          ...(continuation.notBefore !== undefined && {
            startAfter: new Date(continuation.notBefore),
          }),
        },
      );
    } catch (err) {
      // The slice's own writes are already committed, so redelivering it
      // repeats a slice rather than losing the rest of the sweep.
      return {
        ok: false,
        retry: true,
        reason: `could not enqueue the next slice: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return null;
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
  ): DispatchResult {
    const result = response.result;
    if (result.ok || result.retry || !response.threw || attempt > 0) {
      return result;
    }
    return { ok: false, retry: true, reason: result.reason };
  }

  async function postProcess(
    message: QueueMessage,
    response: WorkerDispatchResponse,
    result: DispatchResult,
  ): Promise<void> {
    if (result.ok) {
      // A sweep that parked is not a completed sync, and `ok` alone no
      // longer distinguishes the two. Stamping `last_sync_at` here would
      // reproduce, through the new shape, exactly the defect this
      // substrate was just fixed for: a run that did not finish reporting
      // to the operator surface that it did. The stamp belongs to the
      // slice that returns `done: true`.
      if ("done" in result && !result.done) {
        return;
      }
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
   * Not minting a non-superseding credential instead: the callers that fire
   * on message traffic rather than on dispatches leave nothing to retire them
   * until the connection's next dispatch, and the reaper does not help
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
    jobSignal?: AbortSignal,
  ): Promise<void> {
    const result = await dispatchOne(envelope, attempt, jobSignal);
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

  /**
   * Record a delivery dropped because its connection can no longer be
   * dispatched on at all.
   *
   * `warning` rather than `error`: nothing failed. The connection reached a
   * state it was moved to deliberately and the queued work behind it is
   * being discarded on purpose. It is also not `action_required`, because
   * there is no action — that is the whole reason this stopped being a dead
   * letter.
   *
   * The state is carried on the row rather than folded into one summary,
   * because "revoked" and "the row is gone" arrive here through the same
   * branch and are different things to read afterwards.
   */
  async function emitUndispatchableActivity(
    message: QueueMessage,
    target: Item | null,
  ): Promise<void> {
    const state =
      target === null
        ? "missing"
        : target.type !== "system.connection"
          ? "not-a-connection"
          : target.state;
    await emitActivity(message.connection_id, message.space_id, {
      severity: "warning",
      summary: `Delivery dropped: connection is ${state}, so it cannot be dispatched`,
      detail: {
        connection_id: message.connection_id,
        message_kind: message.kind,
        connection_state: state,
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
      // One job per fetch, and several fetchers rather than one fetcher
      // taking several jobs.
      //
      // A pg-boss batch is settled as a unit, and both halves of that bit.
      // It arms ONE expiry timer for the batch and, on timeout, fails every
      // job id in it — so three dispatches that had already finished were
      // re-queued and re-run because a fourth was still going. And the
      // handler ran the batch as a plain `for ... await`, so one job's
      // throw aborted the loop: the jobs behind it were never attempted,
      // and every one of them was failed carrying the thrower's error.
      // That reached the operator surface, where two dead-letter rows for
      // different connections both named the first connection, sending
      // anyone reading the alert to investigate a healthy one.
      //
      // A batch of one has no siblings to take down, so both disappear
      // rather than being handled. pg-boss's own per-job settlement
      // (`perJobResults`) fixes the throw half but not the timeout half —
      // its own contract says throwing from the handler still fails the
      // whole batch, and a batch timing out is a throw.
      //
      // There IS a throughput cost to a smaller batch, and it is not the
      // fetch round-trip. pg-boss sleeps once per fetch regardless of how
      // many jobs that fetch returned, so a batch of four amortised the
      // poll delay over four jobs and a batch of one does not. Its own
      // remedy is unavailable here: `burstWhenBatchFull` is documented as
      // ignored when `batchSize` is 1, and NOTIFY wake-ups are off.
      //
      // The interval is halved to pay for it, which makes the new shape no
      // slower than the old one at any dispatch duration. Per worker a
      // cycle is `max(duration, interval)` and returns one job, so:
      //
      //   before   4 / max(4d, 2000ms)      one worker, four jobs a fetch
      //   after    2 / max(d, 1000ms)       two workers, one job a fetch
      //
      // At d below the interval both settle at two jobs a second; above it
      // the new shape pulls ahead, because the old one served four jobs
      // strictly one after another. The cost is polling frequency: two
      // workers at one second rather than one at two, so four times the
      // queries against an idle queue. That is the trade, and it is worth
      // it for what it buys — `localConcurrency` defaulted to 1, so a
      // single slow dispatch was fifteen minutes of no dispatch for every
      // integration on the process, not just for its own connection.
      //
      // The durable fix for the polling cost is NOTIFY wake-ups, which
      // this deployment does not enable anywhere yet. Worth doing on its
      // own rather than smuggled in here.
      const dispatchConcurrency = config.dispatchConcurrency ?? 2;
      // `includeMetadata` carries `retryCount`, which the throw-retry rule
      // needs to tell a first delivery from a redelivery.
      //
      // No explicit type argument on either `work` call below, and that is
      // load-bearing rather than style. pg-boss used to carry a dedicated
      // overload for `includeMetadata: true`; 12.21 folded it into one that
      // resolves the handler's job type from the options object instead.
      // Naming a single type argument stops inference for the rest, so the
      // options type falls back to its default, the handler is typed
      // without metadata, and `retryCount` reads as missing while still
      // being delivered. The payload type comes from the handler's own
      // annotation, which lets both infer.
      await boss.work(
        QUEUE_NAME,
        {
          batchSize: 1,
          localConcurrency: dispatchConcurrency,
          pollingIntervalSeconds: 1,
          includeMetadata: true,
        },
        async (jobs: JobWithMetadata<SchedulerEnvelope>[]) => {
          // `batchSize: 1` makes this a single job, and the loop is kept
          // rather than indexed so that raising the batch size can never
          // silently drop the jobs past the first. It stays a `for ...
          // await`: with one job there is nothing to isolate, and running
          // a batch concurrently here would put several dispatches on one
          // shared expiry timer, which is the arrangement this moved away
          // from.
          for (const job of jobs) {
            await dispatchForQueue(job.data, job.retryCount, job.signal);
          }
        },
      );
      // Jobs that exhaust their retries land on the dead-letter queue carrying
      // their original payload; record the terminal failure for the operator.
      await boss.work(
        DEAD_LETTER_QUEUE,
        { batchSize: 1, pollingIntervalSeconds: 5 },
        async (jobs: Job<SchedulerEnvelope>[]) => {
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

      // Retire schedules for integrations this deployment no longer has.
      //
      // Seeding is driven from the registration set and so is the teardown
      // in `stop()`, which means a removed integration's cron row has only
      // ever been cleaned up by luck: the outgoing process has to run the
      // *old* code, still list the integration, and exit gracefully. A hard
      // container stop, a crash, a worker already down at deploy time, or
      // the swallowed error in that teardown all leave the row behind.
      //
      // A left-behind row is not inert. pg-boss's timekeeper fires crons
      // from any process that started the boss, including a web-role copy
      // that registered no workers, so it goes on firing into a queue
      // nothing will ever work again. `stately` caps that at one pending
      // job rather than an unbounded backlog, which is what makes it a leak
      // rather than an outage, but nothing else would ever clear it.
      //
      // Not hypothetical, and not only about the scaffold that prompted it:
      // it recurs every time an integration leaves a deployment, which is
      // exactly what installing and uninstalling packages makes ordinary.
      const wanted = new Set(
        config.registrations
          .filter((reg) => reg.scheduleCron)
          .map((reg) => sanitizeQueueName(SCHEDULE_PREFIX + reg.name)),
      );
      try {
        for (const schedule of await boss.getSchedules()) {
          if (!schedule.name.startsWith(SCHEDULE_PREFIX)) continue;
          if (wanted.has(schedule.name)) continue;
          await boss.unschedule(schedule.name);
          log("info", "retired the schedule of a removed integration", {
            schedule: schedule.name,
          });
        }
      } catch (err) {
        // A failed reconcile must not stop a boot. Everything that should
        // run is already seeded above; what is left is a stale row firing
        // into an unworked queue, which is the state this exists to improve
        // on rather than a reason to refuse to start.
        log("warn", "could not reconcile integration schedules", {
          error: err,
        });
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
    async dispatchForTest(envelope, attempt = 0, jobSignal) {
      return dispatchOne(envelope, attempt, jobSignal);
    },
    getRegistration(name) {
      return byName.get(name);
    },
  };
  return runtime;
}
