import type { Edge, Item, Metadata } from "@withmarfa/shared";

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
 * does not: the write was made against a version of the row that no
 * longer exists, and no amount of waiting brings it back. Only the app
 * re-applying the edit over what the server now holds, or dropping it,
 * gets that mutation moving.
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
   * key exists to prevent arriving under cover of appearing to work. The
   * drain sends this on every door that accepts one; the two update doors
   * do not yet, because a strategy that re-sends a merged body would be
   * replaying the key with a different request, which the server refuses.
   */
  idempotencyKey: string;
  state: OutboxRowState;
  blockedReason: BlockedReason | null;
  attempts: number;
  lastError: string | null;
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
    };

export type LocalEngineEventListener = (event: LocalEngineEvent) => void;

/** An item as this client sees it: server state with pending mutations
 *  replayed over the top. */
export type VisibleItem = Item;
/** An edge as this client sees it. */
export type VisibleEdge = Edge;
/** The metadata layer as this client holds it. Nothing local writes it
 *  yet, so it is server state unmodified. */
export type VisibleMetadata = Metadata;
