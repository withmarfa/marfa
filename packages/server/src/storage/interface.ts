import type {
  Item,
  TypeFilter,
  CreateItemInput,
  UpdateItemInput,
  Metadata,
  Version,
  ApiKey,
  CreateKeyInput,
  UpdateKeyInput,
  Webhook,
  WebhookDelivery,
  CreateWebhookInput,
  UpdateWebhookInput,
  PaginatedResult,
  SearchResult,
  AncestorUnavailableResponse,
  ConflictResolutionReport,
  ConflictResponse,
  ItemState,
  Edge,
  CreateEdgeInput,
} from "@withmarfa/shared";
import type {
  EdgeTypeSchema,
  PlatformTypeFamily,
  SeededPlatformType,
  TypeOrigin,
  TypeSchema,
} from "@withmarfa/shared";
import { MarfaError, ErrorCode, isValidTimestamp } from "@withmarfa/shared";
import type { HousekeepingReport } from "../housekeeping/scheduler.js";
import type { ConflictMode } from "./conflict.js";
import type { SourceFilterSettings } from "./filter-sql.js";

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

/** The three system columns sortable by a direct column comparison, with
 *  no JSON extraction. */
export const SYSTEM_SORTS = [
  "created_at",
  "updated_at",
  "occurred_at",
] as const;

export type SystemSortField = (typeof SYSTEM_SORTS)[number];

/**
 * A list `sort` is either one of the three system columns or a
 * `properties.<field>` form that orders on a JSON-extracted property value.
 * Enum-semantic ordering (status, priority) is deliberately NOT supported —
 * those fields have a meaningful order that isn't lexical, so the client owns
 * that sort. The property form orders datetimes/strings lexically (ISO-8601
 * sorts correctly as text) and numbers numerically.
 */
export type ItemSortField = SystemSortField | `properties.${string}`;
export type SortDirection = "asc" | "desc";

/** A property-field name is a single JSON key — `^[a-z0-9_]+$`. This is the
 *  same shape the type-registry uses for field identifiers, and constraining
 *  it here keeps the sort field safe to interpolate into a JSON path even
 *  though the value side of every query is parameterized. */
const PROPERTY_FIELD_PATTERN = /^[a-z0-9_]+$/;

function isSystemSort(sort: string): sort is SystemSortField {
  return (SYSTEM_SORTS as readonly string[]).includes(sort);
}

/**
 * Resolve a raw `sort` string into a discriminated sort target.
 *
 * - A system column (`created_at` | `updated_at` | `occurred_at`) → `{ kind: "system" }`.
 * - A `properties.<field>` form with a `^[a-z0-9_]+$` field → `{ kind: "property", field }`.
 * - Anything else (unknown bare column, malformed property field) → throws
 *   `VALIDATION_ERROR`. An undefined input defaults to `created_at`.
 *
 * The validation lives here so the listing and the search reject malformed
 * sorts identically before either builds any SQL.
 */
export function parseSortField(
  sort: ItemSortField | undefined,
):
  | { kind: "system"; column: SystemSortField }
  | { kind: "property"; field: string } {
  if (sort === undefined) return { kind: "system", column: "created_at" };
  if (isSystemSort(sort)) return { kind: "system", column: sort };
  if (sort.startsWith("properties.")) {
    const field = sort.slice("properties.".length);
    if (PROPERTY_FIELD_PATTERN.test(field)) {
      return { kind: "property", field };
    }
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid sort property field "${field}"; expected ${PROPERTY_FIELD_PATTERN.source}`,
    );
  }
  throw new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    `Invalid sort field "${sort}"; expected one of ${SYSTEM_SORTS.join(", ")} or properties.<field>`,
  );
}

export interface ItemFilters {
  type?: string;
  state?: ItemState;
  source?: string;
  /** The instance's `source_filter` enforcement lever, applied per row: a row
   *  whose type the lever lists must carry an approved source, every other
   *  row passes untouched. Per-row on purpose — the lever is per-type, so
   *  narrowing the whole result set instead would both over-restrict the
   *  types it does not list and leave it decidable from the request. */
  source_filter?: SourceFilterSettings;
  /** Restrict to a specific tier. Omit for the default unfiltered scope. */
  tier?: "library" | "feed";
  /** When true, items whose type starts with `system.` are excluded from
   *  the result set.
   *
   *  `GET /items` and `GET /search` flip this on by default; a caller opts
   *  back in with `?include=system`, or with a `type` filter in the
   *  `system.` namespace — the test is `startsWith("system.")`, so the
   *  `system.*` wildcard opts in as much as a concrete type does.
   *
   *  **Not every route flips it.** `GET /export` never sets it, so an export
   *  carries `system.*` rows by default and takes no `include` — it refuses
   *  one as an unknown parameter. Naming the two routes rather than "the
   *  route layer", because the layer is not what decides. */
  exclude_system_types?: boolean;
  tags?: string[];
  filter?: string;
  allowed_types?: string[];
  /** Patterns the permission map withholds, subtracted from `allowed_types`
   *  under the specificity ranking `resolveTypePermission` uses. A `"none"`
   *  entry always lands here; a `"read"` entry does too when the caller
   *  asked for a write-level filter, which is what `POST /items/bulk-actions`
   *  does. Distinct
   *  from `exclude_system_types`, which is a fixed negative over one family
   *  owned by the route layer; this one is fed by the permission map. Always
   *  supplied together with `allowed_types` — see `computeTypeFilter`. */
  excluded_types?: string[];
  sort?: ItemSortField;
  direction?: SortDirection;
  /** Exclusive lower bound on the item's own user-meaningful time —
   *  `occurred_at`, falling back to `created_at`. Named for the field it
   *  reads. It says nothing about when the row was last written, which
   *  is what `updated_after` is for; the two are easy to confuse and the
   *  cost of confusing them is a catch-up that silently returns the
   *  wrong set. */
  occurred_after?: string;
  /** Exclusive upper bound on the same column. Exclusive, matching its
   *  lower twin: a bounded window that is closed at one end and open at
   *  the other loses a row on the boundary in one direction only, which
   *  is the harder failure to spot. */
  occurred_before?: string;
  /** Inclusive lower bound on `updated_at`, the row's modification time.
   *
   *  This is the catch-up filter: a client that has been away asks what
   *  changed after the cursor it holds. Inclusive because `updated_at`
   *  is a millisecond text timestamp and a bulk write ties many rows on
   *  one instant — a strict comparison drops every row sharing the
   *  cursor's millisecond, which is silent and unrecoverable. The client
   *  dedupes by id, which is what makes the overlap harmless.
   *
   *  What the overlap costs is worth stating plainly, because "dedupe by
   *  id" understates it: the bound is inclusive and there is no way to
   *  resume just after one row within a tie, so a high-water mark that
   *  lands on an instant a large bulk write shares re-transfers that
   *  whole group on every reconnect. It terminates, so this is cost
   *  rather than a loop, but a client reconnecting often against a
   *  corpus written in bulk pays it every time.
   *
   *  Implies an `(updated_at, id)` ascending order; see the stores. */
  updated_after?: string;
  /** Exclusive upper bound on `updated_at`, closing the catch-up window
   *  at the top.
   *
   *  Exclusive, unlike its lower twin, and the asymmetry is the point:
   *  the lower bound is a resume point that must not drop a tie, while
   *  this one is an end point a caller chooses, so the ordinary rule
   *  applies. It does not change the ordering — only `updated_after`
   *  does that — so it can be given under any sort. */
  updated_before?: string;
  /** Suppress the default narrowing and return every lifecycle state.
   *
   *  A separate flag rather than a sentinel value on `state`, because
   *  `state` compiles to an equality against the column and a magic
   *  string reaching that comparison would match no row while looking
   *  like a filter. A boolean cannot be passed to `eq` by accident. */
  all_states?: boolean;
  /** Every lifecycle state except the ones named here.
   *
   *  The default answers the active state, which is what a reader is
   *  working with. A copy of the corpus is a different question, and the
   *  only door that asks it names its own selection here rather than
   *  inheriting a reader's. Stated as an exclusion so that a state added
   *  later joins the copy without anyone remembering to list it.
   *
   *  Ignored when `state` or `all_states` is set: both are the caller
   *  naming the selection outright. */
  exclude_states?: readonly ItemState[];
  /** Inclusive lower bound on the normalized `items.starts_at` column, and
   *  so implicitly `starts_at IS NOT NULL`. Serves the calendar's
   *  window scan: the column is written in the exact shape
   *  `toISOString()` emits, which is what lets a text comparison answer a
   *  question about instants. Internal — not reachable through the
   *  public `?filter=` grammar. */
  startsAtFrom?: string;
  /** Exclusive upper bound on `items.starts_at`. Exclusive because a
   *  calendar window's end belongs to the next window. */
  startsAtTo?: string;
  /** Restrict to rows whose top-level property of this name is present
   *  and not JSON `null`: a key written as `null` is a cleared value, and
   *  reads as absent here. Serves the calendar's series and exception
   *  discovery, both of which have to read every matching row whatever
   *  window was asked for: an old rule produces occurrences in any window,
   *  and an exception moved outside one still shadows the slot it left
   *  inside it. Internal — not reachable through the public `?filter=`
   *  grammar. */
  hasProperty?: string;
  limit?: number;
  cursor?: string;
}

/** The axis `ItemStore.stats` groups on. */
export type ItemStatsAxis = "state" | "type";

export interface SearchFilters {
  type?: string;
  state?: ItemState;
  /** Mirrors `ItemFilters.all_states`. The search door advertises the
   *  listing's filters, so a widening the listing offers and this door does
   *  not is a row reachable by one read and by no other. */
  all_states?: boolean;
  /** Tier filter, matching `/items`. Omit for unfiltered. */
  tier?: "library" | "feed";
  /** Mirrors `ItemFilters.source_filter`. */
  source_filter?: SourceFilterSettings;
  /** Mirrors `ItemFilters.exclude_system_types`. */
  exclude_system_types?: boolean;
  /** Items must have ALL specified tags. Mirrors `/items?tags=` semantics. */
  tags?: string[];
  filter?: string;
  /** Exclusive lower bound on the item's own time — `occurred_at`,
   *  falling back to `created_at` — exactly as `ItemFilters` reads it.
   *  Search advertises parity with `GET /items` in its own description,
   *  so a bound one door honors and the other strips would be a silent
   *  difference in what a caller believes they narrowed. */
  occurred_after?: string;
  /** Exclusive upper bound on the same expression. */
  occurred_before?: string;
  allowed_types?: string[];
  /** Mirrors `ItemFilters.excluded_types`. */
  excluded_types?: string[];
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Time-bound normalization
// ---------------------------------------------------------------------------

/** A date and a time with no zone at all. Valid RFC 3339 is not, strictly,
 *  but `isValidTimestamp` accepts it and callers send it. */
const ZONELESS_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Re-spell a caller's time bound in the exact shape the stored columns
 * carry, or refuse it.
 *
 * Every time column here is text, and every one the server stamps is
 * written as `new Date().toISOString()` emits: twenty-four characters,
 * always `.sssZ`. The bounds compile to a text comparison against that,
 * and text comparison is lexical — so a spelling that names the right
 * instant at a different width answers the wrong question. `Z` is 90, `.`
 * is 46 and `+` is 43, so `2026-03-01T12:00:00Z` excludes a row stamped
 * `2026-03-01T12:00:00.500Z` and `2026-03-01T12:00:00-01:00` includes
 * every row of the hour before the instant it names. Both return a 200
 * and a well-formed page, which is the silent loss the catch-up filter
 * exists to remove.
 *
 * Re-spelling rather than refusing, because second precision is valid
 * RFC 3339 and is the form a hand-written client reaches for first;
 * refusing it would be hostile. A value that is not a timestamp at all
 * is still refused.
 *
 * A date-time carrying no zone is read as UTC rather than handed to
 * `Date`, which reads it as the server's local time. The stamped text it
 * is compared against is UTC, so UTC preserves what the caller already
 * meant; local time would move the bound by whatever offset the deployment
 * happens to run in.
 *
 * One column is not server-stamped: the item listing's `occurred_*`
 * bounds read `COALESCE(occurred_at, created_at)`, and `occurred_at` is
 * whatever the caller wrote. So this makes the comparison exact against
 * every row the server stamped, and leaves it no worse than it already
 * was against one a caller spelled its own way.
 */
export function normalizeTimeBound(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isValidTimestamp(value)) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid ${field}: expected an RFC 3339 timestamp`,
      { field, value },
    );
  }
  const instant = new Date(ZONELESS_DATETIME.test(value) ? `${value}Z` : value);
  return instant.toISOString();
}

// ---------------------------------------------------------------------------
// Cursor utilities (keyset pagination)
// ---------------------------------------------------------------------------

/**
 * A cursor names the listing and the ordering that issued it, and one
 * issued anywhere else is refused.
 *
 * The payload is the last row's sort value and its id. Every ordering a
 * listing pages under compares an ISO timestamp or a JSON-extracted value,
 * so a cursor replayed under another ordering decodes cleanly, compares
 * successfully and returns a page bounded by the wrong column. Nothing
 * errors; the page is simply not the next page, and rows are skipped or
 * repeated with no signal anywhere. The item listing offers several
 * orderings, and both listings that take `updated_after` page under
 * `(updated_at, id)` ascending with the filter and under their own default
 * without it.
 *
 * So the key travels with the cursor and a mismatch is refused, and so is
 * a cursor carrying no key or a key spelled another way: nothing this
 * server mints lacks the key, so a cursor without it was not minted here
 * and is not guessed at.
 *
 * **The key names the listing** as well as the column, because two
 * listings can page under the same column. A cursor from the item listing
 * compares perfectly well against the audit log's `created_at` and answers
 * a page of audit rows older than an item, which is a page nobody asked
 * for; a cursor continues the page it came from and nothing else. An
 * item's outbound and inbound edges are two listings for the same reason.
 *
 * **The key names the ordering the request actually resolved to**, column
 * and direction, rather than only naming the catch-up ordering against
 * everything else. The narrower split would rest on `sort` being set
 * explicitly, so that dropping it between pages is a visible caller error
 * while dropping a filter is the ordinary one; that holds for a
 * hand-written client and not for one assembling a request from parts,
 * which is the case this exists for. And under the narrow key every one of
 * the item listing's orderings would be tagged `created_at`, so a cursor
 * taken under `?sort=updated_at` replayed under `?sort=occurred_at` would
 * pass the check and bound the page against the wrong column: the exact
 * failure, reached through the guard against it.
 *
 * Direction is part of the key for the same reason the column is. The
 * comparison flips with it, so the same cursor replayed under the
 * opposite direction re-serves rows already delivered, silently and with
 * no more signal than the column case has.
 *
 * The key is computed from the *resolved* ordering, never from the raw
 * parameters, so a caller who omits `sort` on one page and spells out the
 * default on the next is not refused: both resolve to the same ordering
 * and therefore to the same key. A filter is not part of the key: it
 * narrows the rows, not the position the cursor names.
 */
export type CursorSortKey = string;

/** The listings that page by cursor, each named in the cursors it mints.
 *  An item's hydrated edge blocks mint under the listing their cursor
 *  continues at, `/items/{id}/edges` or `/items/{id}/backrefs`. */
export type CursorListing =
  | "items"
  | "edges"
  | "item-edges"
  | "item-backrefs"
  | "audit"
  | "webhook-deliveries";

/**
 * The identity a cursor carries. Every construction goes through here so
 * the spelling cannot drift between the encode side and the expectation
 * the decode side checks against.
 */
export function cursorSortKey(
  listing: CursorListing,
  sort:
    | { kind: "system"; column: SystemSortField }
    | { kind: "property"; field: string },
  direction: SortDirection,
): CursorSortKey {
  const column =
    sort.kind === "system" ? sort.column : `properties.${sort.field}`;
  return `${listing}:${column}:${direction}`;
}

const NEWEST_FIRST = { kind: "system", column: "created_at" } as const;

/** The one ordering each of these listings pages under, held here so the
 *  store that reads the listing's cursor and the route that mints one on
 *  its behalf (an item's hydrated edge blocks) spell the same key. */
export const ITEM_EDGES_CURSOR_KEY = cursorSortKey(
  "item-edges",
  NEWEST_FIRST,
  "desc",
);
export const ITEM_BACKREFS_CURSOR_KEY = cursorSortKey(
  "item-backrefs",
  NEWEST_FIRST,
  "desc",
);
export const AUDIT_CURSOR_KEY = cursorSortKey("audit", NEWEST_FIRST, "desc");
export const WEBHOOK_DELIVERIES_CURSOR_KEY = cursorSortKey(
  "webhook-deliveries",
  NEWEST_FIRST,
  "desc",
);
/** A connector's runs order by when they were reported, a column no item
 *  listing sorts by, so the key is spelled here rather than built. */
export const CONNECTOR_RUNS_CURSOR_KEY: CursorSortKey =
  "connector-runs:reported_at:desc";
/** Search ranks by relevance rather than by a column, so its cursor carries
 *  the position in the ranking and names the ranking as its key. */
export const SEARCH_CURSOR_KEY: CursorSortKey = "search:relevance:desc";

interface CursorPayload {
  v: string;
  id: string;
}

/** Like {@link CursorPayload} but the sort value may be `null`: only the
 *  item listing's `properties.<field>` sort produces one, for an absent
 *  field in the NULLS-LAST tail. Every system column is NOT NULL. */
interface NullableCursorPayload {
  v: string | null;
  id: string;
}

export function encodeKeyedCursor(
  sortValue: string | null,
  id: string,
  key: CursorSortKey,
): string {
  return Buffer.from(JSON.stringify({ v: sortValue, id, k: key })).toString(
    "base64url",
  );
}

function malformedCursor(): MarfaError {
  return new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    "Invalid pagination cursor",
  );
}

/** The payload as carried, its shape checked and its key not yet. */
function parseCursor(cursor: string): NullableCursorPayload & { k: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
  } catch {
    throw malformedCursor();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    !("id" in parsed) ||
    (typeof parsed.v !== "string" && parsed.v !== null) ||
    typeof parsed.id !== "string"
  ) {
    throw malformedCursor();
  }
  return {
    v: parsed.v,
    id: parsed.id,
    k: "k" in parsed ? parsed.k : undefined,
  };
}

/** The whole shape is checked before the key, in both decodes, so a
 *  malformed cursor reports as malformed rather than as one issued
 *  elsewhere. */
function assertCursorKey(carried: unknown, expected: CursorSortKey): void {
  if (carried !== expected) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "This cursor was issued by a different listing or ordering and cannot be continued here. Re-read the first page with the same parameters.",
    );
  }
}

/** The decode for the one listing whose sort value may be `null`. */
export function decodeKeyedCursorNullable(
  cursor: string,
  expected: CursorSortKey,
): NullableCursorPayload {
  const { v, id, k } = parseCursor(cursor);
  assertCursorKey(k, expected);
  return { v, id };
}

/** The decode for every listing whose sort column is NOT NULL. */
export function decodeKeyedCursor(
  cursor: string,
  expected: CursorSortKey,
): CursorPayload {
  const { v, id, k } = parseCursor(cursor);
  if (typeof v !== "string") throw malformedCursor();
  assertCursorKey(k, expected);
  return { v, id };
}

// ---------------------------------------------------------------------------
// Sub-store interfaces
// ---------------------------------------------------------------------------

/**
 * An item, plus what the server did if this write resolved a collision.
 *
 * The report rides on the returned object rather than widening the store's
 * return into a tuple: every caller of `update` reads an `Item`, and an
 * optional extra property leaves all of them working unchanged while the one
 * caller that reports it can pick it up. It is never persisted — the row has
 * no such column — and the route strips it off the item before answering.
 */
export type ResolvedItem = Item & {
  conflict_resolution?: ConflictResolutionReport;
  /**
   * The sibling row this write created, for the route to announce.
   *
   * **Server-internal, and stripped before the response.** It is here because
   * `publish` lives at the route and the row is written in the store's
   * transaction, so the two need a way to meet. A write that reaches no
   * `event_log` row is one a client can never learn about — see
   * `routes/bulk-reaches-the-log.test.ts` — and the whole point of a
   * conflicted copy is that the losing edit stays findable.
   *
   * Absent when the sibling already existed, which is the idempotent retry:
   * the run that actually wrote it announced it, and announcing again would
   * report a create that did not happen.
   */
  conflict_sibling?: Item;
};

/**
 * How this write wants a collision handled, carried down to the store because
 * the resolution happens inside the update's transaction.
 *
 * **Server-internal.** `conflict_mode` comes from the request's own query
 * parameter rather than from the caller's body, and `idempotency_key` is
 * read off the header the replay cache already owns; neither is a field a
 * client sets on an update payload.
 */
export interface ConflictResolutionInput {
  /** Absent means `manual`: the envelope. */
  conflict_mode?: ConflictMode;
  /**
   * The caller's `Idempotency-Key`, when it sent one. Only used to derive the
   * id of a keep-both sibling, so that a write which runs twice writes one.
   * Absent, the sibling gets a fresh id and a genuine re-execution duplicates
   * it — which is the honest outcome, since without a key the server has no
   * way to tell a retry from a second edit.
   */
  idempotency_key?: string;
}

/**
 * The version a row is being recreated at, for a restore.
 *
 * **Server-internal, and set on exactly one path.** A create otherwise starts
 * at 1; only a restore has a prior version to honor, and it is honored
 * because the row keeps its id. A row that came back at 1 under an id that had
 * reached 12 lets a client's stale precondition pass, later, against content
 * it never read — the one thing a version exists to prevent. Never
 * caller-supplied: a client that could choose its own version could forge
 * exactly that state.
 */
export interface RestoredRowInput {
  version?: number;
}

export type StoredCreateItemInput = CreateItemInput & RestoredRowInput;

export type StoredCreateEdgeInput = CreateEdgeInput & RestoredRowInput;
/**
 * The store's update input, which differs from the door's in one field.
 *
 * `version` is required on `PATCH /items/{id}`: a client that read the row
 * names what it is based on or it is not an update. It stays optional here
 * because the server writes rows no client read — a grant being revoked, a
 * bulk action working from a filter whose ids were frozen when the job was
 * made, an enrichment sweep, a create that resolved onto an existing row
 * without naming a version. Those writes are unconditional by design, and
 * `update` still branches on an absent `version` to serve them.
 */
export type StoredUpdateItemInput = Omit<UpdateItemInput, "version"> &
  ConflictResolutionInput & { version?: number };

export interface ItemStore {
  create(input: StoredCreateItemInput): Promise<Item>;
  get(id: string): Promise<Item | null>;
  /**
   * Fetch many items by id, as a map keyed by id; an id that resolves to
   * nothing is absent from the map rather than an error.
   *
   * Trashed rows are excluded by default, because every read surface treats a
   * soft-deleted item as gone. Three callers pass `includeTrashed`. Two are
   * in `bulk-actions/runner.ts`: purge, whose whole input is trashed rows,
   * and the tag chunk, which says at its own call site why it is
   * load-bearing there rather than defensive. Without it the purge runner's
   * pre-fetch would come back empty, so it would report every id as "not
   * found" while the delete underneath it succeeded. The third is the edge
   * read gate in `routes/_edge-visibility.ts`, which resolves an edge's
   * source to ask about its type: a plain read answers null for a trashed
   * source, and a null source has no type to refuse, so trashing the source
   * item would turn a refusal into a disclosure.
   */
  getMany(
    ids: string[],
    opts?: { includeTrashed?: boolean },
  ): Promise<Map<string, Item>>;
  /**
   * Like `get`, but returns trashed items too. Intended for callers that
   * need to read an item's metadata (e.g. its `type` for a permission
   * check) even when the item has been soft-deleted — the edge
   * PATCH/DELETE permission check is the canonical caller. Trashed
   * items are not returned by `get`/`list`, and do not leak to this
   * method via `restore` either; use the normal `restore()` to
   * un-trash.
   *
   * **`trashed` is the whole of the difference.** `get`
   * rejects on `state === "trashed"` and tests nothing else, so archived
   * and revoked rows come back from it already; this method drops that one
   * test and adds no other state. The pairing of names suggests a wider
   * gap than exists — that `get` means "active" and this means "any
   * state" — and a caller swapping to it is widening its input by exactly
   * one state rather than by four.
   */
  getIncludingTrashed(id: string): Promise<Item | null>;
  list(filters: ItemFilters): Promise<PaginatedResult<Item>>;
  /**
   * Look up a single non-trashed item by `(source, source_id)`. Returns
   * null if no row matches. Used by `/items/bulk` upsert
   * to decide create-vs-update without round-tripping a full `list`.
   */
  findBySourceId(source: string, sourceId: string): Promise<Item | null>;
  /**
   * Internal natural-key lookup that also returns a soft-deleted row. Use
   * this only when a caller must reconcile against the database uniqueness
   * constraint itself; normal API reads and upserts must keep using
   * `findBySourceId`, which hides trashed items.
   */
  findBySourceIdIncludingTrashed(
    source: string,
    sourceId: string,
  ): Promise<Item | null>;
  update(
    id: string,
    input: StoredUpdateItemInput,
  ): Promise<ResolvedItem | ConflictResponse | AncestorUnavailableResponse>;
  delete(id: string): Promise<void>;
  purge(id: string): Promise<void>;
  /**
   * Hard-delete every id in `ids`. Bypasses the
   * "must be trashed" gate that single-item `purge` enforces — bulk is an
   * admin cleanup primitive with explicit confirm. Cascades metadata and
   * versions via ON DELETE CASCADE; caller must have already wiped edges
   * (source + target directions). Cleans the search index for each id.
   * Returns the number of rows actually deleted (unknown ids are
   * silently skipped).
   */
  bulkPurge(ids: string[]): Promise<number>;
  restore(id: string): Promise<Item>;
  transition(id: string, state: ItemState): Promise<Item>;
  /**
   * How many items carry this exact type identifier.
   *
   * The only caller is the operator surface that decides whether a retired
   * shipped type can be removed: a row kept because items of it still exist
   * is kept for everyone, since the row is what makes those items resolve.
   *
   * `stats` groups by state rather than by type, so it cannot answer this,
   * and a list would page over rows to count them.
   *
   * **Exact identifier, not the subtree.** That matches the hand-written
   * retirement this generalizes, and it is the narrower reading: a
   * subtype's rows carry the subtype's identifier, so they are counted by
   * asking about the subtype.
   */
  countByType(type: string): Promise<number>;
  /**
   * Item counts for the instance, grouped on one axis.
   *
   * `by` chooses the axis and nothing else: both groupings cover the same
   * rows — everything this caller can read — so their totals agree. That is
   * the property `routes/items-stats-by-type.test.ts` asserts, and it is
   * what catches a breakdown that quietly dropped a filter the other keeps.
   *
   * `"type"` answers which types the instance actually uses, which nothing
   * else could without paging every row: `GET /types` lists what is
   * registered, a longer and different list, and `countByType` takes one
   * exact identifier per call.
   */
  stats(
    typeFilter?: TypeFilter,
    sourceFilter?: SourceFilterSettings,
    by?: ItemStatsAxis,
  ): Promise<Record<string, number>>;
  /**
   * Hard-delete every trashed item that entered the bin strictly before
   * `beforeDate` (an ISO 8601 timestamp). Cleans the search index for
   * each row. Returns the number of rows deleted.
   *
   * The window is measured from `trashed_at`, the time of the transition
   * into the soft-deleted state: `updated_at` is the modification time
   * rather than the removal time, and any write to a trashed row moves it,
   * so measuring from it would restart the retention clock on an edit made
   * in the bin. A trashed row with no stamp, which only the archive restore
   * writes, is measured from `updated_at`, the one clock it has.
   *
   * Unlike `bulkPurge`, this drops the purged items' edges itself (both
   * directions, inside the same transaction). It is the terminal step of
   * the automatic trash lifecycle with no route layer above it to do the
   * cleanup, and edges have no FK to items to fall back on.
   */
  purgeTrashedOlderThan(beforeDate: string): Promise<number>;
  /**
   * Hard-delete every `system.activity` item whose `created_at` is
   * strictly older than `beforeDate` (an ISO 8601 timestamp). Returns
   * the number of rows deleted.
   *
   * A sibling of `purgeTrashedOlderThan` rather than a reuse of it,
   * because activity rows are `active`: they are never trashed, so the
   * trash lifecycle never reaches them and nothing else did either.
   * Same obligations — clean the search index, drop edges in both
   * directions inside the transaction, since edges have no FK to items.
   *
   * Filters on `created_at` rather than `updated_at`. An activity row is
   * written once and never revised, so the two agree; `created_at` is
   * the one that states the intent, which is "how long we keep the
   * record of a run".
   */
  purgeActivityOlderThan(beforeDate: string): Promise<number>;
  /**
   * Hard-delete every revoked **application** grant tombstone whose
   * `properties.revoked_at` is strictly older than `beforeDate`. Returns the
   * number of rows deleted.
   *
   * **Predicated on `properties.status`, not on the item's `state`, and that
   * is the whole reason this could not reuse either sibling.** A grant revoked
   * through the ordinary user-facing path keeps `state: "active"` — the revoke
   * writes `status: "revoked"` and `revoked_at` and deliberately leaves the
   * lifecycle alone, so the record survives as a record. A sweep keyed on
   * `state` the way the trash purge is would match none of them.
   *
   * **`kind = 'app'` is load-bearing rather than tidiness.** A connector
   * uninstall writes the same `revoked` status onto a `system.connection` row
   * as a matter of routine, and that row is not a tombstone — it is a
   * connection somebody may reinstall. It is separately distinguishable
   * because the uninstall path also transitions the item to `state:
   * "revoked"`, but this predicate does not rely on that: it asks the question
   * it means.
   *
   * Filters on `revoked_at` rather than `updated_at`, on the same reasoning
   * `purgeActivityOlderThan` gives for `created_at`: `updated_at` moves on any
   * write, and the window here means "how long we keep the record of a
   * withdrawn grant".
   */
  purgeRevokedAppGrantsOlderThan(beforeDate: string): Promise<number>;
  /**
   * Every live app grant nobody has used since `cutoffIso`: kind `app`,
   * active on both lifecycle axes, and `last_used_at`, or `granted_at`
   * where the grant was never used, older than the cutoff. The inactivity
   * retirer walks this and runs the grant cascade on each; the columns it
   * returns are what the audit row names.
   */
  listInactiveAppGrants(cutoffIso: string): Promise<
    {
      id: string;
      clientId: string | null;
      authUserId: string | null;
      lastUsedAt: string | null;
      grantedAt: string | null;
      properties: Record<string, unknown>;
    }[]
  >;
}

/**
 * What `setExtensions` answers: the item's whole extensions map after the
 * write, and the modification time the write left on the item row.
 *
 * `updated_at` is null when nothing in the set announces, because then the
 * item row was never touched and there is no new value to report. A caller
 * publishing the item beside the write needs this half: the frame it holds
 * was read before the write, so announcing that one describes an
 * `updated_at` the row does not have. A client watermarking on the value
 * re-fetches on its next catch-up, and a client comparing it against a
 * later read sees a change nothing told it about.
 */
export interface SetExtensionsResult {
  extensions: Record<string, Record<string, unknown>>;
  updated_at: string | null;
}

export interface MetadataStore {
  get(itemId: string): Promise<Metadata>;
  getMany(itemIds: string[]): Promise<Metadata[]>;
  set(itemId: string, tags: string[]): Promise<Metadata>;
  merge(itemId: string, tags?: string[]): Promise<Metadata>;
  addTags(itemId: string, tags: string[]): Promise<Metadata>;
  removeTag(itemId: string, tag: string): Promise<Metadata>;
  /**
   * Enumerate the distinct set of tags in use across items visible to the
   * caller. Type-permission scoped when `allowedTypes` is provided (same
   * pattern as `ItemStore.list`), and counted over the active state, which
   * is the selection `ItemStore.list` answers: a tag counted on a row a
   * listing hides opens to an empty page.
   * Returns tags with their usage counts, sorted by count descending.
   */
  listTags(filters: {
    allowedTypes?: string[];
    /** Mirrors `ItemFilters.excluded_types`, and travels with
     *  `allowedTypes` for the same reason. */
    excludedTypes?: string[];
  }): Promise<{ tag: string; count: number }[]>;
  getExtensions(
    itemId: string,
  ): Promise<Record<string, Record<string, unknown>>>;
  /**
   * Batched read of extensions across many items in a single query. Used
   * by the list-hydration path (`GET /items?include=extensions`) to
   * avoid the N+1 pattern where a caller would otherwise hit
   * `GET /items/:id/extensions` once per listed item. The map's keys are
   * item ids; items with no persisted metadata row map to an empty
   * record.
   */
  getExtensionsForItems(
    itemIds: string[],
  ): Promise<Map<string, Record<string, Record<string, unknown>>>>;
  setExtension(
    itemId: string,
    namespace: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, Record<string, unknown>>>;
  /**
   * `setExtension` for several namespaces of one item at once, replacing
   * each named namespace and leaving the rest of the map alone.
   *
   * The extensions of an item are one JSON column, so writing them one
   * namespace at a time rewrites that column once per namespace and — for
   * every namespace that announces — bumps the item's modification time
   * again beside it. On the archive restore, which is the caller this
   * exists for, that multiplied by every item in the archive on the one
   * path whose whole purpose is moving a lot of rows at once. Passing the
   * set the caller already holds collapses it to one write of each row.
   *
   * The bump is decided once for the whole set: if any namespace in it
   * announces, the item is bumped once, which is what a caller writing
   * them together means by "the item changed". An empty set writes
   * nothing at all rather than touching the row to store what it already
   * holds.
   *
   * Unconditional replace, with `setExtension`'s hazard and not
   * `mutateExtension`'s guarantee: a value derived from a previous read
   * still belongs in `mutateExtension`.
   *
   * Answers the post-write modification time alongside the map, because
   * the caller this exists for publishes the item it just wrote and would
   * otherwise announce the value the row carried before the bump.
   */
  setExtensions(
    itemId: string,
    entries: Record<string, Record<string, unknown>>,
  ): Promise<SetExtensionsResult>;
  /**
   * Atomic namespace-scoped read / mutate / write. `mutate` is handed the
   * namespace's current contents (an empty record when unset) exactly
   * once and returns the replacement; the whole cycle runs inside a
   * single row-locked transaction. Returns the persisted contents.
   *
   * `setExtension` is the unconditional-replace variant: it commits a
   * value the caller computed from a snapshot taken earlier, so two
   * writers on one item can each overwrite the other's namespace from
   * stale state. Any write whose new value is derived from the old one
   * must go through this method instead.
   */
  mutateExtension(
    itemId: string,
    namespace: string,
    mutate: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  deleteExtension(
    itemId: string,
    namespace: string,
  ): Promise<Record<string, Record<string, unknown>>>;
}

/**
 * The item's own fields at a version, snapshotted beside its properties.
 *
 * The three fields an update may change that are not properties. Without
 * the value at the version the client read, a three-way merge cannot tell
 * the client having changed one from somebody else having changed it since,
 * and the only thing left to do with the client's value is take it — which
 * is a stale write overwriting a newer one with nothing refused.
 *
 * Not part of `Version`, which is what `GET /items/{id}/versions` answers:
 * the history door publishes the properties at each version and nothing
 * else, and this is read on the update path alone.
 */
export interface VersionedItemFields {
  tier: string | null;
  occurred_at: string | null;
  source_id: string | null;
}

/** A version row as the update path reads it. */
export interface VersionSnapshot extends Version {
  item_fields: VersionedItemFields;
}

export interface VersionStore {
  create(
    itemId: string,
    version: number,
    properties: Record<string, unknown>,
    itemFields: VersionedItemFields,
  ): Promise<Version>;
  list(itemId: string): Promise<Version[]>;
  getByVersion(
    itemId: string,
    version: number,
  ): Promise<VersionSnapshot | null>;
  getLatestTimestamp(itemId: string): Promise<string | null>;
  deleteByIds(ids: string[]): Promise<number>;
  /**
   * Pages over every version snapshot's parsed properties, instance-wide.
   * Exists for the `blob-orphans` housekeeping job: a hash referenced only
   * by history is
   * still referenced, because deleting it would strip the bytes out from
   * under a version read. Cursor is the version row id.
   */
  scanProperties(
    limit: number,
    cursor?: string,
  ): Promise<{
    properties: Record<string, unknown>[];
    cursor: string | null;
  }>;
  listThinningCandidates(
    threshold: number,
    limit: number,
  ): Promise<
    {
      itemId: string;
      type: string;
      versionCount: number;
    }[]
  >;
}

export interface TypeStore {
  /** Lists every type: the shipped core/system set plus the instance's own
   *  registrations. */
  list(): Promise<TypeSchema[]>;
  /** Resolves a type by id: the shipped set, then the instance's own. */
  get(id: string): Promise<TypeSchema | undefined>;
  create(schema: TypeSchema, provenance?: TypeProvenance): Promise<TypeSchema>;
  update(id: string, schema: TypeSchema): Promise<TypeSchema>;
  delete(id: string): Promise<void>;
  /** The instance's own registrations, without the shipped core and system
   *  set `list` folds in. Exists because an export has to carry the
   *  registrations a restore would otherwise be missing, and only the
   *  instance's own are the instance's to carry. */
  listRegistered(): Promise<TypeSchema[]>;
  /**
   * The instance's registrations with their stored provenance.
   *
   * `listRegistered` returns bare schemas, which is all its two other
   * callers need. This exists because deciding what a type IS cannot be
   * done from its identifier: a vendor's `readwise.book` and a person's
   * `jonah.reading_item` under a claimed handle are the same shape, and
   * only the stored `origin` separates them.
   */
  listRegisteredWithProvenance(): Promise<LoadedType[]>;
  /** Every row for server-startup registry warmup, the platform-seeded
   *  ones included — which is what separates this from `listRegistered`. */
  loadAll(): Promise<LoadedType[]>;
  /**
   * Install the shipped vocabulary, and answer with any shipped id that
   * collided with a registration this seed did not write.
   *
   * **The return value is the whole of the collision handling.** An
   * instance stores its own registrations in the same table the seed writes
   * to, so a build that starts shipping an identifier somebody already
   * registered would otherwise rewrite their schema unattended on the next
   * boot. The seed leaves such a row alone; deciding what to do about it
   * belongs to a person, not to a boot path that runs on every instance.
   */
  seedPlatformTypes(seeded: readonly SeededPlatformType[]): Promise<string[]>;
  /**
   * Remove one platform row the build no longer ships. Answers whether a
   * row was actually deleted.
   *
   * **Scoped to `origin = 'platform'`.** Nothing else writes that origin,
   * a rule the archive restore enforces by refusing to write a platform
   * origin.
   *
   * No guard of its own: whether removal is safe is a question about
   * items, which this layer cannot see. The caller decides and this
   * performs.
   *
   * **Evicts the in-process registry entry too, as `delete` does.** The row
   * and the registry are both what makes a type resolve, so removing one
   * without the other leaves the identifier answering every read until the
   * next restart, with the route that removed it reporting success.
   */
  deletePlatformType(id: string): Promise<boolean>;
  countRegistered(): Promise<number>;
}

/** Where a registered type came from, written alongside its schema. */
export interface TypeProvenance {
  origin: TypeOrigin;
  /**
   * What kind of type this is: core content, a connector's own shape,
   * or a structural platform record.
   *
   * **Asked of every type, not of the shipped set alone.** The question
   * "what kind of type is this" is asked of every type, and answering it
   * from the identifier cannot separate a vendor's type from a person's
   * under a claimed handle.
   *
   * Absent for `user` rows, which is not a gap — a type a person
   * registered belongs to no platform family and never did.
   */
  family?: PlatformTypeFamily;
  /** Manifest name of the publishing connector, for `connector` rows. */
  owner_connector?: string;
}

/** A type schema as loaded at startup, the shape the warmup registers. */
export interface LoadedType {
  schema: TypeSchema;
  /** Provenance as stored. `NOT NULL DEFAULT 'user'`, so a row carries one
   *  whatever wrote it. */
  origin: TypeOrigin;
  family?: PlatformTypeFamily;
  owner_connector?: string;
}

export interface EdgeTypeStore {
  /** Every row in the table. There is no narrower read beside this one:
   *  `edge_types` has no `origin` column and nothing seeds it, so a row is
   *  there because a caller registered it. */
  list(): Promise<EdgeTypeSchema[]>;
  get(id: string): Promise<EdgeTypeSchema | undefined>;
  create(schema: EdgeTypeSchema): Promise<EdgeTypeSchema>;
  delete(id: string): Promise<void>;
}

export interface SearchStore {
  search(query: string, filters: SearchFilters): Promise<SearchResult[]>;
  /** Write the item's row: its searchable text, and the tags its sidecar
   *  holds at the time of the write. */
  index(
    itemId: string,
    properties: Record<string, unknown>,
    typeId?: string,
  ): Promise<void>;
  /** Replace the tags on the item's row. The metadata store calls this
   *  from every tag write, so a tag is findable the moment it is set;
   *  `GET /search` says it indexes tags, and this is what makes that so. */
  setTags(itemId: string, tags: readonly string[]): Promise<void>;
  remove(itemId: string): Promise<void>;
}

/**
 * What a revoke did, rather than whether it did anything.
 *
 * A revoke has three outcomes and a boolean carries two of them, which is
 * how a route came to answer `{ ok: true }` for an id that matched no row at
 * all: the operator key had nothing else left to ask. `"already_revoked"` and `"not_found"` are both misses and both refuse,
 * but they are different mistakes to have made and the answer says which.
 */
export type KeyRevokeOutcome = "revoked" | "already_revoked" | "not_found";

export interface KeyStore {
  /**
   * Mint a key.
   *
   * `oauth_client_id` is an intersection rather than a field on
   * `CreateKeyInput` for the same reason `keyHash` is a separate parameter:
   * it is set by the server from who is calling, never from a request body,
   * and `CreateKeyInput` is the shape a route builds from a body, where a
   * settable field would read as something a caller may ask for. It
   * records that an app minted this key rather than a person, which is what
   * ties the key to that app and what `extensionLabelOf` reads to refuse a
   * label claim.
   */
  create(
    input: CreateKeyInput & { oauth_client_id?: string },
    keyHash: string,
  ): Promise<ApiKey>;
  list(): Promise<ApiKey[]>;
  get(id: string): Promise<ApiKey | null>;
  validate(
    keyHash: string,
  ): Promise<(ApiKey & { key_hash: string; revoked_at: string | null }) | null>;
  update(id: string, input: UpdateKeyInput): Promise<ApiKey>;
  /**
   * Stamp `revoked_at`, and say which of the three things happened. Only
   * `"revoked"` means this call was the one that retired the key, so a
   * caller listing the credentials it retired lists the ones it actually
   * retired.
   *
   * **The two misses are told apart here because nothing above can tell
   * them apart.** `get` drops revoked rows, so an id nobody holds and a key
   * already retired both read as absent through it, and a route asking that
   * question afterwards would be answering from a second query against a
   * row this call has already decided about.
   */
  revoke(id: string): Promise<KeyRevokeOutcome>;
  updateLastUsed(id: string): Promise<void>;
  count(): Promise<number>;
  /**
   * Hard-delete revoked keys whose `revoked_at` is older than `cutoffIso`.
   * Returns the number deleted.
   */
  deleteRevokedKeysOlderThan(cutoffIso: string): Promise<number>;
}

/** The kinds of store this build can attach. A row outside the set is
 *  counted at boot by `stored-value-scan.ts`. */
export const BLOB_STORE_KINDS = ["disk", "s3"] as const;
export type BlobStoreKind = (typeof BLOB_STORE_KINDS)[number];

/** One row of `blob_stores`: a place bytes live that this instance attached. */
export interface BlobStoreRow {
  id: string;
  kind: BlobStoreKind;
  locator: string;
  policy: string;
  attached_at: string;
  detached_at: string | null;
}

/** One row of the location log, joined with the store it names. */
export interface BlobLocation {
  store_id: string;
  kind: BlobStoreKind;
  policy: string;
  /** True when the configuration no longer names the store. A detached
   *  store's copy is not counted, because nothing can reach it to check. */
  detached: boolean;
  recorded_at: string;
  verified_at: string | null;
}

/**
 * The blob registry: one row per content hash, the stores this instance
 * has attached, and the location log that says which stores hold which
 * blob. The bytes themselves live behind `BlobStore`.
 */
export interface BlobRegistry {
  register(hash: string, mimeType: string, sizeBytes: number): Promise<void>;
  get(hash: string): Promise<{
    mime_type: string;
    size_bytes: number;
  } | null>;
  /** Every registered hash. */
  listAll(): Promise<string[]>;
  remove(hash: string): Promise<void>;
  count(): Promise<{ count: number; total_size_bytes: number }>;

  /**
   * Record a store the configuration names, by the id its own marker holds.
   * Idempotent: a store attached again keeps its row and loses any
   * `detached_at`.
   */
  attachStore(store: {
    id: string;
    kind: BlobStoreKind;
    locator: string;
  }): Promise<void>;
  /** Mark every store not in `ids` detached. Returns how many were. */
  detachStoresExcept(ids: readonly string[]): Promise<number>;
  listStores(): Promise<BlobStoreRow[]>;

  /**
   * Write a location row: the store holds the bytes and they hashed to
   * their name. Idempotent.
   */
  recordLocation(hash: string, storeId: string): Promise<void>;
  listLocations(hash: string): Promise<BlobLocation[]>;
  /** Strike one store's copy from the log. True when a row went. */
  removeLocation(hash: string, storeId: string): Promise<boolean>;
  /**
   * Remove one store's copy from the log only if at least `minCopies`
   * copies in attached stores would remain, decided in the one statement
   * so no second writer can slip between the count and the removal.
   * `"dropped"`, `"below_minimum"`, or `"absent"` when no such row exists.
   */
  dropLocationKeeping(
    hash: string,
    storeId: string,
    minCopies: number,
  ): Promise<"dropped" | "below_minimum" | "absent">;
  /** Stamp a copy the integrity check found present and intact. */
  markVerified(hash: string, storeId: string, at: string): Promise<void>;
  /**
   * Blobs `storeId` lacks that some other attached store holds: what
   * replication copies next, oldest registration first, at most `limit`.
   */
  listMissingFrom(storeId: string, limit: number): Promise<BlobSizedRef[]>;
  /** How many blobs `storeId` lacks that some other attached store holds. */
  countMissingFrom(storeId: string): Promise<number>;
  /**
   * The copies a check should look at next, across `storeIds`: never
   * checked first, then the least recently checked, at most `limit`.
   */
  listToVerify(
    storeIds: readonly string[],
    limit: number,
  ): Promise<BlobCopyRef[]>;

  /**
   * Make the orphan report say exactly `hashes`: a hash already reported
   * keeps its first `reported_at`, a new one is recorded at `at`, and a row
   * for a hash no longer in the set is removed. Answers how many rows the
   * report holds afterwards.
   */
  retainOrphans(hashes: readonly string[], at: string): Promise<number>;
  /** The report, oldest first. */
  listOrphans(): Promise<BlobOrphanRow[]>;
  /**
   * Reported orphans whose first report is strictly before `before` and
   * strictly before `runStartedAt`: what a run may purge. The first bound
   * is the grace, the second keeps a run from purging what it reported
   * itself.
   */
  listOrphansToPurge(before: string, runStartedAt: string): Promise<string[]>;
}

/** A blob by hash with the size its row records. */
export interface BlobSizedRef {
  hash: string;
  size_bytes: number;
}

/** One copy: a blob and the store the log says holds it. */
export interface BlobCopyRef extends BlobSizedRef {
  store_id: string;
}

/** One row of the orphan report: a blob nothing references, and when a run
 *  first said so. */
export interface BlobOrphanRow {
  hash: string;
  mime_type: string;
  size_bytes: number;
  reported_at: string;
}

export interface WebhookStore {
  create(input: CreateWebhookInput): Promise<Webhook>;
  list(): Promise<Webhook[]>;
  get(id: string): Promise<Webhook | null>;
  update(id: string, input: UpdateWebhookInput): Promise<Webhook>;
  delete(id: string): Promise<void>;
  listActive(): Promise<Webhook[]>;
  count(): Promise<number>;
}

/**
 * Row shape returned by `getPending` and `claimById` — the subset of the
 * delivery row that the poller / direct-dispatcher needs to make an HTTP
 * attempt and write its outcome.
 */
export interface PendingWebhookDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  payload: string;
  webhook_url: string;
  webhook_secret: string;
  attempt: number;
  max_attempts: number;
}

export interface WebhookDeliveryStore {
  log(entry: {
    webhookId: string;
    eventType: string;
    statusCode?: number;
    attempt: number;
    succeeded: boolean;
    error?: string;
  }): Promise<void>;
  /** A subscription's deliveries, newest first, one page at a time. */
  list(
    webhookId: string,
    page: { limit: number; cursor?: string },
  ): Promise<PaginatedResult<WebhookDelivery>>;
  schedule(entry: {
    webhookId: string;
    eventType: string;
    payload: string;
    webhookUrl: string;
    webhookSecret: string;
    nextAttemptAt: string;
  }): Promise<string>;
  getPending(now: string, limit?: number): Promise<PendingWebhookDelivery[]>;
  /**
   * Atomic single-row claim for best-effort direct dispatch. Succeeds only
   * when the row is still `status = 'pending'` and still past its
   * `next_attempt_at` — otherwise returns `null`. On success, the row's
   * `next_attempt_at` is pushed forward to `claimExpiry` so the poller's
   * next run does not see it. Same lock-ttl semantics as `getPending`.
   */
  claimById(
    id: string,
    claimExpiry: string,
    now: string,
  ): Promise<PendingWebhookDelivery | null>;
  markSuccess(id: string, statusCode: number, attempt: number): Promise<void>;
  markFailed(
    id: string,
    statusCode: number | undefined,
    error: string,
    attempt: number,
    nextAttemptAt: string | null,
  ): Promise<void>;
  markDeadLetter(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// @better-auth/oauth-provider read helpers
// ---------------------------------------------------------------------------

/**
 * Thin read helpers over the @better-auth/oauth-provider plugin's tables
 * (`auth_oauth_client`, `auth_oauth_consent`). Used by:
 *
 *   - the `/auth/authorize` consent route, which needs the client's
 *     friendly name and the user's prior consent (for the re-consent
 *     diff render)
 *   - the grant-projection after-hooks in `auth/oauth-provider.ts`,
 *     which need to resolve the client_id ↔ system.connection link
 *
 * Direct Drizzle reads against the plugin's tables; the plugin itself
 * is the authoritative writer. Kept as a separate store so the consent
 * route doesn't have to peek into the plugin's Drizzle internals.
 */
export interface OauthAccessTokenRow {
  id: string;
  userId: string | null;
  clientId: string;
  scopes: string[];
  expiresAtMs: number | null;
  createdAtMs: number | null;
}

export interface OauthClientRow {
  /** Internal PK on `auth_oauth_client.id`. */
  id: string;
  /** The unique business key — what RPs identify themselves with. */
  clientId: string;
  name: string | null;
  redirectUris: string[];
  /** Exact post-logout redirect URIs accepted for this client. */
  postLogoutRedirectUris: string[];
  /**
   * `true` when the client is a public client (PKCE, no secret) —
   * `token_endpoint_auth_method: none` and/or `public: true`. Public
   * clients are the shape every unauthenticated Dynamic Client
   * Registration (DCR) client takes: they self-assert their `client_name`
   * with no verified identity behind it. The consent screen reads this to
   * flag the app as unverified so a user can tell a self-asserted name
   * from one backed by a confidential, vetted client. `false` for a
   * confidential client (one that authenticates with a secret).
   */
  isPublic: boolean;
  /**
   * The client's registered scope ceiling, or `null` when it holds none.
   *
   * The distinction is load-bearing and NOT a tidiness question. The OAuth
   * plugin resolves the set it validates against as
   * `client.scopes ?? opts.scopes`, so `null` means "track whatever the
   * server currently advertises" while `[]` is a real, empty ceiling that
   * invalidates every scope a client could ask for. Collapsing the two —
   * by defaulting to `[]` on read, or by writing `[]` where `null` was
   * meant — turns a client that follows the live registry into one that
   * can request nothing at all.
   */
  scopes: string[] | null;
  /**
   * The grant types the client registered for, or `null` when it named
   * none.
   *
   * `null` carries the same "no declaration" reading as `scopes`, and for
   * the same reason: a client that never said is not a client that said
   * nothing. The plugin checks the *server's* supported grant types and
   * never the client's own, so this is only consulted where Marfa owns the
   * grant itself — today, the device flow.
   */
  grantTypes: string[] | null;
}

/**
 * Input to `OauthProviderStore.createClient`: a client row written directly,
 * with the JSON-encoded string[] columns the rest of Marfa's write paths
 * use. The product writer of `auth_oauth_client` is the provider plugin's
 * own `POST /auth/oauth2/register`; this is the seam the tests use to put a
 * client in front of the endpoints that registration would not produce (a
 * stale ceiling, a confidential client with a known secret, a client
 * registered for a grant the server no longer issues).
 */
export interface CreateClientInput {
  /** The new client's business key (returned to the caller). */
  clientId: string;
  /** Friendly name for the consent screen. */
  name: string | null;
  /** Public client (PKCE, no secret) per RFC 7591 §2.3. */
  isPublic: boolean;
  /** Allowed grant types, including the device-code URN. */
  grantTypes: readonly string[];
  /** Response types — pinned to `["code"]` for `authorization_code` */
  responseTypes: readonly string[];
  /** Token endpoint auth method (`none` for public, `client_secret_*`
   *  for confidential). */
  tokenEndpointAuthMethod: string;
  /**
   * The client's scope ceiling, or `null` to register no ceiling at all.
   *
   * `null` is not "the empty set" and not a tidier spelling of "everything
   * currently allowed". The plugin resolves the set it validates against as
   * `client.scopes ?? opts.scopes`, so a `null` column means the client
   * tracks whatever the server advertises **at check time**, while any
   * array is frozen at the moment it is written. Since the server's
   * allowlist is rebuilt from the type and edge registries on every boot,
   * an array written today is stale the next time a type is added or
   * removed — in both directions.
   *
   * First-party clients register `null` for exactly that reason. A
   * third-party client registered through DCR keeps a real array, because
   * there the ceiling is a security boundary the client asked for rather
   * than a copy of ours.
   */
  scopes: readonly string[] | null;
  /** Allowed redirect URIs. May be empty for clients that only run the
   *  device-code grant (no browser redirect). */
  redirectUris: readonly string[];
  /** Exact post-logout redirect URIs accepted for browser logout. */
  postLogoutRedirectUris?: readonly string[];
  /** Optional client metadata fields (passed through to the row). */
  clientUri?: string | null;
  logoUri?: string | null;
  tosUri?: string | null;
  policyUri?: string | null;
  contacts?: readonly string[] | null;
  softwareId?: string | null;
  softwareVersion?: string | null;
  softwareStatement?: string | null;
  type?: string | null;
}

export interface CreateClientResult {
  /** The internal PK on `auth_oauth_client.id`. */
  id: string;
  /** Echoed back from `input.clientId`. */
  clientId: string;
  /** Issued-at, unix seconds. */
  clientIdIssuedAt: number;
}

export interface MintTokenPairInput {
  /** The pre-computed hash of the access-token string (output of
   *  `storeTokens.hash` = `hashApiKey(token, salt)`). The plugin's
   *  bearer middleware looks this up by exact match. */
  accessTokenHash: string;
  /**
   * Pre-computed hash of the refresh-token string, or `undefined` to mint an
   * access token alone.
   *
   * Absent is the shape for a grant that did not ask to stay signed in. The
   * library issues a refresh token only when the approved scopes carry
   * `offline_access`, and only tokens it issued that way ever rotate, so a
   * refresh token minted here without the scope would be a credential nothing
   * could revoke by rotation. The access-token row then carries a null
   * `refresh_id`, which the column already permits.
   */
  refreshTokenHash?: string;
  clientId: string;
  authUserId: string;
  scopes: string[];
  /** TTL milliseconds for the access token. The refresh token gets
   *  a longer TTL set inside the implementation (mirrors the plugin's
   *  default 30d). */
  accessTtlMs: number;
}

export interface OauthProviderStore {
  /** Look up a registered client's friendly name by its `client_id`.
   *  Returns `undefined` if the client doesn't exist. */
  getClientName(clientId: string): Promise<string | undefined>;
  /** Full client row by business key. Used by the device-flow initiation
   *  path to validate `redirect_uri` and resolve a display name. */
  getClient(clientId: string): Promise<OauthClientRow | null>;
  /**
   * Widen a client's stored scope ceiling, but only while it still holds
   * exactly `expectedScopes`. Returns true when the write landed, false
   * when there was no client or its ceiling had already moved on.
   *
   * `auth_oauth_client.scopes` is otherwise written once, at registration,
   * and never again, so it is a snapshot of an allowlist that moves
   * whenever the type registry does. A client therefore ages out of the
   * platform silently: a type registered after the client was is
   * uncoverable by it forever. This is how the ceiling catches up.
   *
   * The guard is the same shape as `setConsentScopes` below and is
   * there for the same reason: the ceiling was read before the decision to
   * widen it, so it is only still the truth if nothing else has touched
   * the row since. A concurrent registration update is left alone rather
   * than overwritten by a stale set.
   *
   * Widen only. Nothing here removes a scope, because a stale ceiling is
   * stale in both directions and the two want different handling: a scope
   * for a type that no longer exists is already dropped at request time
   * against the live allowlist, where it costs nothing and needs no write.
   */
  widenClientScopes(
    clientId: string,
    expectedScopes: readonly string[],
    scopes: readonly string[],
  ): Promise<boolean>;
  /** Look up the user's most recent prior consent scopes for
   *  (clientId, authUserId). Returns the scope literals from the
   *  `auth_oauth_consent` row, or `undefined` if no prior grant. */
  getPriorConsent(
    clientId: string,
    authUserId: string,
  ): Promise<readonly string[] | undefined>;
  /**
   * Overwrite the scope literals on the same `auth_oauth_consent` row
   * `getPriorConsent` reads (most recent by `updated_at`), but only while
   * that row still holds exactly `expectedScopes`. Returns true when the
   * write landed, false when there was no row or its scopes had moved on.
   *
   * Exists for one caller: the silent re-authorization path in
   * `routes/auth-consent.ts`. The OAuth Provider plugin rewrites the
   * stored consent scopes to the *requested* set on every accept, so a
   * narrower request against a wider standing grant would silently shrink
   * what the user approved — with no interaction to authorize the
   * narrowing. The route restores the wider set afterwards.
   *
   * The guard exists because `scopes` was read before the plugin ran, so
   * it is only still the truth if nothing else has touched the grant
   * since. Passing the value the plugin was told to write means a
   * revocation or a narrowing that landed after that write is left alone
   * instead of being overwritten by a stale set.
   *
   * **It narrows the window rather than closing it.** A competing write
   * that lands *before* the plugin's own rewrite is erased by that
   * rewrite, so the row still holds `expectedScopes` when the restoration
   * arrives and the guard admits it. Serializing the whole read-decide-
   * write sequence is what actually closes the race; the caller does that
   * per (client, user) in-process, and this check is the fence that still
   * stands when the competing write comes from another process.
   *
   * Not a general-purpose consent editor: widening a grant must go
   * through the consent screen.
   */
  setConsentScopes(
    clientId: string,
    authUserId: string,
    scopes: readonly string[],
    expectedScopes: readonly string[],
  ): Promise<boolean>;
  /**
   * Write the plugin's consent row for `(clientId, authUserId)`: create it,
   * or replace its scopes if one exists.
   * One statement, arbitrated by the unique index on the pair, so two
   * writers cannot leave two rows or a constraint error.
   *
   * The row is what both consent checks read: the plugin's own, inside its
   * authorize endpoint, which skips its screen when the row holds every
   * requested scope literally, and Marfa's, on `GET /auth/authorize`, which
   * skips when the row covers the request by pattern. A device approval
   * never passes through the plugin's consent endpoint, so without this
   * write a device grant had a projection and no row, and every later
   * browser authorize for the same app rendered consent afresh.
   *
   * `scopes` is the projection's merged set, not this approval alone, and
   * it replaces the scopes the row held (claims and resources, which the
   * device flow never writes, stand): the projection is the grant and the
   * row mirrors it. The two can differ when a row stands with no projection
   * beside it (the code flow logs a failed projection write and issues its
   * code anyway); a later device approval then narrows the row to what the
   * person just approved, deliberately. That is less recorded consent
   * rather than more, since tokens already issued outlive the row, and the
   * browser asks again for the rest.
   */
  upsertConsent(input: {
    clientId: string;
    authUserId: string;
    scopes: readonly string[];
  }): Promise<void>;
  /** Bearer-middleware lookup over `auth_oauth_access_token`. Returns the
   *  row keyed by the hashed token output of `storeTokens.hash` (which is
   *  `hashApiKey(token, salt)`), or null if the token isn't recognized or
   *  has expired. Opaque tokens carry no embedded claims, so the row is
   *  read directly. */
  validateAccessToken(tokenHash: string): Promise<OauthAccessTokenRow | null>;
  /** Cascade revocation for a grant: delete every access + refresh token
   *  for (clientId, authUserId). Used by the `/auth/grants/:id/revoke`
   *  handler when the user revokes an app's access. The grant's
   *  `auth_oauth_consent` row is also deleted (the plugin will require
   *  re-consent on the next authorize attempt). */
  revokeTokensForGrant(clientId: string, authUserId: string): Promise<void>;
  /**
   * Delete every outstanding authorization code for (clientId, authUserId).
   *
   * Codes are not in the plugin's own tables: they are `auth_verification`
   * rows whose `value` is a JSON blob naming the grant, so they survived
   * every revocation path that only swept the token and consent tables.
   * That mattered more than the ten-minute code lifetime suggests, because
   * redeeming a code after the revoke yields a refresh token that rotates
   * indefinitely — a short race converting into a permanent grant while the
   * user's own security page reports the app as revoked.
   *
   * Called by `revokeTokensForGrant`, so every revocation path gets it.
   * Idempotent.
   */
  revokeAuthorizationCodesForGrant(
    clientId: string,
    authUserId: string,
  ): Promise<void>;
  /**
   * Resolve an outstanding authorization code to the grant it belongs to,
   * and say whether that grant is still consented.
   *
   * Backs the exchange-time refusal. Deleting codes on revoke is the
   * mechanism; this is the check that holds when a code was minted in the
   * window between the two, or when some future revocation path forgets to
   * sweep them. `hasConsent: false` means the user has revoked the app and
   * the code must not be redeemable.
   *
   * Returns null for a code this store does not recognize, which the caller
   * treats as "not ours" and passes through rather than refusing.
   */
  findAuthorizationCodeGrantKey(codeHash: string): Promise<{
    clientId: string;
    userId: string;
    hasConsent: boolean;
  } | null>;
  /**
   * Delete ONLY access tokens for a grant — leaves refresh tokens + consent
   * intact. Used by the `/oauth2/token` before-hook on refresh-token replay
   * detection: the plugin's own logic deletes the refresh chain on
   * stale-refresh detection but leaves access tokens valid until their TTL
   * (default 1h). This narrows that window to zero by zapping access tokens
   * pre-emptively when a revoked refresh is detected in the request.
   *
   * Idempotent — re-calling on an already-cleaned grant is a no-op.
   * Best-effort; callers swallow errors.
   */
  revokeAccessTokensForGrant(
    clientId: string,
    authUserId: string,
  ): Promise<void>;
  /**
   * Look up a refresh-token row by its hashed `token` column value. Returns
   * the (clientId, userId, revoked) tuple needed to decide whether the
   * request is a replay attempt and whose access tokens to revoke. Returns
   * null if the token doesn't exist (e.g.
   * already deleted by a prior chain-revocation pass).
   */
  findRefreshTokenGrantKey(tokenHash: string): Promise<{
    clientId: string;
    userId: string;
    revoked: boolean;
  } | null>;
  /** Insert an access + refresh token pair from the device-flow terminal
   *  step. Writes into `auth_oauth_access_token` + `auth_oauth_refresh_token`
   *  with the same shape the plugin's `/oauth2/token` path would produce,
   *  so the bearer middleware resolves them uniformly. */
  mintTokenPair(input: MintTokenPairInput): Promise<void>;
  /** Insert a row into `auth_oauth_client` with JSON-encoded string[]
   *  columns matching the rest of Marfa's write paths. The plugin's
   *  registration is the product writer; see `CreateClientInput` for what
   *  this seam is for. */
  createClient(input: CreateClientInput): Promise<CreateClientResult>;
  /**
   * Every `system.connection { kind: "app" }` projection carrying this
   * client id, whatever either lifecycle axis says. The
   * operator's client delete walks this list, so it has to see the
   * tombstones `findGrantItemId` deliberately hides: a projection left
   * behind by a hand-deleted client row is exactly what that route exists
   * to remove.
   */
  listGrantItemsForClient(clientId: string): Promise<
    {
      id: string;
      authUserId: string | null;
      state: string;
    }[]
  >;
  /**
   * Delete every authorization code minted for this client, for every user.
   * Codes are `auth_verification` rows rather than plugin tables, so the
   * per-client sweep of tokens and consents does not reach them; the grant
   * cascade reaches them per (client, user), and a user whose projection is
   * already gone has no cascade. Returns the number of rows deleted.
   */
  revokeAuthorizationCodesForClient(clientId: string): Promise<number>;
  /**
   * Delete every plugin record keyed on this client id: access tokens,
   * refresh tokens and consent rows, across every user. The per-grant
   * cascade reaches the rows a projection names; this reaches the rest,
   * which is what a client whose projections were removed by hand leaves
   * behind. Returns the counts, for the audit row.
   */
  deleteClientRecords(clientId: string): Promise<{
    accessTokens: number;
    refreshTokens: number;
    consents: number;
  }>;
  /** Delete the `auth_oauth_client` row. Returns false when there was none,
   *  which is what makes the admin delete idempotent and the orphan repair
   *  the same call. */
  deleteClient(clientId: string): Promise<boolean>;
  /**
   * Resolve the projected `system.connection { kind: "app" }` item id for a
   * (clientId, authUserId) pair. Returns the `items.id` value or
   * `null` if no projection exists (consent never ran, or the row was
   * hard-deleted).
   *
   * Used by the bearer middleware to find the `system.connection` row it
   * needs to stamp `last_used_at` on, and by the re-consent path to update
   * the row's `scopes` property when the user grants a different scope set.
   *
   * Single-row query: matches on `type` and predicates on
   * `properties.kind / .client_id / .user_id` via `json_extract`.
   */
  findGrantItemId(opts: {
    clientId: string;
    authUserId: string;
  }): Promise<string | null>;
  /**
   * Reaper for grantless DCR clients. Hard-deletes every `auth_oauth_client`
   * row that is BOTH:
   *
   *   - older than `cutoffIso` (`created_at < cutoffIso`), AND
   *   - grantless — no `auth_oauth_access_token` row, no
   *     `auth_oauth_refresh_token` row, and no projected
   *     `system.connection { kind: "app" }` item — for its `client_id`.
   *
   * Unauthenticated DCR (`allowUnauthenticatedClientRegistration: true`)
   * means clients accumulate forever with no natural reaper; an abandoned
   * registration that was never consented to is pure dead weight. The
   * conservative shape (delete only when ALL three grant signals are
   * absent) guarantees a client a user actually authorized — or one with
   * any live token — is never reaped. Returns the number of rows deleted.
   *
   * A row with zero grants is dead whoever registered it.
   */
  deleteGrantlessClientsOlderThan(cutoffIso: string): Promise<number>;
  /**
   * Conditional `last_used_at` stamp on the underlying `system.connection`
   * (kind: app) for an OAuth grant. Mirrors `KeyStore.updateLastUsed` in
   * shape: the WHERE clause only writes when the existing
   * `properties.last_used_at` is NULL or older than `now - thresholdMs`,
   * so the row is updated at most once per `thresholdMs` regardless of
   * how many callers race.
   *
   * The auth middleware layers a per-process in-memory cache on top to
   * skip the DB round-trip when it has already stamped inside the window —
   * that cache is a first-line short-circuit, not the authoritative
   * throttle. The conditional UPDATE here is.
   *
   * Best-effort: callers swallow errors. The middleware-side cache mark
   * already prevents a stampede; storage failures must never break the
   * auth path.
   */
  updateLastUsedAt(
    connectionItemId: string,
    thresholdMs: number,
  ): Promise<void>;
  /**
   * Resolves once every in-flight `updateLastUsedAt` stamp has settled.
   * The stamp is fire-and-forget from the bearer middleware, so `close()`
   * drains it the way the audit store drains its writes — a stamp still
   * opening a connection when the database closes is otherwise an
   * unhandled rejection.
   */
  drain(): Promise<void>;
  /**
   * Resolve an approved device code to the grant it belongs to, and say
   * whether that grant is still consented and its projection live on both
   * lifecycle axes. A code in any other state resolves to null, because
   * until it is approved there is no grant to judge it against. The device twin of `findAuthorizationCodeGrantKey`,
   * backing the same exchange-time refusal: revoking a grant sweeps its
   * device codes, and this is the check that holds for a code approved in
   * the window between the two writes, for a grant soft-deleted out of the
   * active state, and for one whose projection was purged.
   *
   * Returns null for a code this store does not recognize, or one no person
   * has claimed yet, which the caller passes through to the plugin.
   */
  findDeviceCodeGrantKey(deviceCode: string): Promise<{
    clientId: string;
    userId: string;
    hasConsent: boolean;
  } | null>;
  /**
   * Rewrite a pending device code's `scope` to the set the person ticked.
   *
   * The plugin approves a code as it was requested and issues the token for
   * the row's scope, so a narrowing on the consent screen has to reach the
   * row before the approval does. Conditional on the row still being
   * pending; returns false when it was not.
   */
  narrowDeviceCodeScope(
    userCode: string,
    scopes: readonly string[],
  ): Promise<boolean>;
  /**
   * Delete every device code claimed by this user for this client, so
   * revoking the grant leaves nothing behind that can still be exchanged
   * for a token.
   *
   * **Keyed on the (client, user) pair, never on the client alone.** A
   * pending code nobody has claimed carries no user, so a sweep by client
   * would delete every other person's in-flight device login for that app,
   * turning one revoke into a denial of service across everyone using it.
   * A pending code for the same client that this user has not claimed
   * survives, and that is correct rather than a gap: approving it runs the
   * grant projection, which is a fresh consent the user has just given.
   */
  deleteDeviceCodesForGrant(
    clientId: string,
    authUserId: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Audit store
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  created_at: string;
  key_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  /** The peer the request came from, or null for a write the server
   *  made on its own (a retention sweep, a ceiling catch-up), which has
   *  no request to read one from. */
  client_ip: string | null;
  details: Record<string, unknown>;
}

/** One audit row, in the shape both writers below take. */
export interface AuditLogEntry {
  key_id?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  /** Client IP. Pass `c.var.clientIp ?? null` from route handlers;
   *  null for system-initiated audits. */
  client_ip?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditStore {
  /**
   * Write an audit row off the critical path. **Never rejects**, whatever
   * the database does: the write runs under a tracker that logs a failure
   * and drops it, so a caller cannot be broken by one.
   *
   * That is the right contract for almost every audit row, and it is a
   * contract, not an accident — the guarantee is what lets a route emit one
   * without a try/catch. What it is not is a guarantee that the row landed,
   * and awaiting it does not make it one: a try/catch around the await,
   * built to fail the operation on an unaudited write, is unreachable.
   * Awaiting is still worth doing where the row has to be issued inside the
   * caller's transaction, but say so at the call site, because the failure
   * handling reads as live otherwise.
   *
   * Use `logOrThrow` when an unaudited operation must not stand.
   */
  log(entry: AuditLogEntry): Promise<void>;
  /**
   * Write an audit row and propagate a failure to the caller.
   *
   * For the operations where an unaudited success is worse than a loud
   * failure: removing a platform type, creating the owner. Untracked
   * deliberately, because the caller is awaiting it, so there is nothing
   * in flight for shutdown to drain.
   *
   * **Propagating is the whole of what this promises.** It is not by
   * itself a transactional write. Which connection the insert lands on is
   * decided by the db handle the store was built with and by whatever
   * request context is installed around the call, neither of which is this
   * method's to choose. A caller that needs the row to commit or roll back
   * with its own transaction has to put the store on that transaction.
   */
  logOrThrow(entry: AuditLogEntry): Promise<void>;
  /**
   * Resolve once every in-flight `log` write has settled.
   *
   * `close()` uses it so fire-and-forget rows drain before the pool is torn
   * down. It is on the interface rather than only on the concrete stores
   * because a test asserting a row was **not** written otherwise has to
   * outwait the writer, and a deadline standing in for a barrier is an
   * assertion that encodes a duration: green on a quiet machine, red under
   * load, and silent about which it was.
   */
  drain(): Promise<void>;
  list(filters: {
    action?: string;
    resource_type?: string;
    resource_id?: string;
    /** Exclusive lower bound on `created_at`, when the entry was written. */
    created_after?: string;
    /** Exclusive upper bound on the same column. */
    created_before?: string;
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResult<AuditEntry>>;
  /**
   * Hard-delete rows whose `created_at` is older than the retention window.
   * Returns the number of rows actually deleted.
   */
  cleanup(retentionDays: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Event log store (SSE event persistence for replay)
// ---------------------------------------------------------------------------

export interface PersistedEvent {
  /** i64 event-log id. Carried as `bigint` (not `number`) so values above
   *  Number.MAX_SAFE_INTEGER round-trip without truncation. The SSE wire
   *  serializes via `String(id)` and parses via `BigInt(Last-Event-ID)`. */
  id: bigint;
  event_type: string;
  /** Populated on item events; null on edge events — the column is
   *  nullable so edge events don't have to borrow source_id. */
  item_id: string | null;
  edge_id: string | null;
  payload: string;
  /**
   * Whether this event drives outbound side effects — webhook delivery.
   * Persisted because a catch-up rebuilds the event from this row, and a
   * rebuilt event that read as fanning out when its writer said otherwise
   * would be a different event from the one that was emitted.
   */
  enable_fanout: boolean;
  created_at: string;
}

export interface EventLogStore {
  /** Append an event and return its assigned sequential ID (i64 bigint). */
  append(entry: {
    event_type: string;
    /** Non-null for item events; null for edge events. */
    item_id?: string | null;
    /** Non-null for edge events; lets subscribers filter Last-Event-ID
     *  replay by a specific edge in addition to by item. */
    edge_id?: string | null;
    payload: string;
    /** Whether the event drives outbound side effects. Absent means yes,
     *  which is what every ordinary write door wants. */
    enable_fanout?: boolean;
  }): Promise<bigint>;

  /** Retrieve events after a given ID. */
  getAfter(afterId: bigint, limit: number): Promise<PersistedEvent[]>;

  /**
   * Delete events older than the given retention window. Returns count
   * deleted.
   */
  cleanup(retentionHours: number): Promise<number>;

  /** Smallest surviving event id. Returns null when there are none.
   *  Used by the SSE route to
   *  detect clients whose `Last-Event-ID` predates the retention
   *  window so it can emit a terminal `catchup_too_old` event
   *  instead of silently resuming mid-stream. */
  getMinRetainedId(): Promise<bigint | null>;

  /** Largest event id. Returns null when there are none. The SSE route announces this on connect so a
   *  client that reads its snapshot afterwards holds a resume point
   *  from the first moment, rather than waiting for an event to arrive
   *  to learn where it is. */
  getMaxId(): Promise<bigint | null>;
}

// ---------------------------------------------------------------------------
// Idempotency records
// ---------------------------------------------------------------------------

/** `in_flight` while the write runs; `complete` once it answered. */
export type IdempotencyRecordState = "in_flight" | "complete";

export interface IdempotencyRecord {
  id: string;
  idempotency_key: string;
  fingerprint: string;
  state: IdempotencyRecordState;
  response_status: number | null;
  response_content_type: string | null;
  /** NULL on a completed row means the body was above the store bound. */
  response_body: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ClaimIdempotencyKeyInput {
  id: string;
  idempotency_key: string;
  fingerprint: string;
  created_at: string;
}

/**
 * Three outcomes, and the third one is not a variant of either other.
 *
 * `claimed: true` means a row was inserted and this caller owns it, which
 * is what makes the id it supplied safe to `complete()` against later.
 * `held` names the row that beat it. The third says the INSERT lost and
 * the winner was gone by the time it was read — a `release()` after a 5xx
 * or the retention sweep landing in that gap — so nobody holds the key and
 * nobody is coming to complete it.
 *
 * **Reported rather than folded into `claimed: true`.** Folded in, it
 * would be wrong in the one direction this whole mechanism exists to
 * prevent: the caller would go on to run the write believing it owned a
 * record that had never been inserted, `complete()` would update nothing,
 * and the next repeat of the same key would find no record and write for
 * real, a duplicate write produced inside the feature whose purpose is to
 * remove duplicate writes. The two cases have to be distinguishable at the
 * seam or the caller cannot act on the difference.
 */
export type IdempotencyClaim =
  | { claimed: true }
  | { claimed: false; held: IdempotencyRecord }
  | { claimed: false; held: null };

/**
 * What a write returned, keyed on the caller's `Idempotency-Key`.
 *
 * The store is deliberately dumb about what a repeat means: it takes a
 * key or reports who holds it, and records an outcome against a key it
 * gave out. Deciding whether an arrival is a retry, a client defect or a
 * race is the middleware's, in one place, so no two callers can
 * disagree about it.
 */
export interface IdempotencyStore {
  /**
   * Take the key for this request, or hand back the row already holding
   * it.
   *
   * The claim is an INSERT against the unique index, so this is also what
   * serializes two simultaneous arrivals: exactly one INSERT survives and
   * the loser is handed the winner's row. Nothing in the application
   * layer arbitrates, which is the property a check-then-write cannot
   * have.
   */
  claim(input: ClaimIdempotencyKeyInput): Promise<IdempotencyClaim>;

  /**
   * Take over a claim whose holder is past its lease.
   *
   * A process that dies between claiming and completing leaves the key
   * held with nothing coming to complete it, and the caller retrying is
   * exactly the client this whole mechanism serves. `heldSince` is the
   * `created_at` the caller read, so the UPDATE is a compare-and-swap:
   * two callers meeting one abandoned claim, exactly one takes it.
   *
   * Returns whether this caller won.
   */
  takeOverExpiredClaim(input: {
    id: string;
    fingerprint: string;
    heldSince: string;
    now: string;
  }): Promise<boolean>;

  /**
   * Record what went back, against a claim this caller still holds.
   *
   * **`heldSince` is a fence, not a lookup key.** `takeOverExpiredClaim`
   * swaps a stale claim in place — same row, same id, new `created_at` —
   * so an id names a row rather than a holder, and a writer that ran past
   * its lease still carries the id of a row somebody else now owns.
   * Matching on id alone lets that writer's outcome land on the newer
   * writer's claim, and a third arrival then replays one writer's body for
   * a write another is still performing.
   *
   * Returns whether a row was actually updated, which is false both when
   * the row is gone and when the fence does not match. A bare UPDATE that
   * matches nothing is indistinguishable from one that matched, and that
   * silence is how a lost outcome went unnoticed once already. False is
   * not an error the request can act on — the write has happened and the
   * response is owed — but it is the one place the loss is visible, so the
   * caller logs it.
   */
  complete(input: {
    id: string;
    /** The `created_at` this caller's claim carries. */
    heldSince: string;
    response_status: number;
    response_content_type: string | null;
    /** NULL when the body was above the store bound. */
    response_body: string | null;
    completed_at: string;
  }): Promise<boolean>;

  /**
   * Give the key back without recording an outcome.
   *
   * For a server fault, or for a refusal that describes the credential
   * rather than the request: neither is an outcome a caller should be
   * pinned to for the retention window.
   *
   * **Fenced on `heldSince` for the same reason `complete` is**, and this
   * is the sharper of the two. A slow writer that outlives its lease is
   * displaced by a takeover which keeps the row id; when that writer then
   * fails with a 5xx, an unfenced delete destroys the live claim of the
   * writer that replaced it. The replacement finishes, records nothing,
   * and the next repeat of the key writes for real — three writes from one
   * logical request. The two preconditions are positively correlated,
   * because a saturated machine produces both the overrun and the 5xx.
   *
   * Returns whether a row was deleted.
   */
  release(id: string, heldSince: string): Promise<boolean>;

  /** Delete records older than the retention window. Returns count deleted. */
  cleanup(retentionHours: number): Promise<number>;
}

export interface SettingsStore {
  /** Returns null when the key has not been set. */
  get(key: string): Promise<string | null>;
  /** Upsert — overwrites any existing value for the key. */
  set(key: string, value: string): Promise<void>;
  /** Atomic insert-or-bail: returns true if this caller's INSERT created the
   *  row, false if a row already existed. What lets exactly one of N
   *  concurrent callers win a one-shot act: the bootstrap mint of the first
   *  key, the instance id, the creation of the owner. */
  claim(key: string, value: string): Promise<boolean>;
  /** Give a claim back. Removes the row if it exists and is a no-op if it
   *  does not.
   *
   *  The claim has to come first, or two concurrent callers both act; but
   *  everything after it can fail, and a burned claim with nothing behind
   *  it is a door nobody can open again: the middleware admits an
   *  unauthenticated mint only while the bootstrap sentinel is absent, and
   *  the owner door creates only while its claim is free. Releasing on
   *  failure makes the attempt retryable instead. */
  release(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Edge store
// ---------------------------------------------------------------------------

export interface EdgeListFilters {
  edge_type?: string | string[];
  limit?: number;
  cursor?: string;
  /** Inclusive lower bound on `updated_at`, the edge's modification
   *  time. The edge half of the catch-up read; same inclusivity and same
   *  reasoning as {@link ItemFilters.updated_after}.
   *
   *  Setting it changes the listing's order from newest-created-first to
   *  `(updated_at, id)` ascending, which is what makes a resuming client
   *  able to advance a cursor through it. Because that is a second
   *  ordering over one opaque cursor, the cursor records which ordering
   *  issued it and a mismatch is refused — see `encodeKeyedCursor`. */
  updated_after?: string;
  /** Exclusive upper bound on `updated_at`, matching
   *  {@link ItemFilters.updated_before}: an end point a caller chooses
   *  rather than a resume point, so it takes the ordinary exclusive rule
   *  and leaves the ordering alone. */
  updated_before?: string;
}

export interface EdgeStore {
  /** Create an edge. Constraint enforcement (cardinality / cycles / type) sits outside. */
  createRaw(input: StoredCreateEdgeInput): Promise<Edge>;
  get(id: string): Promise<Edge | null>;
  /** Outbound edges — this item is the source. */
  listFromSource(
    sourceId: string,
    filters?: EdgeListFilters,
  ): Promise<PaginatedResult<Edge>>;
  /** Inbound edges — this item is the target. */
  listToTarget(
    targetId: string,
    filters?: EdgeListFilters,
  ): Promise<PaginatedResult<Edge>>;
  /**
   * Global list of edges. Used by clients that need "every edge of type X"
   * (thread-root counting, taxonomy traversal, etc.) — replaces the N+1
   * walk-every-item pattern. Trashed-item filtering is the caller's
   * responsibility (edges to trashed items are still real edges from a
   * graph perspective).
   */
  list(filters?: EdgeListFilters): Promise<PaginatedResult<Edge>>;
  /**
   * Replace an edge's properties in place and move its version on.
   * `source_id` / `target_id` / `edge_type` are immutable. An unknown id
   * raises `edge_not_found`, which the handler answers 404 — a bare error
   * here would reach the generic tail and cost the caller a 500 for a row
   * that is simply gone.
   *
   * **This is the only statement in the codebase that changes an edge row
   * in place**, which is why the version bump lives here rather than in a
   * route. A version is a property of the statement, not of the door: put
   * the bump in one caller and every other caller silently stops keeping
   * the invariant, while all of them still answer 2xx.
   *
   * `expectedVersion` makes the write conditional — it joins the id in one
   * WHERE, so the precondition is still decided by the statement rather
   * than by a comparison before it.
   *
   * **Properties merge shallowly over what the edge holds**, as the item
   * doors do. A replacing write would drop every property an update did
   * not name, and the response carrying the truncated edge would report
   * that loss only to a reader that replaces its copy with it; a client
   * merging the answer into what it already holds would see no removal at
   * all. The merge is computed from a read, so this takes a transaction.
   *
   * **There is no way to remove a single property from an edge**, and the
   * two things that look like one are not. These doors carry no
   * `properties_mode` and no `null_clears`, so a `null` is merged in and
   * *stored* as a null rather than clearing the key — the shallow merge
   * is `{...current, ...incoming}` and nothing filters it. And deleting
   * the edge to recreate it restarts the version at 1 and puts a delete
   * and a create on the wire where every other edit is an update. So an
   * edge's property set can only grow. That is a real limit rather than
   * an oversight in this doc.
   *
   * Properties are parsed and re-serialized on every write, so keys the
   * caller never named are rewritten through `JSON.stringify` rather than
   * kept as the bytes the last client sent.
   *
   * Returns the written edge, or the current one when the precondition did
   * not hold. A discriminated result rather than a thrown error so a new
   * call site has to state an answer instead of inheriting one.
   */
  updateProperties(
    id: string,
    properties: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<{ ok: true; edge: Edge } | { ok: false; current: Edge }>;
  /** Delete an edge by id. An unknown id is a silent no-op. */
  delete(id: string): Promise<void>;
  /**
   * Delete every outbound edge of `sourceId`, optionally narrowed to one
   * edge type, and return the rows that went.
   *
   * **The rows are the point, not a convenience.** A subscriber told an
   * edge was deleted needs to know which one, and the caller cannot read
   * them afterwards — they are gone. Reading them first instead would be
   * a second query racing the delete, and would silently under-report
   * past the list cap. Returning them from the statement that removes
   * them is the only shape with neither problem.
   */
  deleteBySource(sourceId: string, edgeType?: string): Promise<Edge[]>;
  /** Mirror of `deleteBySource` for inbound edges. */
  deleteByTarget(targetId: string, edgeType?: string): Promise<Edge[]>;
  /**
   * Batched `deleteBySource` — drop every edge whose `source_id` is in
   * `sourceIds`, optionally filtered by `edge_type`. Single SQL DELETE per
   * call regardless of how many ids are passed. Returns the number of
   * rows deleted; an empty `sourceIds` is a 0-row no-op. Used by the
   * bulk-action purge worker so 100 items' worth of outbound edges drop
   * in one statement instead of 100.
   */
  deleteBySourceBatch(sourceIds: string[], edgeType?: string): Promise<Edge[]>;
  /** Mirror of `deleteBySourceBatch` for inbound edges. */
  deleteByTargetBatch(targetIds: string[], edgeType?: string): Promise<Edge[]>;
  /**
   * Count edges where the given item is source. Used for cardinality checks.
   */
  countBySource(sourceId: string, edgeType: string): Promise<number>;
  /**
   * Count edges where the given item is target. Used for cardinality checks.
   */
  countByTarget(targetId: string, edgeType: string): Promise<number>;
  /**
   * Batched `countBySource` — for each distinct `(source_id, edge_type)` pair
   * returns the row count. Key format: `${source_id}|${edge_type}`. Pairs
   * absent from the result map have count zero. One SQL query per distinct
   * `edge_type` in `pairs`.
   */
  countsBySourceBatch(
    pairs: { source_id: string; edge_type: string }[],
  ): Promise<Map<string, number>>;
  /**
   * Batched `countByTarget` — mirror of `countsBySourceBatch`, keyed as
   * `${target_id}|${edge_type}`.
   */
  countsByTargetBatch(
    pairs: { target_id: string; edge_type: string }[],
  ): Promise<Map<string, number>>;
  /**
   * Exact-duplicate check (source_id, target_id, edge_type).
   */
  existsExact(
    sourceId: string,
    targetId: string,
    edgeType: string,
  ): Promise<boolean>;
  /**
   * Batched `existsExact` — returns the subset of triples that already exist.
   * Key format: `${source_id}|${target_id}|${edge_type}`. Callers check
   * membership to decide whether to reject a proposed edge as a duplicate.
   * One SQL query per distinct `edge_type`.
   */
  existsExactBatch(
    pairs: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }[],
  ): Promise<Set<string>>;
  /**
   * Batched triple-to-Edge lookup. For each `(source_id, target_id, edge_type)`
   * that matches an existing row, returns the full `Edge` keyed as
   * `${source_id}|${target_id}|${edge_type}`. Triples with no match are
   * absent. Used by `POST /edges/bulk` upsert to resolve duplicate edges to
   * their ids for in-place property updates. One SQL query per distinct
   * `edge_type`.
   */
  findByTriplesBatch(
    pairs: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }[],
  ): Promise<Map<string, Edge>>;
  /**
   * All outbound edges of a given type from sourceId. Used for cycle checks,
   * cascade-on-delete, and edge hydration when the caller wants every entry.
   */
  listOutboundOfType(sourceId: string, edgeType: string): Promise<Edge[]>;
  /**
   * All edges touching the given item — outbound (item is source) and inbound
   * (item is target). Used by cascade-on-delete to gather the full edge set
   * around an item being deleted.
   */
  listAllByItem(itemId: string): Promise<{ outbound: Edge[]; inbound: Edge[] }>;
  /** Batched outbound-by-types fetch for hydration on item reads. */
  listFromSourcesBatched(
    sourceIds: string[],
    perTypeLimit: number,
  ): Promise<Map<string, Edge[]>>;
  /**
   * Batched inbound-by-types fetch for hydration on item reads — the mirror of
   * `listFromSourcesBatched`, keyed by `target_id`. Caps each
   * `(target_id, edge_type)` bucket at `perTypeLimit` so a hot item with many
   * inbound edges of one type can't return an unbounded set. Used to hydrate
   * the `backrefs` block on the single-item read.
   */
  listToTargetsBatched(
    targetIds: string[],
    perTypeLimit: number,
  ): Promise<Map<string, Edge[]>>;
}

/**
 * Cleanup hooks for the better-auth `auth_session` table. Better Auth itself
 * owns the session TTL via `expiresAt`; this store exists only to drop rows
 * past that timestamp on a periodic sweep so the table doesn't grow unbounded.
 *
 * Instance-wide by design — the deletion criterion is purely time-based and
 * there's no retention knob. Mirrors the `VersionThinner` shape rather than
 * the retention-window jobs.
 */
export interface AuthSessionStore {
  /** Delete every `auth_session` row whose `expires_at` is strictly
   *  before `now`. Returns the number of rows deleted. */
  deleteExpired(now: Date): Promise<number>;
}

/** The person an instance belongs to, as the sign-in surface holds them. */
export interface OwnerRecord {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

/**
 * The owner: the one account on the instance's sign-in surface.
 *
 * Sign-up is disabled on every instance and `POST /owner` refuses once an
 * account exists, so the account created first is the owner and there is
 * no second. Read from `auth_user` rather than kept as a separate marker,
 * because a marker could outlive the row and close the door with nobody
 * behind it.
 */
export interface OwnerStore {
  /** The owner, or `null` on an instance that has none yet. */
  find(): Promise<OwnerRecord | null>;
}

/**
 * The rate-limit and throttle counters.
 *
 * Backing table `rate_limit_windows` keyed on (family, window_key). Two
 * consumers ride the same store:
 *
 *   - the rate-limit middleware (family = "rate"): per-credential request
 *     windows, keyed "<credential-id-or-ip>:<path-prefix>", sized by
 *     `AppConfig.rateLimitWindowMs`.
 *   - the device verification page's failed-attempt throttle per user code
 *     (`routes/auth-pages.ts`, family = "device-user-code").
 *
 * The single primitive — atomic increment-counter-bounded-by-window —
 * services both. The counters are rows, so every process pointed at the
 * database increments the same one; `INSERT ... ON CONFLICT DO UPDATE`
 * under SQLite's single writer is what stops an increment being lost.
 *
 * Hot path: one round-trip per gated request, which is affordable at the
 * traffic this is built for — low thousands of requests a second at peak.
 */
export interface RateLimitStore {
  /**
   * Atomic upsert that increments the counter for `(family, key)` by 1.
   * If the existing row's `expires_at` has already passed, the row is
   * reset (count → 1, expires_at → nowIso + windowMs) before the
   * increment is applied; otherwise the increment lands on the
   * existing row and `expires_at` is left unchanged. Returns the
   * post-increment count and the row's current `expires_at`.
   *
   * Callers compare `count` against their cap and reject when over.
   * The single-row UPDATE serializes concurrent writers via SQLite's
   * BEGIN IMMEDIATE on libsql, so two callers racing the same key cannot
   * both observe `count == 1` inside one window.
   */
  incrementWindow(
    family: string,
    key: string,
    windowMs: number,
    nowIso: string,
  ): Promise<{ count: number; expires_at: string }>;
  /**
   * `incrementWindow` for several keys in ONE statement, keyed by the
   * same upsert semantics per row. Exists because the rate-limit
   * middleware consults up to three windows on every request — same
   * table, same method, same timestamp — and three sequential round
   * trips on the hot path were pure multiplier. Keys are deduplicated.
   * Returns a map keyed by window key.
   */
  incrementWindows(
    family: string,
    keys: string[],
    windowMs: number,
    nowIso: string,
  ): Promise<Map<string, { count: number; expires_at: string }>>;
  /**
   * Drop every row whose `expires_at` is strictly older than `nowIso`.
   * Called from the `RateLimitWindowCleaner` retention sweep. Returns
   * the number of rows deleted.
   */
  cleanup(nowIso: string): Promise<number>;
}

/**
 * The handle storage implementations expose for better-auth. The public
 * Storage contract carries the Drizzle handle as `unknown` so the consumer
 * (auth/instance.ts) is the single site that narrows.
 *
 * Optional on `Storage` because not every test fixture needs to wire
 * better-auth — leaving it unset disables the adapter mount in `app.ts`.
 */
export interface BetterAuthStorageAdapter {
  /** Drizzle DB handle. Typed `unknown` here so the Storage interface
   *  stays portable; `auth/instance.ts` casts via `Parameters<typeof
   *  drizzleAdapter>[0]` so the surface is still typed at the consumer. */
  betterAuthDb: unknown;
}

// ---------------------------------------------------------------------------
// bulk_action_jobs store
// ---------------------------------------------------------------------------

export type BulkActionJobStatus =
  "queued" | "in_progress" | "completed" | "failed" | "canceled";

/** Server-side row shape for a `bulk_action_jobs` entry. The published
 *  `BulkActionJob` is a strict subset — fields like `matched_ids`,
 *  `worker_id`, `worker_heartbeat_at`, `api_key_id`, and the original
 *  `input` are server-internal. */
export interface BulkActionJobRow {
  id: string;
  api_key_id: string | null;
  status: BulkActionJobStatus;
  action: string;
  /** Original BulkActionInput, JSON-encoded. */
  input: string;
  /** Frozen matched id list, JSON-encoded `string[]`. */
  matched_ids: string;
  matched_count: number;
  processed_count: number;
  succeeded_count: number;
  errored_count: number;
  /** Final BulkActionResult envelope, JSON-encoded. Populated on
   *  `completed`. */
  result: string | null;
  /** Failure reason on `failed`. */
  error: string | null;
  worker_id: string | null;
  worker_heartbeat_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CreateBulkActionJobInput {
  id: string;
  api_key_id: string | null;
  action: string;
  input: string;
  matched_ids: string;
  matched_count: number;
  idempotency_key: string | null;
  created_at: string;
}

export interface BulkActionJobProgress {
  processed_count: number;
  succeeded_count: number;
  errored_count: number;
}

export interface BulkActionJobStore {
  /**
   * INSERT a fresh row in `queued` state. When `idempotency_key` is set
   * and a row with the same `idempotency_key` already
   * exists, returns that existing row instead of creating a new one
   * — the `ON CONFLICT` happens at the unique-index level so this is a
   * race-safe replay path.
   */
  create(input: CreateBulkActionJobInput): Promise<BulkActionJobRow>;
  /** Fetch by id. The store returns the row regardless of caller; the route
   *  handler enforces auth: the credential that created the job, or the
   *  operator key, and nothing else. No permission says "read another
   *  credential's bulk jobs". */
  getById(id: string): Promise<BulkActionJobRow | null>;
  /**
   * Atomically claim the next queued job: a plain
   * `UPDATE WHERE status='queued' RETURNING …` with `LIMIT 1`. Two worker
   * loops cannot claim one job, because each statement is atomic and the
   * second one's bounded UPDATE sees the first one's claim. Sets
   * `status='in_progress'`,
   * `started_at`, `worker_id`, `worker_heartbeat_at`. Returns the
   * claimed row, or `null` if the queue is empty.
   */
  claimNext(workerId: string, now: string): Promise<BulkActionJobRow | null>;
  /** Bump progress counts + heartbeat. Idempotent — over-writes
   *  whatever was there before, doesn't sum. */
  updateProgress(
    id: string,
    progress: BulkActionJobProgress,
    heartbeatAt: string,
  ): Promise<void>;
  /** Terminal `completed`. Writes the result envelope, sets
   *  `finished_at`, clears `worker_heartbeat_at`. */
  complete(
    id: string,
    result: string,
    finalCounts: BulkActionJobProgress,
    finishedAt: string,
  ): Promise<void>;
  /** Terminal `failed`. Writes the error string, sets `finished_at`. */
  fail(id: string, error: string, finishedAt: string): Promise<void>;
  /** Request cancellation. Flips `queued` or `in_progress` rows to
   *  `canceled`; no-op (returns `false`) on already-terminal rows.
   *  The worker observes the flag between chunks. */
  cancel(id: string, finishedAt: string): Promise<boolean>;
  /**
   * Boot-time recovery: any `in_progress` job whose
   * `worker_heartbeat_at` is older than `staleBeforeIso` is reset to
   * `queued`. Returns the number of rows reset. Called once on server
   * boot before the worker loop starts.
   */
  recoverStale(staleBeforeIso: string): Promise<number>;
  /**
   * GC: drop terminal rows whose `finished_at` is older than
   * `expireBeforeIso`. Returns the number of rows deleted. Called by the
   * `bulk-action-gc` housekeeping job at its own cadence.
   */
  gcExpired(expireBeforeIso: string): Promise<number>;
}

/** A file item the enrichment sweeper should extract text from. */
export interface EnrichmentCandidate {
  item_id: string;
  type: string;
  blob_ref: string;
  mime_type: string;
}

export interface EnrichmentStateInput {
  item_id: string;
  blob_ref: string;
  extractor_version: number;
  status: "done" | "failed" | "skipped";
  attempts: number;
  error?: string | null;
  /**
   * The sweeper configuration the row was written under. A skip is only
   * terminal relative to the settings that produced it — raise the size
   * ceiling or enable image reading and the row deserves another look —
   * so the candidate query re-offers skipped rows whose stamp differs.
   */
  config_signature: string;
}

export interface EnrichmentStateRecord extends EnrichmentStateInput {
  updated_at: string;
}

/**
 * Bookkeeping for the deterministic text-enrichment sweeper. One row per
 * file item the sweeper has looked at; the candidate query is the whole
 * trigger mechanism (state-based, never event-based, so connector
 * fan-out cannot loop the sweeper).
 */
export interface EnrichmentStore {
  /**
   * File items needing extraction: `core.file` family, not trashed, with a
   * `blob_ref`, and either never looked at, changed since (`blob_ref`
   * differs), authored under an older extractor, failed with attempts to
   * spare, or skipped under a different configuration than
   * `configSignature`. Ordered oldest-updated first; bounded by `limit`.
   */
  listCandidates(
    extractorVersion: number,
    maxAttempts: number,
    limit: number,
    configSignature: string,
  ): Promise<EnrichmentCandidate[]>;
  get(itemId: string): Promise<EnrichmentStateRecord | null>;
  upsert(state: EnrichmentStateInput): Promise<void>;
  delete(itemId: string): Promise<void>;
}

export type HousekeepingOutcome = "ok" | "error";

/** One housekeeping job as the table holds it: its schedule and its last run. */
export interface HousekeepingRow {
  name: string;
  interval_ms: number;
  next_run_at: string;
  running_since: string | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_outcome: HousekeepingOutcome | null;
  last_error: string | null;
  /** What the last run reported, as it was given. */
  last_result: HousekeepingReport | null;
}

export interface HousekeepingFinish {
  finishedAt: string;
  outcome: HousekeepingOutcome;
  error: string | null;
  result: HousekeepingReport | null;
  /** When the name is next due. A `next_run_at` already past the run's
   *  start (a wake during the run, or the schedule of a run started ahead
   *  of it) holds instead when it is the earlier of the two. */
  nextRunAt: string;
}

/**
 * The polling table the scheduler runs the server's housekeeping from.
 * Every claim is one statement conditioned on `running_since IS NULL`,
 * which is what makes a name exclusive to one run at a time.
 */
export interface HousekeepingStore {
  /**
   * Write a housekeeping job's row at boot. A new name is inserted due at
   * `nextRunAt`; an existing one takes the interval and keeps its own
   * `next_run_at`, unless `nextRunAt` is earlier (an interval shortened by
   * configuration).
   */
  upsert(name: string, intervalMs: number, nextRunAt: string): Promise<void>;
  /** Delete every row no registration names. Returns their names. */
  removeExcept(names: readonly string[]): Promise<string[]>;
  /** Clear every `running_since` left by a run that never finished. Returns
   *  the names it cleared. */
  clearRunning(): Promise<string[]>;
  /** The names due at `now` and not running. */
  listDue(now: string): Promise<string[]>;
  /** Claim a name that is due and not running. `null` when it is neither. */
  claimDue(name: string, now: string): Promise<HousekeepingRow | null>;
  /** Claim a name whether or not it is due. `null` when it is running or
   *  unknown. */
  claim(name: string, now: string): Promise<HousekeepingRow | null>;
  finish(name: string, outcome: HousekeepingFinish): Promise<void>;
  /** Make a name due now. False when there is no such row. */
  wake(name: string, now: string): Promise<boolean>;
  list(): Promise<HousekeepingRow[]>;
  get(name: string): Promise<HousekeepingRow | null>;
}

// ---------------------------------------------------------------------------
// Connectors: a process outside the server, registered under its key
// ---------------------------------------------------------------------------

export type ConnectorRunOutcome = "succeeded" | "failed";

export interface ConnectorRun {
  id: string;
  connector_id: string;
  outcome: ConnectorRunOutcome;
  started_at: string;
  finished_at: string;
  summary: string | null;
  error: string | null;
  reported_at: string;
}

export interface ConnectorRunInput {
  outcome: ConnectorRunOutcome;
  started_at: string;
  finished_at: string;
  summary?: string;
  error?: string;
}

/** A registration: a process outside the server, named under its key. */
export interface Connector {
  id: string;
  key_id: string;
  /** The key's own source, which its writes carry unless they name a claim. */
  source: string;
  name: string;
  description: string | null;
  registered_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
  last_run: ConnectorRun | null;
}

export interface ConnectorStore {
  /** Register the key, or update its registration: one per key, decided
   *  by one statement so two first registrations at once answer as a first
   *  and a repeat. */
  register(
    key: { id: string; source: string },
    name: string,
    description: string | null,
  ): Promise<{ connector: Connector; created: boolean }>;
  /** Every registration, newest first. */
  list(): Promise<Connector[]>;
  get(id: string): Promise<Connector | null>;
  /** Remove the registration and its runs. True when one went. */
  remove(id: string): Promise<boolean>;
  /** Stamp the heartbeat with the server's clock; the stamp, or null when
   *  there is no such registration. */
  heartbeat(id: string): Promise<string | null>;
  /** Record a run, keeping the connector's newest hundred. */
  recordRun(id: string, input: ConnectorRunInput): Promise<ConnectorRun>;
  /** A connector's runs, newest first, one page at a time. */
  listRuns(
    id: string,
    page: { limit: number; cursor?: string },
  ): Promise<PaginatedResult<ConnectorRun>>;
}

export interface Storage extends Partial<BetterAuthStorageAdapter> {
  items: ItemStore;
  metadata: MetadataStore;
  versions: VersionStore;
  types: TypeStore;
  search: SearchStore;
  keys: KeyStore;
  blobs: BlobRegistry;
  edges: EdgeStore;
  edgeTypes: EdgeTypeStore;
  /** Thin lookup helpers over the @better-auth/oauth-provider plugin's
   *  tables (`auth_oauth_client`, `auth_oauth_consent`). Used by the
   *  consent route + grant-projection after-hooks. Optional — test
   *  contexts that skip the OAuth surface can omit. */
  oauthProvider?: OauthProviderStore;
  outboundWebhooks: WebhookStore;
  outboundWebhookDeliveries: WebhookDeliveryStore;
  audit: AuditStore;
  eventLog: EventLogStore;
  /** Optional sweep store for expired better-auth session rows. Absent on
   *  test contexts that don't wire better-auth (the `auth-session-cleanup`
   *  housekeeping job is registered only when it is present). */
  authSessions?: AuthSessionStore;
  /** The owner behind the sign-in surface. Absent, like `authSessions`, on
   *  a storage that wires no better-auth tables. */
  owner?: OwnerStore;
  settings: SettingsStore;
  /** The job table behind `POST /items/bulk-actions`. The worker module
   *  reads and writes through this store; the route handler creates jobs
   *  and serves GET and DELETE. */
  bulkActionJobs: BulkActionJobStore;
  /** What a write returned, keyed on the caller's `Idempotency-Key`. The
   *  idempotency middleware and the event-log retention sweep are its only
   *  readers. */
  idempotency: IdempotencyStore;

  /**
   * Rate-limit and throttle counters, shared by every process pointed at
   * the file. The middleware and the device verification page consult it.
   * Required rather than optional because a missing store would silently
   * degrade to "no rate limit", which is the wrong default.
   */
  rateLimits: RateLimitStore;
  /** Deterministic text-enrichment bookkeeping. The sweeper is the only
   *  consumer. */
  enrichment: EnrichmentStore;
  /** The server's own periodic jobs. The scheduler is the only writer; the
   *  housekeeping doors read it through the scheduler. */
  housekeeping: HousekeepingStore;
  /** The registrations behind `/connectors`, and the runs they report. */
  connectors: ConnectorStore;
  runInTransaction<T>(fn: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}
