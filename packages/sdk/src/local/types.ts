import type { Edge, Item, Metadata, MergeStrategy } from "@withmarfa/shared";

/**
 * Which server, which space and which account this store belongs to.
 *
 * All three, together, because any one of them alone lets two different
 * corpora share a cursor. A server with no spaces has no space id to give,
 * so the sentinel below stands in rather than the field being optional —
 * an optional field is a third state nothing here wants to reason about.
 */
export interface StoreIdentity {
  /** Base URL of the server this store syncs with. */
  origin: string;
  /** Space id, or {@link SINGLE_SPACE} on a server that has none. */
  spaceId: string;
  /** Account id, or {@link SINGLE_ACCOUNT} where the credential names none. */
  accountId: string;
}

/** Sentinel space for a single-space server. */
export const SINGLE_SPACE = "";
/** Sentinel account for a credential that names none. */
export const SINGLE_ACCOUNT = "";

/** The mutations the outbox carries. Metadata-layer writes are not among
 *  them yet: the metadata layer exists here as server state, so an item
 *  event cannot clobber it, but nothing queues a tag or extension write. */
export type MutationKind =
  | "item.create"
  | "item.update"
  | "item.delete"
  | "edge.create"
  | "edge.update"
  | "edge.delete";

export type TargetKind = "item" | "edge";

/**
 * Why a mutation is parked rather than retrying or dead-lettering.
 *
 * Closed, and each member names something an app can put in front of a
 * person. `auth` parks the whole queue; the rest park one mutation and
 * whatever waits behind it.
 *
 * They divide on what clears them. `auth`, `space_suspended`,
 * `quota_exceeded` and `retry_ceiling` all clear on their own or on an
 * operator's action, so retrying later is the right move. `needs_review`
 * does not, and no amount of waiting brings it back: only the app
 * re-applying the edit over what the server now holds, or dropping it,
 * gets that mutation moving.
 *
 * Two things reach `needs_review`, named together because the remedy is
 * identical rather than because the causes are. The write was made
 * against a version of the row that no longer exists; or the key it
 * carries has already been answered for a different body, so the server
 * keeps refusing this one under it. Either way the edit is still wanted
 * and the queue cannot get it there — a person re-applies it, which
 * makes a fresh mutation with a fresh key, or drops it.
 */
export type BlockedReason =
  | "auth"
  | "retry_ceiling"
  | "space_suspended"
  | "quota_exceeded"
  | "needs_review";

export type OutboxRowState = "pending" | "blocked";

/** A queued mutation, as the app and the drain see it. */
export interface OutboxEntry {
  seq: number;
  id: string;
  kind: MutationKind;
  targetKind: TargetKind;
  targetId: string;
  /** Ids this mutation waits behind beyond its own target. */
  dependsOn: string[];
  payload: Record<string, unknown>;
  baseVersion: number | null;
  /**
   * Minted per mutation and stored so a retry names the attempt it is
   * repeating rather than opening a new one.
   *
   * Stored rather than generated at send time, because a key generated per
   * attempt makes every attempt its own write, which is the failure the
   * key exists to prevent arriving under cover of appearing to work.
   *
   * The drain sends it on every door the queue uses, updates included.
   *
   * On an update it does more than name a repeat: the server derives a
   * `keep_both_copies` sibling's id from it, so a replay lands in the
   * same sibling rather than spawning a second copy of the text that
   * lost.
   */
  idempotencyKey: string;
  state: OutboxRowState;
  blockedReason: BlockedReason | null;
  attempts: number;
  lastError: string | null;
  /**
   * When this mutation's schema refusal was answered with one registry
   * refresh, or null when none has been.
   *
   * Rule 5 allows exactly one, and this is what makes "one" mean once
   * ever rather than once per pass. A local type graph can be stale — a
   * type registered on another device an hour ago is a type this client
   * has never read — so a schema refusal is worth one look at the
   * server's current vocabulary before it is believed. It is worth
   * exactly one: the second refusal is the server saying the same thing
   * about a graph the client has just confirmed.
   */
  schemaRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Why a mutation was dead-lettered. `cascaded` is a dependant of a create
 *  the server refused: it can never succeed, so it is kept beside the
 *  refusal rather than retried against a row that will not exist. */
export type DeadLetterReason = "refused" | "cascaded";

export interface DeadLetterEntry {
  id: string;
  seq: number;
  kind: MutationKind;
  targetKind: TargetKind;
  targetId: string;
  payload: Record<string, unknown>;
  reason: DeadLetterReason;
  code: string | null;
  message: string;
  httpStatus: number | null;
  failedAt: string;
}

/** Where the stream is up to, and when the queue last emptied cleanly. */
export interface SyncStateRow {
  identity: StoreIdentity;
  cursor: string | null;
  hydratedAt: string | null;
  lastDrainedAt: string | null;
  /** When a full re-read was found to be owed, or null when none is. */
  reimportOwedAt: string | null;
}

/**
 * What the engine tells the app.
 *
 * The counts and connection state an app renders are the next part's
 * surface; these are the notifications that cannot wait for a poll, because
 * each one is work that has stopped moving.
 */
export type LocalEngineEvent =
  | {
      type: "queue.parked";
      reason: Extract<BlockedReason, "auth">;
      /** How many queued mutations were parked. Nothing is dropped. */
      parked: number;
      message: string;
    }
  | {
      type: "mutation.blocked";
      seq: number;
      id: string;
      reason: BlockedReason;
      message: string;
    }
  | {
      type: "mutation.dead_lettered";
      seq: number;
      id: string;
      reason: DeadLetterReason;
      code: string | null;
      message: string;
    }
  | {
      type: "drain.finished";
      /** Mutations the server accepted on this pass. */
      sent: number;
      /** Mutations still queued: pending, blocked, or waiting on one of
       *  those. */
      remaining: number;
    }
  /**
   * How far a first read has got.
   *
   * Counts rise and never fall, so a progress display built on them cannot
   * run backwards when a page turns out to hold rows already held.
   * `totalItems` is what the server says it has, read once before the walk
   * — undefined when the server would not say, which is a display without
   * a denominator rather than a reason to withhold the progress.
   */
  | {
      type: "hydration.progress";
      items: number;
      edges: number;
      totalItems: number | undefined;
    }
  /**
   * Whether the engine is reaching the server.
   *
   * Reported from the stream, which is the only part that knows: it is
   * the one thing continuously in contact, and a status derived from the
   * queue instead reads healthy through an entire backoff loop because a
   * queue with nothing in it never fails to send.
   */
  | { type: "connection.changed"; state: ConnectionState }
  /**
   * Something the engine started on its own did not finish.
   *
   * The stream's callbacks are synchronous, so the work they begin — a
   * cursor write, a catch-up, a re-import — cannot be awaited by whatever
   * asked for it, and a failure has nowhere to be returned to. Reported
   * here rather than thrown: a rejection nobody holds becomes an uncaught
   * exception and takes the host process with it, which is a far worse
   * answer to a failed read than telling the app it failed.
   */
  | {
      type: "sync.error";
      scope: "stream" | "cursor" | "catchup" | "reimport";
      message: string;
      error: unknown;
    }
  /** A fresh store has read the server's state for the first time. */
  | { type: "hydration.finished"; items: number; edges: number }
  /**
   * A reconnection has read whatever changed while the client was away.
   *
   * Reported rather than done quietly because it is the only account of
   * where a row that appeared without an event came from — and because a
   * catch-up that stops running looks, from every other signal, exactly
   * like a quiet period.
   */
  | {
      type: "catchup.finished";
      /** The `updated_after` bound the read was made with. */
      since: string;
      items: number;
      edges: number;
    }
  /**
   * The cursor had aged out of the event log, so the store re-read
   * everything instead of reconnecting.
   *
   * Worth telling the app rather than doing quietly: the pruned counts are
   * rows that were on screen a moment ago and are not any more, and the
   * only account of why is this.
   */
  | {
      type: "reimport.finished";
      items: number;
      edges: number;
      prunedItems: number;
      prunedEdges: number;
    }
  /**
   * The server merged a conflicting update, and what it did with the
   * values that lost.
   *
   * Worth telling the app for the same reason a prune is: something a
   * person typed has just left the row they typed it into. The merged row
   * arrives through the ordinary settle and looks like any other write, so
   * without this the only account of a `keep_both_copies` field is a
   * sibling appearing later out of the stream with nothing connecting it
   * to the edit that made it.
   *
   * `conflictedCopyId` is the only place that sibling is named. No route
   * says what a write created, so an app that does not read it here cannot
   * find the copy at all until the stream delivers it.
   */
  | {
      type: "mutation.merged";
      seq: number;
      id: string;
      /** The fields that collided. */
      fields: string[];
      /** Keyed by field, the policy the server applied. */
      strategy: Record<string, MergeStrategy>;
      /** The sibling holding the losing values, when a field kept both. */
      conflictedCopyId?: string;
    };

/** Whether the engine is reaching the server, and how it knows. */
export type ConnectionState =
  /** Nothing has been started yet. */
  | "idle"
  /** A connection is being opened, or reopened after one dropped. */
  | "connecting"
  /** A connection is open. */
  | "online"
  /** The last attempt did not reach the server. */
  | "offline"
  /** Stopped deliberately. */
  | "stopped";

export type LocalEngineEventListener = (event: LocalEngineEvent) => void;

/** An item as this client sees it: server state with pending mutations
 *  replayed over the top. */
export type VisibleItem = Item;
/** An edge as this client sees it. */
export type VisibleEdge = Edge;
/** The metadata layer as this client holds it. Nothing local writes it
 *  yet, so it is server state unmodified. */
export type VisibleMetadata = Metadata;
