/**
 * In-process reactive-run bridge for the local runtime.
 *
 * The Cloudflare bridge (`reactive-run-bridge.ts`) drains the in-process
 * pubsub and POSTs envelopes to Cloudflare Queues. The local-runtime
 * bridge drains the same pubsub but pushes envelopes onto the local
 * pg-boss queue instead — same logical flow, no remote hop.
 *
 * The bridge reuses the `evaluateDispatch` + `buildQueueMessageBody`
 * helpers from `envelope.ts` so the per-subscriber gate (self-event,
 * cross-tenant) is identical to the hosted side. The substrate-specific
 * piece is the send step.
 */
import { subscribe, type ItemEventWithId } from "../../pubsub.js";
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
export function createLocalReactiveBridge(
  storage: Storage,
  runtime: LocalRuntime,
  options: { disableCoordinationLock?: boolean } = {},
): LocalBridgeRuntime {
  const subscriptions = new Map<string, SubscriptionEntry>();
  let running = false;
  let stopRequested = false;
  let drainerIter: AsyncIterator<unknown> | null = null;
  let invalidationIter: AsyncIterator<unknown> | null = null;
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
      tenant_id: item.tenant_id ?? null,
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
          tenant_id: connection.tenant_id ?? null,
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
        ...(body.tenant_id !== undefined && { tenant_id: body.tenant_id }),
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
        if (next.value.type === "deleted") continue;
        if (!isItemEvent(next.value)) continue;
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
      const driver = options.disableCoordinationLock
        ? runDrainer()
        : storage.coordination
            .withJobLock("local-reactive-bridge", runDrainer)
            .then(() => undefined);
      drainerExit = driver.catch((err: unknown) => {
        console.error(
          "[local-reactive-bridge] drainer threw:",
          err instanceof Error ? err.message : String(err),
        );
      });
    },
    async stop() {
      stopRequested = true;
      running = false;
      subscriptions.clear();
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
