/**
 * Cross-process event replication over Postgres LISTEN/NOTIFY.
 *
 * The in-process EventEmitter in pubsub.ts stays the fan-out for
 * everything attached to THIS process — SSE streams, the webhook
 * consumer, the reactive bridge. What it never reached is a subscriber in
 * a different process sharing the same database: a second web copy, or
 * the worker container once containers split by role. This module closes
 * that gap without changing any subscriber.
 *
 * Mechanism: `publish()` already appends the full wire payload to
 * event_log before emitting. The announcement is therefore just the
 * event_log id plus the publishing process's identity, sent as
 * `pg_notify` on the request-context connection — inside the surrounding
 * transaction, so the REMOTE half is delivered only on commit and never
 * for a write that rolled back (the local emit fires inside the
 * transaction, as it always has). Each process holds one LISTEN
 * connection on the session-mode client (a NOTIFY subscription is
 * session state, which a transaction-mode pooler cannot carry); on a
 * notification from another process it hydrates the event from event_log
 * and re-emits it locally, marked `remote: true`.
 *
 * Exactly-once side effects survive because the mark travels with the
 * event: the webhook consumer skips remote events (the origin process
 * already recorded the delivery), while pure fan-out — SSE, the reactive
 * bridge's cluster-elected drainer — treats local and remote alike.
 *
 * A notification raised while this process's listener is reconnecting is
 * gone from the channel (NOTIFY is not durable), so reconnection runs a
 * catch-up: postgres.js re-issues LISTEN and fires `onlisten` again, and
 * the handler replays event_log forward from the last id this process
 * saw, re-emitting every row marked remote. The catch-up cannot tell its
 * own rows from foreign ones (event_log carries no process origin), so
 * across a reconnect delivery is at-least-once — duplicates are marked
 * remote, which the webhook consumer skips, SSE clients dedupe by event
 * id, and integration dispatch already tolerates redelivery.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { log } from "./middleware/logger.js";
import {
  emitReplicated,
  type ItemEventWithId,
  type EdgeEventWithId,
} from "./pubsub.js";
import type { PgClient, PgDb } from "./storage/pg/connection.js";
import type { EventLogStore } from "./storage/interface.js";
import type { Item, Metadata, Edge } from "@withmarfa/shared";

export const EVENT_CHANNEL = "marfa_events";

/**
 * This process's identity on the channel, minted per boot. Only used to
 * skip our own announcements: the local emit in `publish()` has already
 * served this process's subscribers by the time the notification comes
 * back around.
 */
export const PROCESS_ORIGIN = randomUUID();

interface Announcement {
  /** event_log id, stringified (bigint does not survive JSON). */
  i: string;
  /** Origin process (PROCESS_ORIGIN of the publisher). */
  o: string;
}

/**
 * The `notifyRemote` hook for `initEventLog`. Runs on the given Drizzle
 * instance, which on the request path resolves through the ALS
 * request-context proxy to the transaction the event_log append rode —
 * commit delivers both or neither.
 */
export function createPgEventNotifier(
  db: PgDb,
): (eventId: bigint) => Promise<void> {
  return async (eventId: bigint): Promise<void> => {
    const payload = JSON.stringify({
      i: String(eventId),
      o: PROCESS_ORIGIN,
    } satisfies Announcement);
    await db.execute(sql`SELECT pg_notify(${EVENT_CHANNEL}, ${payload})`);
  };
}

interface ItemPayload {
  type: string;
  item: Item;
  metadata?: Metadata;
}

interface EdgePayload {
  type: string;
  edge: Edge;
}

/** Rebuild the emitted event shape from its persisted row. */
export function eventFromRow(row: {
  id: bigint;
  event_type: string;
  space_id: string | null;
  payload: string;
  originating_connection_id: string | null;
  hop_count: number | null;
}): ItemEventWithId | EdgeEventWithId | null {
  const parsed = JSON.parse(row.payload) as ItemPayload | EdgePayload;
  const common = {
    spaceId: row.space_id ?? undefined,
    originatingConnectionId: row.originating_connection_id,
    hopCount: row.hop_count ?? 0,
    eventId: row.id,
  };
  if (row.event_type === "edge_created" || row.event_type === "edge_deleted") {
    if (!("edge" in parsed)) return null;
    return { type: row.event_type, edge: parsed.edge, ...common };
  }
  if (
    row.event_type === "created" ||
    row.event_type === "updated" ||
    row.event_type === "deleted" ||
    row.event_type === "restored" ||
    row.event_type === "state_changed" ||
    row.event_type === "metadata_changed"
  ) {
    if (!("item" in parsed)) return null;
    return {
      type: row.event_type,
      item: parsed.item,
      ...(parsed.metadata !== undefined && { metadata: parsed.metadata }),
      ...common,
    };
  }
  return null;
}

/**
 * Handle one raw notification. Exported so tests can drive the exact
 * production path without racing a real LISTEN connection. `onSeen`
 * receives every announced id, own announcements included — the
 * reconnect catch-up anchors on it.
 */
export async function handleAnnouncement(
  raw: string,
  eventLog: EventLogStore,
  ownOrigin: string = PROCESS_ORIGIN,
  onSeen?: (id: bigint) => void,
): Promise<void> {
  let announcement: Announcement;
  try {
    const parsed: unknown = JSON.parse(raw);
    // JSON.parse("null") succeeds, so shape-check inside the guard or the
    // property reads below throw past it into the generic handler.
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("not an object");
    }
    announcement = parsed as Announcement;
  } catch {
    log("warn", "Event replication: unparseable announcement", { raw });
    return;
  }

  let id: bigint;
  try {
    id = BigInt(announcement.i);
  } catch {
    log("warn", "Event replication: non-numeric event id", { raw });
    return;
  }
  onSeen?.(id);
  if (announcement.o === ownOrigin) return;

  // Single-row hydration through the existing range read: the smallest
  // id greater than id-1 is the row itself when it still exists.
  const rows = await eventLog.getAfter(id - 1n, 1);
  const row = rows[0];
  if (row?.id !== id) {
    log("warn", "Event replication: announced event not found", {
      event_id: String(id),
    });
    return;
  }

  const event = eventFromRow(row);
  if (!event) {
    log("warn", "Event replication: unrecognized persisted event", {
      event_id: String(id),
      event_type: row.event_type,
    });
    return;
  }
  emitReplicated(event);
}

export interface EventReplication {
  stop: () => Promise<void>;
}

const CATCH_UP_BATCH = 200;

/**
 * Start listening for other processes' announcements. `client` must be
 * the session-mode client (`sessionClient` from createConnection):
 * postgres.js keeps a dedicated connection for LISTEN (its own backend,
 * beyond the pool's `max`) and re-issues the subscription on reconnect,
 * but only a session-mode endpoint can hold a subscription at all.
 */
export async function startEventReplication(
  client: PgClient,
  eventLog: EventLogStore,
): Promise<EventReplication> {
  // Highest event id seen on the channel, own announcements included:
  // the reconnect catch-up below replays forward from here, so the
  // anchor has to move even for events this process published itself.
  let lastSeenId: bigint | null = null;
  const trackSeen = (id: bigint): void => {
    if (lastSeenId === null || id > lastSeenId) lastSeenId = id;
  };

  // Notifications raised while the LISTEN connection was down are gone,
  // so a reconnect replays event_log forward from the anchor. The log
  // carries no process origin, so this re-emits this process's own rows
  // too — at-least-once across a reconnect, which every subscriber
  // already tolerates (see the module doc). With no anchor there is
  // nothing to replay from; the gap before the first seen event is
  // uncoverable either way.
  const catchUp = async (): Promise<void> => {
    if (lastSeenId === null) return;
    let cursor = lastSeenId;
    for (;;) {
      const rows = await eventLog.getAfter(cursor, CATCH_UP_BATCH);
      if (rows.length === 0) return;
      for (const row of rows) {
        cursor = row.id;
        trackSeen(row.id);
        const event = eventFromRow(row);
        if (event) emitReplicated(event);
      }
      if (rows.length < CATCH_UP_BATCH) return;
    }
  };

  let listenCount = 0;
  const request = client.listen(
    EVENT_CHANNEL,
    (raw) => {
      handleAnnouncement(raw, eventLog, PROCESS_ORIGIN, trackSeen).catch(
        (err: unknown) => {
          log("warn", "Event replication: handler failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    },
    () => {
      // Fires on the initial subscription and again on every reconnect;
      // the reconnects are the ones that need both the log line and the
      // catch-up, since the drop itself is otherwise invisible.
      listenCount += 1;
      if (listenCount === 1) {
        log("info", "Event replication listening", {
          channel: EVENT_CHANNEL,
        });
        return;
      }
      log("warn", "Event replication listener reconnected; catching up", {
        channel: EVENT_CHANNEL,
        reconnects: listenCount - 1,
      });
      void catchUp().catch((err: unknown) => {
        log("warn", "Event replication: catch-up failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
  );
  const meta = await request;
  return {
    stop: async () => {
      await meta.unlisten();
    },
  };
}
