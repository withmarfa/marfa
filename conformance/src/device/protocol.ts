/**
 * What a fixture asks a device to do, and what it answers.
 *
 * The device under test is a separate program, so everything here is an
 * operation a program can be asked to perform and an answer it can report.
 * A refusal arrives as data on `ok`, the way `MarfaClient` reports one, so a
 * fixture asserts a refusal the same way it asserts a success — the device
 * chapters are mostly refusals, and a thrown refusal would have to be caught
 * before it could be read.
 */

export type Tier = "library" | "feed";

export interface Refusal {
  /** The adapter's reading of the device's refusal. `unclassified` when it could not read one. */
  code: string;
  /** Everything the device said, kept so a failing assertion can print it. */
  raw: string;
}

export type Outcome<T> =
  { ok: true; value: T } | { ok: false; refusal: Refusal };

export interface Item {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  state: string;
  tier?: Tier | null;
  version: number;
  source: string;
  source_id?: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  tags: string[];
}

export interface HydrateReport {
  types: string[];
  tier: Tier;
  items: number;
  edges: number;
  pages: number;
  cursor: string;
}

export interface CatchUpReport {
  applied: number;
  skipped: number;
  cursor: string;
  reached_head: boolean;
}

export interface Status {
  server_origin?: string | null;
  slice_types: string[];
  slice_tier?: Tier | null;
  event_cursor?: string | null;
  hydration: "never" | "in_progress" | "complete";
  items: number;
  edges: number;
}

export interface SearchHit {
  item: Item;
  score: number;
  snippet: string;
}

/** One queued write, as the queue reports it.
 *
 *  A `verdict` of `null` is a write the server has not answered. It is not a
 *  seventh verdict (`queue-and-verdicts.md` 7); it is the absence of one. */
export interface QueuedWrite {
  id: string;
  kind: string;
  item_id: string | null;
  target_id: string | null;
  edge_id: string | null;
  namespace: string | null;
  tag: string | null;
  base_version: number | null;
  idempotency_key: string;
  /** The queue rows this one waits for. Empty when nothing holds it; more
   *  than one when an edge waits on both of its endpoints. */
  depends_on: string[];
  verdict: string | null;
  reason: string | null;
  /** The server's answer, kept whole, because a device reports a verdict and
   *  never acts on one (`queue-and-verdicts.md` 15). */
  answer: string | null;
  conflicted_copy_id: string | null;
  refusals: number;
  queued_at: string;
  answered_at: string | null;
}

/** What a drain did (`queue-and-verdicts.md` 6). */
export interface DrainReport {
  /** Rows the drain put on the wire. */
  sent: number;
  /** Rows it did not send because something they depend on is unanswered. */
  held: number;
  verdicts: DrainVerdict[];
  /** Why the drain stopped before the queue was empty. Only a refused
   *  credential ends a pass early (`queue-and-verdicts.md` 20). */
  stopped: string | null;
  /** The longest `Retry-After` the server asked for this pass. */
  retry_after_seconds: number | null;
}

export interface DrainVerdict {
  id: string;
  kind: string;
  item_id: string | null;
  /** One of the six, or `null` where the write was sent and not answered. */
  verdict: string | null;
  reason: string | null;
  conflicted_copy_id: string | null;
  refusals: number;
  /** The server answered from its idempotency record rather than writing
   *  (`queue-and-verdicts.md` 3). */
  replayed: boolean;
  /** The fields the server resolved, on `merged` or `conflicted`. */
  merged_fields: string[];
}

/** A create, before it is queued. */
export interface Draft {
  type: string;
  properties?: Record<string, unknown>;
  tags?: string[];
  tier?: Tier;
  source?: string;
  sourceId?: string;
  occurredAt?: string;
  id?: string;
  /** Optional on a create, and carried when given
   *  (`queue-and-verdicts.md` 2). */
  version?: number;
}

/** An edit, before it is queued. */
export interface Edit {
  properties: Record<string, unknown>;
  /** Required. An update queued without one is refused before it is sent. */
  version?: number;
}

/** An edge, before it is queued. */
export interface EdgeDraft {
  source: string;
  target: string;
  type: string;
  properties?: Record<string, unknown>;
  id?: string;
}

/** Narrowing for a local search: the state axis the list takes, and only
 *  that, because the rest of the grammar is answered by a list. */
export interface SearchFilters {
  state?: string;
  allStates?: boolean;
}

export interface ListFilters {
  type?: string;
  state?: string;
  allStates?: boolean;
  /** Exclusive lower bound on the item's own time. */
  occurredAfter?: string;
  /** Exclusive upper bound on the same. */
  occurredBefore?: string;
  tier?: Tier;
  tags?: string[];
  limit?: number;
  /** A filter the device is not expected to implement, so a fixture can check it is refused. */
  unsupported?: [string, string];
}

/**
 * A device, as the fixtures drive it.
 *
 * One operation per thing a device can be asked to do. A fixture that needs
 * an operation the binary has no command for yet is pending against the
 * statement it will assert (`pending.ts`).
 */
export interface DeviceUnderTest {
  /** The store this device reads and writes. One device, one store. */
  readonly store: string;

  hydrate(types: string[], tier: Tier): Promise<Outcome<HydrateReport>>;
  catchUp(): Promise<Outcome<CatchUpReport>>;
  list(filters?: ListFilters): Promise<Outcome<Item[]>>;
  get(id: string): Promise<Outcome<Item>>;
  search(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<Outcome<SearchHit[]>>;
  /** Every queued write and what became of it. */
  queue(): Promise<Outcome<QueuedWrite[]>>;
  status(): Promise<Outcome<Status>>;

  /** Write a new item into the working copy and queue it. */
  create(draft: Draft): Promise<Outcome<QueuedWrite>>;
  /** Change an item in the working copy and queue the change. */
  update(id: string, edit: Edit): Promise<Outcome<QueuedWrite>>;
  /** Send what the queue holds. One pass. */
  drain(): Promise<Outcome<DrainReport>>;
  /** Send a blocked or dead row again, under a fresh key. */
  release(
    target: { id: string } | { reason: string },
  ): Promise<Outcome<number>>;

  /** Move an item to the bin locally and queue the delete. */
  deleteItem(id: string): Promise<Outcome<QueuedWrite>>;
  /** Take an item out of the bin locally and queue the restore. */
  restoreItem(id: string): Promise<Outcome<QueuedWrite>>;
  /** Move an item to another lifecycle state. */
  transitionItem(id: string, state: string): Promise<Outcome<QueuedWrite>>;
  /** Link two items. An edge is its own write. */
  createEdge(edge: EdgeDraft): Promise<Outcome<QueuedWrite>>;
  updateEdge(
    id: string,
    edit: { properties: Record<string, unknown>; version?: number },
  ): Promise<Outcome<QueuedWrite>>;
  deleteEdge(id: string): Promise<Outcome<QueuedWrite>>;
  /** One tag, as its own write. */
  addTag(item: string, tag: string): Promise<Outcome<QueuedWrite>>;
  removeTag(item: string, tag: string): Promise<Outcome<QueuedWrite>>;
  /** The item's tags, written whole or merged into what is there. */
  writeMetadata(
    item: string,
    tags: string[],
    mode: "replace" | "merge",
  ): Promise<Outcome<QueuedWrite>>;
  /** One extension namespace, as its own write. */
  writeExtension(
    item: string,
    namespace: string,
    body: Record<string, unknown>,
  ): Promise<Outcome<QueuedWrite>>;
  deleteExtension(
    item: string,
    namespace: string,
  ): Promise<Outcome<QueuedWrite>>;

  /** A second device over the same store, for the one-writer rule. */
  reopen(options?: { url?: string; key?: string }): DeviceUnderTest;
}
