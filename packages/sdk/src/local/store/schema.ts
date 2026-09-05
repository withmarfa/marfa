/**
 * The local engine's SQLite schema.
 *
 * Server state lives in three tables rather than one because the server
 * writes metadata through its own layer: an item event carries no tags and
 * no extensions, so an engine that stored them together would wipe them
 * every time an ordinary edit arrived.
 *
 * The outbox is the pending layer, not a sidecar to it. Visible state is
 * server state with this client's queued mutations replayed over the top,
 * so a mutation's row in `outbox` *is* the local row a person sees before
 * it has been sent. That is what makes an inbound event unable to hide a
 * pending local edit: the event changes server state and the projection is
 * recomputed.
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Server state for items. `payload` is the item as the server returned it;
 * the columns beside it are the ones the engine filters and guards on, so a
 * version comparison never has to parse JSON.
 *
 * Fields the server derives per read are stripped before the row is stored
 * (see `stripDerived` in `server-state.ts`) — persisting one would let a
 * stale answer outlive the read it came from.
 */
export const serverItems = sqliteTable(
  "server_items",
  {
    id: text("id").primaryKey().notNull(),
    type: text("type").notNull(),
    version: integer("version").notNull(),
    state: text("state").notNull(),
    spaceId: text("space_id"),
    updatedAt: text("updated_at").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [
    index("server_items_type_idx").on(table.type),
    index("server_items_updated_at_idx").on(table.updatedAt),
  ],
);

/** Server state for edges. Endpoints are columns so the outbox can ask
 *  whether an edge is waiting behind one of them without parsing JSON. */
export const serverEdges = sqliteTable(
  "server_edges",
  {
    id: text("id").primaryKey().notNull(),
    edgeType: text("edge_type").notNull(),
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
    version: integer("version").notNull(),
    updatedAt: text("updated_at").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [
    index("server_edges_source_idx").on(table.sourceId),
    index("server_edges_target_idx").on(table.targetId),
    index("server_edges_updated_at_idx").on(table.updatedAt),
  ],
);

/** Server state for the metadata layer: tags and extensions, keyed by item.
 *  Its own table because its writer is its own — an item event must never
 *  reach it. */
export const serverMetadata = sqliteTable("server_metadata", {
  itemId: text("item_id").primaryKey().notNull(),
  payload: text("payload").notNull(),
});

/**
 * The queue of mutations this client has made and not yet sent.
 *
 * `seq` is `AUTOINCREMENT` rather than a plain rowid, and that is
 * load-bearing: a settled row is deleted, and SQLite reuses the highest
 * free rowid unless told not to, so without it a mutation enqueued after a
 * drain could be handed a sequence number that sorts ahead of one already
 * waiting.
 *
 * A settled row is deleted rather than marked done, so "a row exists for
 * this target" is the same question as "something is still queued for this
 * target" — which is how a change waits behind its own row's unsent create.
 */
export const outbox = sqliteTable(
  "outbox",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }).notNull(),
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    /** Ids this mutation waits behind beyond its own target: an edge's two
     *  endpoints. JSON array. */
    dependsOn: text("depends_on").notNull().default("[]"),
    payload: text("payload").notNull(),
    baseVersion: integer("base_version"),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").notNull().default("pending"),
    blockedReason: text("blocked_reason"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /**
     * When this mutation's schema refusal was answered with a registry
     * refresh, or null when none has been.
     *
     * On the row rather than in the drain, because the drain is one pass
     * and the guarantee is "once, ever" rather than "once per pass". A
     * counter held in memory would let a restart spend a second refresh on
     * the same refusal, and a queue of a hundred refused writes would spend
     * a hundred — against a server that has already given its answer.
     */
    schemaRefreshedAt: text("schema_refreshed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("outbox_id_unique").on(table.id),
    index("outbox_state_seq_idx").on(table.state, table.seq),
    index("outbox_target_idx").on(table.targetId, table.seq),
  ],
);

/** Mutations the server refused, kept so the app can show them and the
 *  person can dismiss them. A refused write is never dropped. */
export const deadLetters = sqliteTable(
  "dead_letters",
  {
    id: text("id").primaryKey().notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    payload: text("payload").notNull(),
    reason: text("reason").notNull(),
    code: text("code"),
    message: text("message").notNull(),
    httpStatus: integer("http_status"),
    failedAt: text("failed_at").notNull(),
  },
  (table) => [index("dead_letters_seq_idx").on(table.seq)],
);

/**
 * Where this store is up to, keyed by the three things that decide whose
 * store it is. One row per triple: two accounts on one device otherwise
 * merge into one cursor and each believes it applied what the other did.
 */
export const syncState = sqliteTable(
  "sync_state",
  {
    origin: text("origin").notNull(),
    spaceId: text("space_id").notNull(),
    accountId: text("account_id").notNull(),
    cursor: text("cursor"),
    hydratedAt: text("hydrated_at"),
    lastDrainedAt: text("last_drained_at"),
    /**
     * Set when a full re-read is owed and not yet finished.
     *
     * A separate column because the cursor cannot carry it: a re-import
     * clears the cursor before it reads, so a read that fails part-way
     * leaves null — which is also what a store that has never connected
     * looks like. Only one of those needs the corpus read again and
     * pruned, and following live over the other holds rows the server
     * dropped with nothing left that could ever notice them.
     */
    reimportOwedAt: text("reimport_owed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.origin, table.spaceId, table.accountId] }),
  ],
);

/**
 * The custom types this store has seen the server hold.
 *
 * Platform types ship with `@withmarfa/shared` and are never written here:
 * caching a type the build already compiles in would let a stale row
 * shadow the shipped one, and `hydrateTypeRegistry` skips them for the
 * same reason.
 *
 * No space column. A store belongs to one origin, space and account — that
 * is what `sync_state` records and what `openLocalStore` refuses to open
 * against a mismatch — so every row here belongs to that space and a
 * column saying so could only ever disagree with it.
 *
 * The whole table is replaced on a refresh rather than merged, because
 * `GET /types` answers with the whole vocabulary. Merging would keep a
 * type the server has since deleted, and the client would go on validating
 * writes against a type nothing will accept.
 */
export const cachedTypes = sqliteTable("cached_types", {
  id: text("id").primaryKey().notNull(),
  payload: text("payload").notNull(),
  cachedAt: text("cached_at").notNull(),
});

/**
 * Blobs this client has staged and not yet uploaded.
 *
 * The row is the queue; the bytes are on disk beside the store. Rule 14
 * puts the upload in front of the write that names it, so a row here is
 * what a queued mutation waits behind, and it survives a restart for the
 * same reason the outbox does.
 *
 * A row that has failed for good keeps its bytes. That is the whole point
 * of the rule: an upload the server refused is a photograph a person took,
 * and dropping it because a request failed is the outcome the rule exists
 * to prevent. It leaves only when the app says so.
 */
export const pendingBlobs = sqliteTable(
  "pending_blobs",
  {
    /** `sha256:<hex>`, computed over the bytes, which is the same
     *  content-addressed name the server gives them. */
    hash: text("hash").primaryKey().notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    /** `pending` until it lands, then the row leaves; `failed` when the
     *  server refused it for good and the bytes are being kept. */
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    code: text("code"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("pending_blobs_state_idx").on(table.state, table.createdAt),
  ],
);

/**
 * Blobs downloaded for offline reading, with their bytes on disk beside
 * the store.
 *
 * Separate from {@link pendingBlobs} because the two answer different
 * questions and have opposite lifetimes. A pending blob's bytes are the
 * only copy anywhere and must not be evicted; a cached blob's bytes are a
 * copy of something the server holds and can always be fetched again.
 * Folding them into one table would put a person's unsent attachment one
 * eviction away from being gone.
 */
export const blobCache = sqliteTable(
  "blob_cache",
  {
    hash: text("hash").primaryKey().notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    /** What the eviction rule orders by. */
    lastReadAt: text("last_read_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("blob_cache_last_read_idx").on(table.lastReadAt)],
);

export const localSchema = {
  serverItems,
  serverEdges,
  serverMetadata,
  outbox,
  deadLetters,
  syncState,
  cachedTypes,
  pendingBlobs,
  blobCache,
};
