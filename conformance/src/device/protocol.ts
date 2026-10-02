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
  /** The edge types held whole, every edge of each the key can read. */
  edge_types: string[];
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

/** One event a held stream applied (`device.md` 40). */
export interface Change {
  event: string;
  item_id: string | null;
  edge_id: string | null;
  cursor: string;
  /** Why the server cannot be reached, on `server.unreachable` alone
   *  (`device.md` 40). */
  reason: string | null;
}

/** What a held stream did before it was stopped. */
export interface FollowReport {
  applied: number;
  skipped: number;
  cursor: string;
  /** Streams asked for after the first. */
  reconnects: number;
  /** Asks for a stream that failed and were asked again. */
  failed_opens: number;
  /** Why the last of those failed, or null where none did. */
  last_failure: string | null;
}

export interface Status {
  server_origin?: string | null;
  slice_types: string[];
  slice_tier?: Tier | null;
  /** The edge types the slice holds whole. */
  slice_edge_types: string[];
  /** The rows held by id whatever the slice says of them. */
  pinned: string[];
  event_cursor?: string | null;
  hydration: "never" | "in_progress" | "complete" | "expired";
  items: number;
  edges: number;
  /** Moves each time a refresh changes the catalog the copy holds, and is
   *  null where the copy has never held one. */
  catalog_version: number | null;
}

/** A field of an item type, or a property of an edge type. */
export interface TypeField {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
  /** The type that declares it: the type itself, or the nearest it inherits it from. */
  declared_by: string;
  /** The definition whole, as the server answers it. */
  definition: Record<string, unknown>;
}

/** An item type as the copy holds it, its inheritance resolved. */
export interface ItemType {
  id: string;
  label: string | null;
  description: string | null;
  parent: string | null;
  version: number;
  fields: TypeField[];
  title_field: string | null;
  body_field: string | null;
  link_field: string | null;
  roles: string[];
  compatible_with: string[];
}

/** An edge type as the copy holds it. */
export interface EdgeType {
  id: string;
  label: string | null;
  description: string | null;
  cardinality: string;
  reverse_name: string | null;
  written_at: "source" | "target";
  source_type_constraints: string[];
  target_type_constraints: string[];
  cascade_on_delete: string;
  properties: TypeField[];
  shipped: boolean;
}

/** What a pin or an unpin answers. */
export interface PinReport {
  id: string;
  /** Whether the row is pinned now. */
  pinned: boolean;
  /** Whether it was pinned before this call. */
  was_pinned: boolean;
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
  /** The blob an upload carries, by its hash. */
  blob: string | null;
  base_version: number | null;
  idempotency_key: string;
  /** The writes this one cannot go without, by queue id: the create of a
   *  row it names while the server has not taken it, the creates of both of
   *  an edge's endpoints, the edge's own create, the upload a file item
   *  names. A refusal of one refuses this one (`queue-and-verdicts.md` 4,
   *  12, 16). */
  depends_on: string[];
  /** The write ahead of this one to the same row or edge, where one was
   *  still to be written when this one was queued. This one is held while
   *  that one has gone out without an answer or is held behind one that
   *  has, and goes on any answer to it (`queue-and-verdicts.md` 42); a row
   *  held with nothing it depends on still waiting is held by this. */
  follows: string | null;
  verdict: string | null;
  reason: string | null;
  /** The server's answer, kept whole, because a device reports a verdict and
   *  never acts on one (`queue-and-verdicts.md` 15). */
  answer: string | null;
  /** The refusal read into its parts, on `refused` (`queue-and-verdicts.md`
   *  48). */
  refusal: WriteRefusal | null;
  /** The body the write carries, as it goes or went to the server, so a
   *  refused write's content can be read back (`queue-and-verdicts.md`
   *  47). */
  body: unknown;
  conflicted_copy_id: string | null;
  refusals: number;
  queued_at: string;
  answered_at: string | null;
}

/** A refused write's refusal, read from the server's envelope once
 *  (`queue-and-verdicts.md` 48). */
export interface WriteRefusal {
  /** The server's code verbatim, or the drain's sentence for a write it
   *  refused unsent. */
  reason: string;
  /** The envelope's `error.code`, where the server refused it. */
  code: string | null;
  message: string | null;
  /** The envelope's `details.errors`. */
  fields: Array<{ field: string; message: string }>;
  /** The row the write named is in the bin. */
  trashed: boolean;
  /** The grant the credential lacks, where the refusal names one. */
  grant: { kind: string; name: string; level: string } | null;
}

/** An edge as the working copy holds it. */
export interface Edge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties: Record<string, unknown>;
  version: number;
}

/** What a drain did (`queue-and-verdicts.md` 6). */
export interface DrainReport {
  /** Writes the server answered this pass, whatever it answered
   *  (`queue-and-verdicts.md` 6). */
  answered: number;
  /** Rows it did not send because a write they depend on, or the write
   *  ahead of them to the same row or edge, has no answer yet
   *  (`queue-and-verdicts.md` 4, 42). */
  held: number;
  /** Writes it could not deliver, each waiting for the next drain
   *  (`queue-and-verdicts.md` 17). */
  undelivered: number;
  /** Writes it gave a verdict without sending: refused for a write they
   *  waited on or for bytes no longer held, or settled by another write's
   *  answer (`queue-and-verdicts.md` 6). */
  unsent: number;
  /** Writes whose request could not be made, each counted and waiting. */
  unmade: number;
  /** Why the pass ended before the queue was through, where it did. */
  unavailable: string | null;
  verdicts: DrainVerdict[];
  /** Why the drain stopped before the queue was empty. A refused credential
   *  ends a pass early here (`queue-and-verdicts.md` 20); an answer on
   *  another contract ends one as a refusal instead (`device.md` 42). */
  stopped: string | null;
  /** The sources the server said the credential's key does not claim, where
   *  a create naming one was refused for it (`queue-and-verdicts.md` 40). */
  unclaimed_sources: string[];
  /** The longest `Retry-After` the server asked for this pass. */
  retry_after_seconds: number | null;
}

export interface DrainVerdict {
  id: string;
  kind: string;
  item_id: string | null;
  edge_id: string | null;
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
  /** The refusal read into its parts, on `refused`. */
  refusal: WriteRefusal | null;
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
  /** The version is one read before the version the copy holds, and the
   *  server merges the edit against it (`queue-and-verdicts.md` 43). */
  asRead?: boolean;
  /** The type to move the row to; sent as a retype. */
  type?: string;
  /** The tier to move the row to. */
  tier?: "library" | "feed";
  /** The properties are the row's whole properties, so one left out is
   *  cleared (`queue-and-verdicts.md` 45). */
  replace?: boolean;
}

/** An edge, before it is queued. */
export interface EdgeDraft {
  source: string;
  target: string;
  type: string;
  properties?: Record<string, unknown>;
  id?: string;
}

/** Narrowing for a local search: the state axis, a type with its subtree,
 *  tags, a listing-grammar expression and `beneath`, each read as the list
 *  reads it. */
export interface SearchFilters {
  state?: string;
  allStates?: boolean;
  type?: string;
  tags?: string[];
  /** An expression in the server's listing grammar, the `filter` of `GET /items`; a `backref` condition is refused. */
  filter?: string;
  /** An item and everything it reaches along `parent-of` edges. */
  beneath?: string;
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
  /** An expression in the server's listing grammar, the `filter` of `GET /items`; a `backref` condition is refused. */
  filter?: string;
  /** An item and everything it reaches along `parent-of` edges. */
  beneath?: string;
}

/**
 * A device, as the fixtures drive it.
 *
 * One operation per thing a device can be asked to do.
 */
export interface DeviceUnderTest {
  /** The store this device reads and writes. One device, one store. */
  readonly store: string;

  hydrate(
    types: string[],
    tier: Tier,
    options?: { edgeTypes?: string[] },
  ): Promise<Outcome<HydrateReport>>;
  /** Hold one row by id, whatever the slice says of it, read now. */
  pin(id: string): Promise<Outcome<PinReport>>;
  /** Stop holding a row by id; one outside the slice goes once no write to
   *  it waits. */
  unpin(id: string): Promise<Outcome<PinReport>>;
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
  /** The item types the copy holds, read from it alone. */
  itemTypes(): Promise<Outcome<ItemType[]>>;
  itemType(id: string): Promise<Outcome<ItemType>>;
  /** The edge types the copy holds, read from it alone. */
  edgeTypes(): Promise<Outcome<EdgeType[]>>;
  edgeType(id: string): Promise<Outcome<EdgeType>>;

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
  /**
   * Take a row that can never be sent out of the queue, and put the copy
   * back to what the server holds. Answers whether the row was one a
   * withdraw takes.
   */
  withdraw(id: string): Promise<Outcome<boolean>>;
  /** Clear the rows the server has answered, and say how many went. */
  forget(): Promise<Outcome<number>>;

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
  /** The edges the copy holds from one item. */
  edgesFrom(item: string): Promise<Outcome<Edge[]>>;
  /** The edges the copy holds to one item. */
  edgesTo(item: string): Promise<Outcome<Edge[]>>;
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

  /** Hold a file's bytes beside the store and queue their upload. */
  putBlob(path: string, mimeType?: string): Promise<Outcome<QueuedWrite>>;
  /** Where a blob's bytes are held, fetched first where they are not. */
  blob(hash: string): Promise<Outcome<{ hash: string; path: string }>>;
  /** The thumbnail an item carries, read from the copy; its bytes to `out`. */
  thumbnail(
    id: string,
    out: string,
  ): Promise<
    Outcome<{
      id: string;
      thumbnail: {
        mime_type: string;
        size_bytes: number;
        path: string | null;
      } | null;
    }>
  >;
  /** A file attached to an item: the upload, the file item, the edge. */
  attach(
    item: string,
    path: string,
    options?: { mimeType?: string; title?: string; type?: string; tier?: Tier },
  ): Promise<Outcome<QueuedWrite[]>>;

  /** A file added as an item of its own: the upload, the file item. */
  addFile(
    path: string,
    options?: {
      mimeType?: string;
      title?: string;
      type?: string;
      tier?: Tier;
      tags?: string[];
    },
  ): Promise<Outcome<QueuedWrite[]>>;

  /** A second device over the same store, for the one-writer rule. */
  reopen(options?: { url?: string; key?: string }): DeviceUnderTest;
}
