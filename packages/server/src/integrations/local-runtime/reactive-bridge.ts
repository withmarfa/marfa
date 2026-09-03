/**
 * In-process reactive-run bridge for the local runtime.
 *
 * Drains the in-process pubsub and pushes envelopes onto the local
 * pg-boss queue — the seam between "an item changed" and "the
 * subscribing integrations hear about it".
 *
 * The bridge reuses the `evaluateDispatch` + `buildQueueMessageBody`
 * helpers from `envelope.ts` so the per-subscriber gate (system-type,
 * self-event, cross-space, type-not-targeted) decides every event. The
 * substrate-specific piece is the send step.
 *
 * Deletes go through that gate like anything else. They used to be dropped
 * one line above it, which meant a bidirectional integration declaring
 * `tombstone_mapping` could never hear a Marfa-side delete and its
 * delete-upstream path was unreachable — while `preview-event` cheerfully
 * reported a dispatch that would never happen. The gate is already
 * delete-safe by construction: an item's type is fixed for its life, so the
 * payload's type is as sound to judge on a delete as on an update.
 */
import {
  emitWake,
  fansOut,
  subscribe,
  type ItemEventWithId,
} from "../../pubsub.js";
import type { Storage } from "../../storage/interface.js";
import {
  buildEntryForConnection,
  buildQueueMessageBody,
  evaluateDispatch,
  type SubscriptionEntry,
} from "../../connections/envelope.js";
import type { ItemEventMessage } from "@withmarfa/runtime-sdk";
import type { LocalRuntime, SchedulerEnvelope } from "./types.js";

const SUBSCRIPTION_LOAD_PAGE_SIZE = 200;

export interface LocalBridgeRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build a reactive-run bridge that drains the pubsub into the local
 * runtime's queue. The bridge runs under a single coordination lock so
 * multi-instance deployments don't fan out twice per event.
 *
 * The bridge is short-circuitable for tests by passing
 * `disableCoordinationLock: true` — the test then calls `start()` and
 * drives events without contending with another harness instance.
 */
const ELECTION_RETRY_MS = 30_000;

export function createLocalReactiveBridge(
  storage: Storage,
  runtime: LocalRuntime,
  options: { disableCoordinationLock?: boolean; electionRetryMs?: number } = {},
): LocalBridgeRuntime {
  const subscriptions = new Map<string, SubscriptionEntry>();
  let running = false;
  let stopRequested = false;
  let drainerIter: AsyncIterator<unknown> | null = null;
  let invalidationIter: AsyncIterator<unknown> | null = null;
  let wakeElectionRetry: (() => void) | null = null;
  const waitBeforeElectionRetry = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeElectionRetry = null;
        resolve();
      }, ms);
      wakeElectionRetry = () => {
        clearTimeout(timer);
        wakeElectionRetry = null;
        resolve();
      };
    });
  let drainerExit: Promise<void> | null = null;

  const refreshConnection = async (connectionId: string): Promise<void> => {
    const item = await storage.items.get(connectionId);
    if (item?.type !== "system.connection") {
      subscriptions.delete(connectionId);
      return;
    }
    const entry = await buildEntryForConnection(storage, {
      id: item.id,
      state: item.state,
      properties: item.properties,
      space_id: item.space_id ?? null,
    });
    if (entry) subscriptions.set(connectionId, entry);
    else subscriptions.delete(connectionId);
  };

  const loadInitial = async (): Promise<void> => {
    let cursor: string | undefined;
    for (;;) {
      const page = await storage.items.list({
        type: "system.connection",
        limit: SUBSCRIPTION_LOAD_PAGE_SIZE,
        cursor,
      });
      for (const connection of page.data) {
        const entry = await buildEntryForConnection(storage, {
          id: connection.id,
          state: connection.state,
          properties: connection.properties,
          space_id: connection.space_id ?? null,
        });
        if (entry) subscriptions.set(connection.id, entry);
      }
      if (!page.has_more || !page.cursor) break;
      cursor = page.cursor;
    }
  };

  const fanoutEvent = async (event: ItemEventWithId): Promise<void> => {
    for (const entry of subscriptions.values()) {
      if (!evaluateDispatch(event, entry).would_dispatch) continue;
      // Skip events targeting integrations we don't have registered. The
      // CF substrate happily routes them across runtime boundaries; the
      // local substrate can't dispatch what it doesn't know about, so
      // the event silently passes here (and continues to fan out on
      // hosted Connections if the deployment runs both substrates).
      if (!runtime.getRegistration(entry.integration_name)) continue;
      const body = buildQueueMessageBody(event, entry);
      const itemEventMessage: ItemEventMessage = {
        kind: "item-event",
        integration_name: body.integration_name,
        connection_id: body.connection_id,
        ...(body.space_id !== undefined && { space_id: body.space_id }),
        event_type: body.event_type,
        item_id: body.item_id,
        cycle: body.cycle,
        payload: body.payload,
      };
      const envelope: SchedulerEnvelope = {
        integration_name: body.integration_name,
        message: itemEventMessage,
      };
      try {
        await runtime.enqueue(envelope);
      } catch (err) {
        console.error(
          "[local-reactive-bridge] enqueue failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  };

  const startInvalidationSubscriber = async (): Promise<void> => {
    const iter = subscribe({ typeFilter: "system.connection" })[
      Symbol.asyncIterator
    ]();
    invalidationIter = iter;
    try {
      for (;;) {
        const next = await iter.next();
        if (next.done) break;
        if (stopRequested) break;
        try {
          await refreshConnection(next.value.item.id);
        } catch (err) {
          console.error(
            "[local-reactive-bridge] invalidation refresh failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } finally {
      invalidationIter = null;
    }
  };

  const runDrainer = async (): Promise<void> => {
    void startInvalidationSubscriber();
    const iter = subscribe()[Symbol.asyncIterator]();
    drainerIter = iter;
    try {
      for (;;) {
        const next = await iter.next();
        if (next.done) break;
        if (stopRequested) break;
        if (!isItemEvent(next.value)) continue;
        // A bulk import declines fan-out by default: it writes thousands
        // of rows in one call, and a reaction per row per subscribed
        // connection is work the caller did not ask for. The row is in the
        // log either way, so nothing is lost that a catch-up cannot see.
        if (!fansOut(next.value)) continue;
        await fanoutEvent(next.value);
      }
    } finally {
      drainerIter = null;
    }
  };

  return {
    async start() {
      if (running) return;
      running = true;
      stopRequested = false;
      try {
        await loadInitial();
      } catch (err) {
        console.error(
          "[local-reactive-bridge] initial load failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (options.disableCoordinationLock) {
        drainerExit = runDrainer().catch((err: unknown) => {
          console.error(
            "[local-reactive-bridge] drainer threw:",
            err instanceof Error ? err.message : String(err),
          );
        });
      } else {
        // The election is retried, never attempted once: a loser that
        // treated the loss as permanent stayed up, healthy and silent
        // for its whole lifetime, and a winner's death left no takeover.
        // Long-lived rather than the tick-shaped try-lock because the
        // holder keeps the lock for the process lifetime, and that
        // primitive reserves from its own single-connection client
        // instead of subtracting a session-pool slot forever.
        const retryMs = options.electionRetryMs ?? ELECTION_RETRY_MS;
        // A closure, not the variable: `stopRequested` flips from stop()
        // across async boundaries the control-flow analysis cannot see.
        const isStopping = (): boolean => stopRequested;
        drainerExit = (async () => {
          for (;;) {
            if (isStopping()) return;
            const outcome = { elected: false };
            try {
              await storage.coordination.withLongLivedJobLock(
                "local-reactive-bridge",
                async () => {
                  outcome.elected = true;
                  await runDrainer();
                },
              );
            } catch (err: unknown) {
              console.error(
                "[local-reactive-bridge] drainer threw:",
                err instanceof Error ? err.message : String(err),
              );
            }
            if (isStopping()) return;
            if (!outcome.elected) {
              console.warn(
                "[local-reactive-bridge] not elected; will retry in",
                retryMs,
                "ms",
              );
            }
            await waitBeforeElectionRetry(retryMs);
          }
        })();
      }
    },
    async stop() {
      stopRequested = true;
      running = false;
      // Wake an instance parked between election attempts, so stop() is
      // not held for the length of a retry window.
      wakeElectionRetry?.();
      subscriptions.clear();
      // Wake the iterators before returning them: `iterator.return()`
      // alone cannot unwind a generator suspended on an event that never
      // comes, so on a quiescent process stop() parked forever and the
      // drainer's coordination reservation was only ever severed by the
      // forced pool end at storage close — every shutdown burned the
      // bridge-stop budget. Same sentinel shape as the hosted bridge:
      // emitWake, not publish, because a wake is process-local and must
      // neither persist nor replicate a fabricated event.
      try {
        emitWake({
          type: "updated",
          item: {
            id: "stop-sentinel",
            type: "system.connection",
            state: "active",
            tier: "library",
            properties: {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            timestamp: new Date().toISOString(),
            version: 1,
            schema_version: 1,
            source: "stop-sentinel",
          } as unknown as ItemEventWithId["item"],
          originatingConnectionId: null,
          hopCount: 0,
        });
      } catch {
        // Best-effort wakeup — never crash stop().
      }
      const drainer = drainerIter;
      const invalidation = invalidationIter;
      drainerIter = null;
      invalidationIter = null;
      const releases: Promise<unknown>[] = [];
      if (drainer?.return) {
        releases.push(drainer.return().catch(() => undefined));
      }
      if (invalidation?.return) {
        releases.push(invalidation.return().catch(() => undefined));
      }
      await Promise.all(releases);
      const exit = drainerExit;
      drainerExit = null;
      if (exit) await exit;
    },
  };
}

function isItemEvent(event: {
  type: string;
  item?: { id?: string };
}): event is ItemEventWithId {
  return (
    typeof event.item?.id === "string" &&
    (event.type === "created" ||
      event.type === "updated" ||
      event.type === "deleted" ||
      event.type === "restored" ||
      event.type === "state_changed")
  );
}
