import type {
  Item,
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
  InboundWebhookEvent,
  MarfaRole,
  PaginatedResult,
  SearchResult,
  ConflictResponse,
  ItemState,
  User,
  Space,
  Edge,
  CreateEdgeInput,
} from "@withmarfa/shared";
import type {
  DeletionState,
  EdgeTypeSchema,
  PlatformTypeFamily,
  SeededPlatformType,
  TypeOrigin,
  TypeSchema,
} from "@withmarfa/shared";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { SourceFilterSettings } from "./filter-sql.js";

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

/** The three system columns that have always been sortable. Their ordering is
 *  a direct column comparison — no JSON extraction. */
export const SYSTEM_SORTS = ["created_at", "updated_at", "timestamp"] as const;

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
 * - A system column (`created_at` | `updated_at` | `timestamp`) → `{ kind: "system" }`.
 * - A `properties.<field>` form with a `^[a-z0-9_]+$` field → `{ kind: "property", field }`.
 * - Anything else (unknown bare column, malformed property field) → throws
 *   `VALIDATION_ERROR`. An undefined input defaults to the legacy `created_at`.
 *
 * The validation lives here so both dialect stores reject malformed sorts
 * identically before any SQL is built.
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
  spaceId?: string;
  /** Opt-in widening of the space filter for catalog surfaces. When
   *  `spaceId` is set AND this flag is true, the WHERE clause becomes
   *  `(space_id = $spaceId OR space_id IS NULL)` — so platform-scoped
   *  rows (written by `is_platform: true` credentials with `space_id` NULL)
   *  surface to in-space callers alongside their own rows. Used by the
   *  Integrations catalog list (`GET /integrations`) so registered
   *  manifests, which carry `space_id IS NULL` by design, are visible to
   *  any authenticated space member. Default off — generic list reads
   *  must NOT pick this up, or null-space rows from any source would
   *  leak across space boundaries. No effect when `spaceId` is unset. */
  includePlatformScoped?: boolean;
  type?: string;
  state?: ItemState;
  source?: string;
  /** The space's `source_filter` enforcement lever, applied per row: a row
   *  whose type the lever lists must carry an approved source, every other
   *  row passes untouched. Per-row on purpose — the lever is per-type, so
   *  narrowing the whole result set instead would both over-restrict the
   *  types it does not list and leave it decidable from the request. */
  source_filter?: SourceFilterSettings;
  /** Restrict to a specific tier. Omit for the default unfiltered scope. */
  tier?: "library" | "feed";
  /** When true, items whose type starts with `system.` are excluded from
   *  the result set. The route layer flips this on by default; callers
   *  opt back in by listing `?include=system` or filtering on a specific
   *  `system.*` type. */
  exclude_system_types?: boolean;
  tags?: string[];
  filter?: string;
  allowed_types?: string[];
  sort?: ItemSortField;
  direction?: SortDirection;
  since?: string;
  until?: string;
  /** Inclusive lower bound on the normalized `starts_at_utc` column, and
   *  so implicitly `starts_at_utc IS NOT NULL`. Serves the calendar's
   *  window scan: the column is written in the exact shape
   *  `toISOString()` emits, which is what lets a text comparison answer a
   *  question about instants. Internal — not reachable through the
   *  public `?filter=` grammar. */
  startsAtUtcFrom?: string;
  /** Exclusive upper bound on `starts_at_utc`. Exclusive because a
   *  calendar window's end belongs to the next window. */
  startsAtUtcTo?: string;
  /** Restrict to rows carrying this top-level property key. Serves the
   *  calendar's series and exception discovery, both of which have to
   *  read every matching row whatever window was asked for: an old rule
   *  produces occurrences in any window, and an exception moved outside
   *  one still shadows the slot it left inside it. Internal — not
   *  reachable through the public `?filter=` grammar. */
  hasProperty?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchFilters {
  spaceId?: string;
  type?: string;
  state?: ItemState;
  /** Tier filter, matching `/items`. Omit for unfiltered. */
  tier?: "library" | "feed";
  /** Mirrors `ItemFilters.source_filter`. */
  source_filter?: SourceFilterSettings;
  /** Mirrors `ItemFilters.exclude_system_types`. */
  exclude_system_types?: boolean;
  /** Items must have ALL specified tags. Mirrors `/items?tags=` semantics. */
  tags?: string[];
  filter?: string;
  allowed_types?: string[];
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Cursor utilities (keyset pagination)
// ---------------------------------------------------------------------------

interface CursorPayload {
  v: string;
  id: string;
}

/** Like {@link CursorPayload} but the sort value may be `null` — only the
 *  item-list `properties.<field>` sort produces a null `v` (an absent field in
 *  the NULLS-LAST tail). System-column sorts are NOT NULL, so the strict
 *  {@link decodeCursor} contract still holds for every other consumer. */
interface NullableCursorPayload {
  v: string | null;
  id: string;
}

export function encodeCursor(sortValue: string | null, id: string): string {
  return Buffer.from(JSON.stringify({ v: sortValue, id })).toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string): CursorPayload {
  const parsed = decodeCursorNullable(cursor);
  if (typeof parsed.v !== "string") {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid pagination cursor",
    );
  }
  return { v: parsed.v, id: parsed.id };
}

/** Decode a cursor whose sort value may be `null`. Used by the item-list query,
 *  which can keyset over a nullable property expression. */
export function decodeCursorNullable(cursor: string): NullableCursorPayload {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    );
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("v" in parsed) ||
      !("id" in parsed) ||
      (typeof parsed.v !== "string" && parsed.v !== null) ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("Invalid cursor shape");
    }
    return { v: parsed.v, id: parsed.id };
  } catch {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid pagination cursor",
    );
  }
}

// ---------------------------------------------------------------------------
// Sub-store interfaces
// ---------------------------------------------------------------------------

/**
 * Optional knobs for single-item `get` lookups.
 *
 * `includePlatformScoped` mirrors `ItemFilters.includePlatformScoped` for the
 * single-id path: when set alongside a real `spaceId`, the WHERE clause
 * widens to `(space_id = $spaceId OR space_id IS NULL)` so platform-
 * scoped rows (written by `is_platform: true` credentials with
 * `space_id` NULL) resolve for in-space callers. Used by the
 * Integrations install + get-by-id endpoints, which legitimately need
 * to fetch a platform-scoped `system.integration` manifest from a
 * space-scoped caller. Default off — generic gets MUST NOT pick this
 * up, or null-space rows from any source could leak across spaces.
 * No effect when `spaceId` is undefined.
 */
export interface ItemGetOptions {
  includePlatformScoped?: boolean;
}

export interface ItemStore {
  create(input: CreateItemInput, spaceId?: string): Promise<Item>;
  get(
    id: string,
    spaceId?: string,
    options?: ItemGetOptions,
  ): Promise<Item | null>;
  /**
   * Batched `get` — returns a map keyed by item id for every id in `ids` that
   * resolves to a non-trashed item in the caller's space scope. Missing ids
   * are simply absent from the map; no errors. Used by the edge-validation
   * batcher to collapse per-pair item fetches into a single IN query.
   */
  /**
   * Fetch many items by id, space-fenced.
   *
   * Trashed rows are excluded by default, because every read surface treats a
   * soft-deleted item as gone. `includeTrashed` is for the one caller that
   * must see them: purge, whose whole input is trashed rows. Without it the
   * purge runner's pre-fetch came back empty, so it reported every id as
   * "not found in space scope" while the delete underneath it succeeded — a
   * job that removed four thousand rows and said it had removed none.
   */
  getMany(
    ids: string[],
    spaceId?: string,
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
   */
  getIncludingTrashed(id: string, spaceId?: string): Promise<Item | null>;
  list(filters: ItemFilters): Promise<PaginatedResult<Item>>;
  /**
   * Look up a single non-trashed item by `(source, source_id)` within a
   * space. Returns null if no row matches. Used by `/items/bulk` upsert
   * to decide create-vs-update without round-tripping a full `list`.
   */
  findBySourceId(
    source: string,
    sourceId: string,
    spaceId?: string,
  ): Promise<Item | null>;
  /**
   * Internal natural-key lookup that also returns a soft-deleted row. Use
   * this only when a caller must reconcile against the database uniqueness
   * constraint itself; normal API reads and upserts must keep using
   * `findBySourceId`, which hides trashed items.
   */
  findBySourceIdIncludingTrashed(
    source: string,
    sourceId: string,
    spaceId?: string,
  ): Promise<Item | null>;
  update(
    id: string,
    input: UpdateItemInput,
    spaceId?: string,
  ): Promise<Item | ConflictResponse>;
  delete(id: string, spaceId?: string): Promise<void>;
  purge(id: string, spaceId?: string): Promise<void>;
  /**
   * Hard-delete every id in `ids` within the space scope. Bypasses the
   * "must be trashed" gate that single-item `purge` enforces — bulk is an
   * admin cleanup primitive with explicit confirm. Cascades metadata and
   * versions via ON DELETE CASCADE; caller must have already wiped edges
   * (source + target directions). Cleans the search index for each id.
   * Returns the number of rows actually deleted (rows not in space are
   * silently skipped).
   */
  bulkPurge(ids: string[], spaceId?: string): Promise<number>;
  restore(id: string, spaceId?: string): Promise<Item>;
  transition(id: string, state: ItemState, spaceId?: string): Promise<Item>;
  /**
   * How many items carry this exact type identifier, across every space.
   *
   * Deliberately unscoped, and the only caller is the platform-admin
   * surface that decides whether a retired shipped type can be removed.
   * The question it answers is about the instance, not about a space: a
   * row kept because one space still holds items of it is kept for
   * everyone, since the row is what makes those items resolve.
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
  stats(
    spaceId?: string,
    allowedTypes?: string[],
    sourceFilter?: SourceFilterSettings,
  ): Promise<Record<string, number>>;
  /**
   * Hard-delete every trashed item whose `updated_at` is strictly older
   * than `beforeDate` (an ISO 8601 timestamp). Cleans the search index
   * for each row. Returns the number of rows deleted.
   *
   * Unlike `bulkPurge`, this drops the purged items' edges itself (both
   * directions, inside the same transaction). It is the terminal step of
   * the automatic trash lifecycle with no route layer above it to do the
   * cleanup, and edges have no FK to items to fall back on.
   *
   * `spaceId` semantics:
   * - `undefined` — every row older than the cutoff.
   * - `string` — only rows where `space_id` matches.
   * - `null` — only rows where `space_id IS NULL` (single-space
   *   self-host items + any rows with no space scope).
   */
  purgeTrashedOlderThan(
    beforeDate: string,
    spaceId?: string | null,
  ): Promise<number>;
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
   *
   * `spaceId` semantics match `purgeTrashedOlderThan`:
   * - `undefined` — every row older than the cutoff.
   * - `string` — only rows where `space_id` matches.
   * - `null` — only rows where `space_id IS NULL`.
   */
  purgeActivityOlderThan(
    beforeDate: string,
    spaceId?: string | null,
  ): Promise<number>;
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
   * caller. Space-scoped; type-permission scoped when `allowedTypes` is
   * provided (same pattern as `ItemStore.list`). Trashed items are excluded.
   * Returns tags with their usage counts, sorted by count descending.
   */
  listTags(filters: {
    spaceId?: string;
    allowedTypes?: string[];
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

export interface VersionStore {
  create(
    itemId: string,
    version: number,
    properties: Record<string, unknown>,
    deviceId?: string,
  ): Promise<Version>;
  list(itemId: string): Promise<Version[]>;
  getByVersion(itemId: string, version: number): Promise<Version | null>;
  getLatestTimestamp(itemId: string): Promise<string | null>;
  deleteByIds(ids: string[]): Promise<number>;
  /**
   * Pages over every version snapshot's parsed properties, instance-wide.
   * Exists for the admin blob cleanup: a hash referenced only by history is
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
      spaceId: string | null;
      versionCount: number;
    }[]
  >;
}

export interface TypeStore {
  /** Lists the types visible to a space: the global core/system set plus the
   *  space's own custom types. Omit `spaceId` for the null-space bucket
   *  (single-space self-host / platform). */
  list(spaceId?: string): Promise<TypeSchema[]>;
  /** Resolves a type by id within the space: core/system types resolve
   *  globally, custom types only for their owning space. */
  get(id: string, spaceId?: string): Promise<TypeSchema | undefined>;
  create(
    schema: TypeSchema,
    spaceId?: string,
    provenance?: TypeProvenance,
  ): Promise<TypeSchema>;
  update(id: string, schema: TypeSchema, spaceId?: string): Promise<TypeSchema>;
  delete(id: string, spaceId?: string): Promise<void>;
  /** One space's own custom types, without the global core and system set
   *  `list` folds in. Exists because an export has to carry the
   *  registrations a restore would otherwise be missing, and only the
   *  custom ones are the space's to carry. */
  listCustom(spaceId?: string): Promise<TypeSchema[]>;
  /**
   * One space's custom types with their stored provenance.
   *
   * `listCustom` returns bare schemas, which is all three of its other
   * callers need. This exists because deciding what a type IS cannot be
   * done from its identifier: a vendor's `readwise.book` and a person's
   * `jonah.reading_item` under a claimed handle are the same shape, and
   * only the stored `origin` separates them.
   *
   * Space-scoped rather than reusing `loadCustomTypes`, which reads every
   * space. Answering a question about one space by loading all of them is
   * the shape space isolation exists to prevent, and it is not made safe
   * by the caller filtering afterwards.
   */
  listCustomWithProvenance(spaceId?: string): Promise<LoadedType[]>;
  /** Load every custom type across all spaces for server-startup registry
   *  warmup. Each row carries its owning space so the warmup can register it
   *  into the right space overlay. */
  loadCustomTypes(): Promise<LoadedType[]>;
  /**
   * Write the shipped platform vocabulary into rows, idempotently.
   *
   * Called at every boot rather than by a migration. A migration would have
   * to embed a copy of several dozen JSON schemas, which nothing regenerates
   * and which would drift from the files the codegen reads the first time a
   * field changed. Seeding from the build keeps the repo's JSON canonical and
   * makes the row a projection of it.
   *
   * Existing rows are updated in place, so a redeploy carrying a changed
   * schema moves the instance forward without a second mechanism.
   */
  seedPlatformTypes(seeded: readonly SeededPlatformType[]): Promise<void>;
  /**
   * Remove one platform row the build no longer ships. Answers whether a
   * row was actually deleted.
   *
   * **Scoped to `(space_id = '', origin = 'platform')`, and both halves
   * matter.** The seed writes an empty `space_id` and the primary key is
   * `(space_id, id)`, so scoping on origin alone would reach a row of the
   * same identifier in a space. Nothing else writes that pair, which used
   * to be true by accident and is now a rule the archive restore enforces
   * by refusing to write a platform origin.
   *
   * No guard of its own: whether removal is safe is a question about
   * items, which this layer cannot see. The caller decides and this
   * performs.
   */
  deletePlatformType(id: string): Promise<boolean>;
  countCustom(): Promise<number>;
}

/** Where a registered type came from, written alongside its schema. */
export interface TypeProvenance {
  origin: TypeOrigin;
  /**
   * What kind of type this is: core content, an integration's own shape,
   * or a structural platform record.
   *
   * **Widened deliberately from "shipped rows only".** It began as a
   * property of the shipped set, which is why a type travelling with an
   * integration manifest registered without one. That is a gap rather
   * than a design: the question "what kind of type is this" is asked of
   * every type, and answering it from the identifier cannot separate a
   * vendor's type from a person's under a claimed handle.
   *
   * Absent for `user` rows, which is not a gap — a type a person
   * registered belongs to no platform family and never did.
   */
  family?: PlatformTypeFamily;
  /** Manifest name of the publishing integration, for `integration` rows. */
  owner_integration?: string;
}

/** A type schema paired with the space that owns it — the shape the startup
 *  warmup needs to register each custom type into the correct space overlay.
 *  The empty-string `space_id` is the null-space sentinel. */
export interface LoadedType {
  space_id: string;
  schema: TypeSchema;
  /** Provenance as stored. Rows written before types carried provenance
   *  default to `user`, which is what every row in this table was. */
  origin: TypeOrigin;
  family?: PlatformTypeFamily;
  owner_integration?: string;
}

export interface EdgeTypeStore {
  /** Lists a single space's custom edge types. Omit `spaceId` for the
   *  null-space bucket (single-space self-host / platform). */
  list(spaceId?: string): Promise<EdgeTypeSchema[]>;
  get(id: string, spaceId?: string): Promise<EdgeTypeSchema | undefined>;
  create(schema: EdgeTypeSchema, spaceId?: string): Promise<EdgeTypeSchema>;
  delete(id: string, spaceId?: string): Promise<void>;
  /** Load every custom edge type across all spaces for server-startup
   *  registry warmup. Each row carries its owning space so the warmup can
   *  register it into the right space overlay. */
  loadCustomEdgeTypes(): Promise<LoadedEdgeType[]>;
}

/** An edge-type schema paired with the space that owns it — the shape the
 *  startup warmup needs to register each custom type into the correct space
 *  overlay. The empty-string `space_id` is the null-space sentinel. */
export interface LoadedEdgeType {
  space_id: string;
  schema: EdgeTypeSchema;
}

export interface SearchStore {
  search(query: string, filters: SearchFilters): Promise<SearchResult[]>;
  index(
    itemId: string,
    properties: Record<string, unknown>,
    typeId?: string,
    spaceId?: string,
  ): Promise<void>;
  remove(itemId: string): Promise<void>;
}

export interface KeyStore {
  create(
    input: CreateKeyInput,
    keyHash: string,
    spaceId?: string,
  ): Promise<ApiKey>;
  /**
   * Mint a runtime credential. Distinct from `create` because runtime
   * credentials carry the load-bearing `is_runtime_credential` and
   * `connection_id` stamps that the extension gate keys off of —
   * neither field is settable through `CreateKeyInput`. `expires_at` is
   * required: every runtime credential carries a hard lifetime bound so
   * the bearer gate refuses it after expiry and the reaper can retire
   * the row. The one caller is the integration runtime's in-process
   * mint.
   */
  createRuntimeCredential(
    input: CreateKeyInput & {
      connection_id: string;
      expires_at: string;
      /** Null when the manifest cannot be resolved: such a credential holds
       *  no type grants and gets no provenance identity. */
      item_source: string | null;
    },
    keyHash: string,
    spaceId?: string,
  ): Promise<ApiKey>;
  list(): Promise<ApiKey[]>;
  get(id: string): Promise<ApiKey | null>;
  /**
   * List a single space's active (non-revoked) API keys. Used by the
   * platform-admin operator surface to discover keys for emergency
   * revocation. Returns an empty array when the space has no keys.
   */
  listForSpace(spaceId: string): Promise<ApiKey[]>;
  /**
   * Active (non-revoked) keys whose `connection_id` matches. The uninstall
   * and upgrade pipelines use this to locate the runtime credentials bound
   * to a connection before revoking them. Narrows to `spaceId` when one is
   * supplied and to nothing at all when it is not, the same reading of an
   * absent space every other fence here takes — see
   * `storage/space-condition.ts`. Indexed on the `connection_id` column.
   */
  listByConnectionId(connectionId: string, spaceId?: string): Promise<ApiKey[]>;
  validate(
    keyHash: string,
  ): Promise<(ApiKey & { key_hash: string; revoked_at: string | null }) | null>;
  update(id: string, input: UpdateKeyInput): Promise<ApiKey>;
  /**
   * Stamp `revoked_at`. Returns whether this call was the one that revoked
   * the key: a key already revoked answers `false`, so a caller listing the
   * credentials it retired lists the ones it actually retired.
   */
  revoke(id: string): Promise<boolean>;
  updateLastUsed(id: string): Promise<void>;
  count(): Promise<number>;
  /**
   * Revoke every runtime credential whose `expires_at` is strictly before
   * `nowIso`. Belt-and-braces alongside the bearer gate's own expiry
   * check: the gate refuses expired rows immediately, this sweep marks
   * them revoked so the 7-day hard-delete window can start counting.
   * Returns the number of rows revoked.
   */
  revokeExpiredRuntimeCredentials(nowIso: string): Promise<number>;
  /**
   * Revoke runtime credentials that carry no `expires_at` (rows minted
   * before expiry stamping existed) whose `created_at` is strictly before
   * `cutoffIso`. This is the drain for legacy accumulation: pre-expiry
   * rows never age out on their own, so the reaper retires any of them
   * older than the default TTL + grace. Returns the number revoked.
   */
  revokeRuntimeCredentialsWithoutExpiryOlderThan(
    cutoffIso: string,
    nowIso: string,
  ): Promise<number>;
  /**
   * Hard-delete revoked runtime-credential rows whose `revoked_at` is
   * strictly before `cutoffIso`. Runtime credentials are per-dispatch
   * machine artifacts — unlike human keys, keeping revoked rows around
   * indefinitely is pure table growth with no audit value beyond the
   * short window operators might inspect. Returns the number deleted.
   */
  deleteRevokedRuntimeCredentialsOlderThan(cutoffIso: string): Promise<number>;
  /**
   * Hard-delete revoked keys that are NOT runtime credentials and whose
   * `revoked_at` is older than `cutoffIso`. Returns the number deleted.
   *
   * The sibling of the call above, deliberately separate rather than a
   * widening of it. That one reasons its seven-day window as "per-dispatch
   * machine artifacts, not human credentials", and the reasoning does not
   * carry: an ordinary key is minted by a person or a suite, and how long
   * its revocation stays visible is a different judgment. Nothing swept
   * these at all before, which is how a staging instance reached 3,044
   * revoked keys older than a week.
   */
  deleteRevokedKeysOlderThan(cutoffIso: string): Promise<number>;
  /**
   * Instance-wide runtime-credential counters for operator surfaces.
   * `total` counts every runtime-credential row still in the table
   * (revoked included — visibility into accumulation is the point);
   * `active` counts rows that are neither revoked nor past `expires_at`
   * as of `nowIso`.
   */
  countRuntimeCredentials(
    nowIso: string,
  ): Promise<{ total: number; active: number }>;
}

/**
 * Per-space blob metadata store.
 *
 * **Space scoping.** The `blobs` table has a composite PK on
 * `(space_id, hash)`; the same hash can appear under multiple space_ids
 * (the storage backend dedupes physically — one file per hash — but each
 * space gets their own metadata row). The empty string `""` is the
 * sentinel for "instance-wide / single-space / platform-admin"; routes
 * pass `key.space_id ?? ""` so single-space deployments and
 * platform-admin uploads continue to interoperate.
 *
 * `register`, `get`, `remove` all take a space scope — passing the wrong
 * space returns null / no-op rather than the row from another space.
 *
 * `listAll` and `count` are unscoped — they're admin reconciliation
 * helpers (reconcile route + metrics), gated to platform admins at the
 * route layer.
 */
export interface BlobStore {
  register(
    hash: string,
    mimeType: string,
    size: number,
    storagePath: string,
    spaceId: string,
  ): Promise<void>;
  get(
    hash: string,
    spaceId: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null>;
  /**
   * Resolve a hash without a space, for a caller whose authority is not
   * confined to one. Content addressing makes this well defined: every row
   * for a hash describes the same bytes, so any of them answers the
   * question a platform credential is asking.
   *
   * Only the platform-authority read path calls this. A space-bound caller
   * MUST go through `get(hash, spaceId)`, which is what keeps a cross-space
   * probe answering 404.
   */
  getAcrossSpaces(
    hash: string,
  ): Promise<{ mime_type: string; size: number; storage_path: string } | null>;
  /**
   * Returns hashes seen across the entire instance (every space), de-duplicated.
   * Used only by the admin reconcile route + metrics. Space-scoped reads
   * MUST go through `get(hash, spaceId)`.
   */
  listAll(): Promise<string[]>;
  remove(hash: string, spaceId: string): Promise<void>;
  /**
   * Removes every row for a given hash across all spaces. Used only by
   * the admin orphan-cleanup + reconcile routes — the platform admin
   * decided this hash is unreferenced everywhere, so all per-space
   * metadata rows go. Space-scoped deletes use `remove(hash, spaceId)`.
   */
  removeAllForHash(hash: string): Promise<void>;
  count(): Promise<{ count: number; total_size: number }>;
}

export interface WebhookStore {
  create(input: CreateWebhookInput, spaceId?: string): Promise<Webhook>;
  list(spaceId?: string): Promise<Webhook[]>;
  get(id: string, spaceId?: string): Promise<Webhook | null>;
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
  event: string;
  payload: string;
  webhook_url: string;
  webhook_secret: string;
  attempt: number;
  max_attempts: number;
}

export interface WebhookDeliveryStore {
  log(entry: {
    webhookId: string;
    event: string;
    statusCode?: number;
    attempt: number;
    succeeded: boolean;
    error?: string;
  }): Promise<void>;
  list(webhookId: string, limit?: number): Promise<WebhookDelivery[]>;
  schedule(entry: {
    webhookId: string;
    event: string;
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
   * next tick doesn't see it. Same lock-ttl semantics as `getPending`.
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
// Inbound webhook subsystem
// ---------------------------------------------------------------------------

/**
 * Row shape returned by the SQL stores. The route layer translates this
 * to the wire `InboundWebhook` (redacting the secret) at response time.
 * `secret_encrypted` is the raw column value — pass it through
 * `decryptSecret` to recover the plaintext.
 */
export interface InboundWebhookRow {
  id: string;
  space_id: string | null;
  connection_id: string;
  external_service_id: string | null;
  secret_encrypted: string;
  verification_method: string;
  verification_adapter_id: string | null;
  events: string[];
  disabled: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Storage for inbound webhook subscriptions. The store is intentionally
 * narrow — manifest validation and verification dispatch happen at the
 * route layer; this interface just persists rows.
 */
export interface InboundWebhookStore {
  create(input: {
    id: string;
    space_id?: string;
    connection_id: string;
    external_service_id?: string;
    secret_encrypted: string;
    verification_method: string;
    verification_adapter_id?: string;
    events: string[];
  }): Promise<InboundWebhookRow>;
  get(id: string, spaceId?: string): Promise<InboundWebhookRow | null>;
  /**
   * `getAny` — looks up a row regardless of space scope. Used by the
   * public unauth POST /webhooks/inbound/:id receipt path, which has no
   * caller credential to scope by; space isolation is enforced at the
   * subscription / read paths instead.
   */
  getAny(id: string): Promise<InboundWebhookRow | null>;
  listByConnection(
    connectionId: string,
    spaceId?: string,
  ): Promise<InboundWebhookRow[]>;
  /**
   * Flip the subscription's `disabled` flag. Returns whether the flag
   * actually moved, so a caller counting what it disabled counts rows it
   * changed rather than rows it looked at.
   */
  setDisabled(id: string, disabled: boolean): Promise<boolean>;
}

export interface InboundWebhookEventStore {
  /**
   * Insert a receipt row. On a duplicate (inbound_webhook_id,
   * external_delivery_id) pair, the implementation MUST NOT throw —
   * the existing row id is returned with `inserted: false` so the
   * route can distinguish a fresh receipt from a duplicate retry.
   */
  insert(input: {
    id: string;
    inbound_webhook_id: string;
    external_delivery_id: string;
    received_at: string;
    payload: string;
    verified: boolean;
    processing_error?: string;
  }): Promise<{ id: string; inserted: boolean }>;
  list(
    inboundWebhookId: string,
    limit?: number,
  ): Promise<InboundWebhookEvent[]>;
  get(id: string): Promise<InboundWebhookEvent | null>;
  /**
   * Reset a row for manual replay from DLQ. Sets retry_count back to 0,
   * processing_error to null, next_attempt_at to the supplied
   * timestamp — bringing the row back into the pending partial-index
   * window for the reactive runner to pick up.
   */
  resetForRetry(id: string, nextAttemptAt: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Connection OAuth token store
// ---------------------------------------------------------------------------

/**
 * Row shape persisted in `connection_oauth_tokens`. Tokens are stored
 * encrypted under HKDF(MARFA_AUTH_SECRET, "connection-oauth-tokens"); the
 * proxy route decrypts at request time. `previous_refresh_hash` is the
 * SHA-256 (hex) of the most recent rotated-out refresh token, kept for
 * forensic logging — active replay enforcement is the upstream's
 * `invalid_grant` response.
 */
export interface ConnectionOAuthTokenRow {
  id: string;
  connection_id: string;
  space_id: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: string;
  scopes: string[];
  previous_refresh_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionOAuthTokenStore {
  /**
   * Upsert the token for a connection. Existing rows for the same
   * connection_id are overwritten in place — the table is unique on
   * connection_id so re-authorization collapses to a single row.
   */
  upsert(input: {
    connection_id: string;
    space_id?: string;
    access_token_encrypted: string;
    refresh_token_encrypted: string | null;
    expires_at: string;
    scopes: string[];
    /** SHA-256 hex of the rotated-out refresh token; null on initial save. */
    previous_refresh_hash?: string | null;
  }): Promise<ConnectionOAuthTokenRow>;

  /** Lookup by connection_id. Space-scoped when supplied. */
  get(
    connectionId: string,
    spaceId?: string,
  ): Promise<ConnectionOAuthTokenRow | null>;

  /**
   * Hard-delete the row for a connection (used on revocation). Space-scoped
   * when supplied. Returns whether a row was actually deleted, so the
   * uninstall pipeline reports what it removed rather than what it meant to.
   */
  delete(connectionId: string, spaceId?: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Connection leased token store
// ---------------------------------------------------------------------------

/**
 * Row shape persisted in `connection_leased_tokens`. The lease IS a
 * bearer token; storage is hashed (SHA-256) like API keys, plaintext
 * is returned ONCE on issue. Capability gating ties each lease to a
 * manifest-declared `oauth_requirements: { <capability_id>: "leased" }`
 * entry.
 */
export interface ConnectionLeasedTokenRow {
  id: string;
  connection_id: string;
  space_id: string | null;
  capability_id: string;
  lease_token_hash: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  issued_by_key_id: string | null;
  created_at: string;
}

export interface ConnectionLeasedTokenStore {
  create(input: {
    id: string;
    connection_id: string;
    space_id?: string;
    capability_id: string;
    lease_token_hash: string;
    scopes: string[];
    expires_at: string;
    issued_by_key_id?: string;
  }): Promise<ConnectionLeasedTokenRow>;

  /** Hash-keyed lookup — used by the validate endpoint. */
  findByHash(hash: string): Promise<ConnectionLeasedTokenRow | null>;

  /** Id-keyed lookup — used by the revoke endpoint. */
  get(id: string, spaceId?: string): Promise<ConnectionLeasedTokenRow | null>;

  /** List active (non-revoked, non-expired) leases for a connection. */
  listActiveByConnection(
    connectionId: string,
    nowIso: string,
    spaceId?: string,
  ): Promise<ConnectionLeasedTokenRow[]>;

  /** Stamp `revoked_at`. Returns false when the lease was already revoked. */
  revoke(id: string, nowIso: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// User + Space stores (hosted mode only)
// ---------------------------------------------------------------------------

/** Patch shape for `UserStore.updateProfile` — covers PATCH /profile/me
 *  + avatar set/clear. `null` clears; `undefined` leaves unchanged. */
export interface UpdateProfileInput {
  first_name?: string | null;
  last_name?: string | null;
  bio?: string | null;
  avatar_blob_hash?: string | null;
  timezone?: string | null;
}

export interface UserStore {
  create(input: {
    name?: string;
    provider: string;
    provider_id: string;
    space_id: string;
    /** Optional: claim a handle at creation time. The Better Auth
     *  sign-up flow (`POST /auth/sign-up/email`) always stamps it; test
     *  fixtures and admin tooling may leave it null. */
    handle?: string;
    /** Optional: bind to a Better Auth `auth_user.id`. Stamped at sign-up
     *  time by `POST /auth/sign-up/email`. This is the canonical bridge
     *  between Better Auth identity and the Marfa profile. Test fixtures
     *  and admin tooling may leave it null. */
    auth_user_id?: string;
    /** Optional role on creation. No route surfaces this — sign-up flows
     *  default to `member`. Tests and the operator's escape hatch
     *  (`setRole`) use it. */
    role?: MarfaRole;
  }): Promise<User>;
  getById(id: string): Promise<User | null>;
  /** Lookup by Better Auth `auth_user.id`. The single source of truth for
   *  email is `auth_user.email`; this is the canonical cross-table join. */
  getByAuthUserId(authUserId: string): Promise<User | null>;
  getByProvider(provider: string, providerId: string): Promise<User | null>;
  getBySpaceId(spaceId: string): Promise<User | null>;
  /** Lookup by claimed handle. Used for collision detection at claim time. */
  getByHandle(handle: string): Promise<User | null>;
  /** Claim or change a user's handle. Throws on collision. */
  setHandle(id: string, handle: string): Promise<User>;
  /** Operator-only role mutation. No route surfaces this — elevation happens
   *  via SQL or this method from an operator script. */
  setRole(id: string, role: MarfaRole): Promise<User>;
  /** Update the editable profile fields (first/last name, bio, avatar blob
   *  hash). Stamps `updated_at`. `undefined` keys are untouched; `null`
   *  clears the column. */
  updateProfile(id: string, patch: UpdateProfileInput): Promise<User>;
  /** Read the canonical email + verification flag from the Better Auth
   *  `auth_user` row. Returns `null` if no row matches. Used by the
   *  profile endpoints + `/oauth/userinfo` to mirror the email field
   *  without keeping a shadow copy on `users`. */
  getAuthUserEmail(authUserId: string): Promise<{
    email: string;
    email_verified: boolean;
  } | null>;
}

export interface SpaceStore {
  create(name?: string): Promise<Space>;
  get(id: string): Promise<Space | null>;
  /**
   * Enumerate all spaces. Used by background cleanup jobs that fan out
   * per-space. Returns spaces in arbitrary order; callers shouldn't
   * depend on ordering. Cost is O(spaces) — cleanup runs are off the
   * request hot path so the unbounded scan is acceptable.
   */
  list(): Promise<Space[]>;
  getConfig(
    id: string,
  ): Promise<import("@withmarfa/shared").SpaceConfig | null>;
  updateConfig(
    id: string,
    config: import("@withmarfa/shared").SpaceConfig,
  ): Promise<void>;
  /**
   * Flip space status. `suspend` blocks future writes at the auth
   * middleware (reads pass through); `unsuspend` restores. Both are no-ops
   * when the space is already at the target status. Returns the updated
   * row (null if the space id doesn't exist).
   */
  suspend(id: string): Promise<Space | null>;
  unsuspend(id: string): Promise<Space | null>;
  /**
   * Cheap status read for the auth-middleware write-guard. Returns `null`
   * when the space doesn't exist (the gate treats unknown spaces as
   * `active` — the credential's own space_id mismatch is handled
   * separately by the standard auth flow).
   *
   * **A row whose status this build cannot read answers `"suspended"`,
   * not `null`.** Those are different questions and collapsing them would
   * hand the gate `null` for a space that exists, which it reads as
   * nothing to enforce. Implementations narrow through `storedSpaceStatus`,
   * which also logs the row and the true stored value.
   */
  getStatus(
    id: string,
  ): Promise<import("@withmarfa/shared").SpaceStatus | null>;
}

/**
 * Per-space quota store. Stores ceilings; counts are computed on-demand
 * from existing tables at quota-check time.
 */
export interface SpaceQuotaStore {
  /** Returns the per-space ceilings; null when no row exists (use env defaults). */
  get(spaceId: string): Promise<import("@withmarfa/shared").SpaceQuota | null>;
  /**
   * Reads space existence and its optional quota row in one transaction,
   * serialized against space deletion. `exists: true, quota: null` means the
   * space uses environment defaults; `exists: false` means the space is
   * unknown at the read's linearization point.
   */
  getForExistingSpace(spaceId: string): Promise<
    | {
        exists: true;
        quota: import("@withmarfa/shared").SpaceQuota | null;
      }
    | { exists: false; quota: null }
  >;
  /** Upserts ceilings. Pass null on a field to clear it (revert to env default). */
  set(
    spaceId: string,
    input: {
      items_limit?: number | null;
      webhooks_limit?: number | null;
      blobs_limit?: number | null;
      storage_bytes_limit?: number | null;
      rate_per_minute_limit?: number | null;
    },
  ): Promise<import("@withmarfa/shared").SpaceQuota>;
  /**
   * Upsert ceilings only while the space row exists. The existence read and
   * write are serialized against account deletion, so an unknown space or a
   * deletion that wins the space lock returns null without leaving an orphan
   * quota row.
   */
  setForExistingSpace(
    spaceId: string,
    input: {
      items_limit?: number | null;
      webhooks_limit?: number | null;
      blobs_limit?: number | null;
      storage_bytes_limit?: number | null;
      rate_per_minute_limit?: number | null;
    },
  ): Promise<import("@withmarfa/shared").SpaceQuota | null>;
  /** Returns the current count for a resource within a space. */
  count(
    spaceId: string,
    resource: import("@withmarfa/shared").QuotaResource,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// OAuth store
//
// This store is scoped to the device-flow state machine and OAuth-grant
// last_used stamping. The OAuth-protocol surfaces (clients / codes / tokens)
// are owned by the @better-auth/oauth-provider plugin tables (`auth_oauth_*`);
// read helpers live on `OauthProviderStore` below.
// ---------------------------------------------------------------------------

export interface OAuthStore {
  // ----- Device Authorization Grant (RFC 8628) -----

  /** Insert a new device-code row. Caller hashes `device_code` and supplies
   *  the unique `user_code`; both are stored verbatim. Used by the
   *  initiate endpoint. */
  createDeviceCode(input: {
    deviceCodeHash: string;
    userCode: string;
    clientId: string;
    scope: string;
    expiresAt: string;
    intervalSeconds: number;
  }): Promise<import("@withmarfa/shared").OAuthDeviceCode>;

  /** Lookup by SHA-256 of the device_code. Used by the polling endpoint.
   *  Returns null if the row doesn't exist; expired rows are returned
   *  with `status: "pending"` (caller checks `expires_at` to decide). */
  findDeviceCodeByHash(
    hash: string,
  ): Promise<import("@withmarfa/shared").OAuthDeviceCode | null>;

  /** Lookup by user_code. Used by the verification page. */
  findDeviceCodeByUserCode(
    userCode: string,
  ): Promise<import("@withmarfa/shared").OAuthDeviceCode | null>;

  /** Stamp `last_polled_at`. Used by the polling endpoint to detect
   *  `slow_down` (client polled inside the interval window). */
  markDeviceCodePolled(id: string, now: string): Promise<void>;

  /** Flip status to `approved`, set `connection_item_id` and
   *  `approved_at`. Returns false if the row was not pending. */
  approveDeviceCode(id: string, connectionItemId: string): Promise<boolean>;

  /** Flip status to `denied`. Returns false if the row was not pending. */
  denyDeviceCode(id: string): Promise<boolean>;

  /**
   * Delete every device code bound to a projected grant, so revoking that
   * grant leaves nothing behind that can still be exchanged for a token.
   *
   * **Keyed on `connection_item_id`, never on `client_id`.** The table
   * carries a client id and no user column, because a pending row is
   * pre-consent and the user it will belong to is genuinely unknown. A
   * sweep by client would therefore delete every OTHER user's in-flight
   * device login for that client, turning one person's revoke into a
   * denial of service across everyone using the same app. The foreign key
   * reaches exactly the approved codes bound to the grant being revoked.
   *
   * A pending code for the same client survives, and that is correct
   * rather than a gap: approving one runs the grant projection, which is a
   * fresh consent the user has just given.
   */
  deleteDeviceCodesForGrant(connectionItemId: string): Promise<void>;

  /**
   * Conditional `last_used_at` stamp on the underlying `system.connection`
   * (kind: app) for an OAuth grant. Mirrors `KeyStore.updateLastUsed` in
   * shape: the WHERE clause only writes when the existing
   * `properties.last_used_at` is NULL or older than `now - thresholdMs`,
   * so the row is updated at most once per `thresholdMs` regardless of
   * how many instances call concurrently.
   *
   * The auth middleware layers a per-process in-memory cache on top to
   * skip the DB round-trip when the calling instance has already stamped
   * inside the window — that cache is a first-line short-circuit, not
   * the authoritative throttle. Cluster-wide debounce comes from the
   * conditional UPDATE here.
   *
   * Space-scoped: the WHERE matches `(id, space_id)` so a hosted-mode
   * caller cannot trip this against another space's grant row. Pass
   * `null` for the unscoped (single-space self-host) case.
   *
   * Best-effort: callers swallow errors. The middleware-side cache mark
   * already prevents a stampede; storage failures must never break the
   * auth path.
   */
  updateLastUsedAt(
    connectionItemId: string,
    spaceId: string | null,
    thresholdMs: number,
  ): Promise<void>;

  /**
   * Resolves once every in-flight `updateLastUsedAt` stamp has settled.
   * The stamp is fire-and-forget from the bearer middleware, so `close()`
   * drains it the way the audit store drains its writes — a stamp still
   * opening a connection when the pool ends is otherwise an unhandled
   * rejection.
   */
  drain(): Promise<void>;
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
 * route doesn't have to peek into dialect-specific Drizzle internals.
 */
export interface OauthAccessTokenRow {
  id: string;
  userId: string | null;
  clientId: string;
  /** Space id resolved via the plugin's `clientReference` callback at
   *  token-issuance time (mirrors `auth_oauth_access_token.reference_id`).
   *  Null in keys-mode self-hosts where no per-user space exists. */
  referenceId: string | null;
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
  /** Space binding from `clientReference` (Marfa: space_id). */
  referenceId: string | null;
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
 * Input to `OauthProviderStore.createClient`, used by Marfa's
 * `POST /auth/oauth2/register` override (which fronts the plugin's DCR
 * endpoint — see `routes/oauth-register.ts`).
 *
 * The override exists because:
 *
 * 1. The plugin's DCR (`POST /auth/oauth2/register`) hardcodes a Zod enum
 *    of three grant types and rejects the device-code URN at validation
 *    time — there's no config knob to widen it (verified in
 *    `@better-auth/oauth-provider@1.6.13`).
 * 2. The plugin's DCR write path goes through Better Auth's Drizzle
 *    adapter, which sets `supportsArrays: true` for the `pg` provider
 *    (verified in `@better-auth/drizzle-adapter@1.6.13`). The adapter then
 *    passes JS arrays directly
 *    into the `text` columns (`scopes`, `redirect_uris`, `grant_types`,
 *    `response_types`, etc.). Postgres coerces those to comma-joined
 *    strings on write; on read, the plugin's `schemaToOAuth` calls
 *    `scopes?.join(" ")` on a string → `TypeError`, surfaced as HTTP 500.
 *    The Marfa schema is intentionally `text` (JSON-encoded string), not
 *    `text[]` — Marfa's own `mintTokenPair` write path uses
 *    `JSON.stringify` and the read helpers (`getClient`,
 *    `validateAccessToken`) `safeJsonParse` on the way back out. The
 *    plugin DCR is the only Better-Auth-internal writer to
 *    `auth_oauth_client`, so routing around it is sufficient.
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
  /** Space binding from the resolver — null for unauthenticated /
   *  keys-mode DCR. Mirrors `clientReference` in the plugin's wiring. */
  referenceId: string | null;
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
  referenceId: string | null;
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
  /** Update the browser-logout configuration for an existing first-party
   * client. Used by the deployment seed so a pre-existing client gains new
   * redirect URIs without requiring a destructive reset. */
  updateClientLogoutConfig(
    clientId: string,
    postLogoutRedirectUris: readonly string[],
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
   * Returns null for a code this store does not recognise, which the caller
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
   * null if the token doesn't exist (e.g. already deleted by a prior
   * chain-revocation pass).
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
   *  columns matching the rest of Marfa's write paths (see
   *  `CreateClientInput` for the upstream-bug context). Used exclusively
   *  by the Marfa-owned `POST /auth/oauth2/register` route in
   *  `routes/oauth-register.ts`; the plugin's own DCR endpoint is NOT
   *  exercised on Marfa deployments. */
  createClient(input: CreateClientInput): Promise<CreateClientResult>;
  /** Existence check on `(clientId)` for the registration route to surface
   *  a clean 409 instead of a Postgres unique-violation. */
  clientExists(clientId: string): Promise<boolean>;
  /**
   * Resolve the projected `system.connection { kind: "app" }` item id for a
   * (spaceId, clientId, authUserId) tuple. Returns the `items.id` value or
   * `null` if no projection exists (consent never ran, or the row was
   * hard-deleted).
   *
   * Used by the bearer middleware to find the `system.connection` row it
   * needs to stamp `last_used_at` on, and by the re-consent path to update
   * the row's `scopes` property when the user grants a different scope set.
   *
   * Single-row indexed query: matches on `(type, space_id)` and predicates
   * on `properties.kind / .client_id / .user_id` via the dialect's JSON
   * extractor. Sub-ms in PG, sub-ms in SQLite.
   *
   * Space-scoped: pass `null` for the unscoped (single-space self-host)
   * case so the row's `space_id IS NULL` predicate is used. A hosted-mode
   * caller passing a real space cannot cross-space-match.
   */
  findGrantItemId(opts: {
    spaceId: string | null;
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
   * Instance-wide: clients carry a `reference_id` (space binding) but the
   * grantless predicate is space-agnostic — a row with zero grants is dead
   * regardless of which space registered it. The single-statement delete
   * keeps this off the per-space fan-out path.
   */
  deleteGrantlessClientsOlderThan(cutoffIso: string): Promise<number>;
}

// `OauthProviderStore.updateGrantScopes` was dropped. The re-consent path
// now updates the projection via the standard `storage.items.update` route
// (writes a `versions` snapshot, bumps `updated_at` + `version`, lets the
// projection participate in `/items?sort=updated_at` correctly).
// See `projectGrantOnConsent` in `routes/auth-consent.ts`.

// ---------------------------------------------------------------------------
// Audit store
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  timestamp: string;
  key_id: string | null;
  /**
   * Space scope. Stamped at write time from the calling api key's
   * `space_id`. Null for system-initiated audits (install pipeline,
   * cycle-budget overflow) and for bootstrap-admin keys that have no space.
   * `GET /audit` filters on this column when the caller is space-scoped;
   * space-less callers (bootstrap admin) read every row.
   */
  space_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  /**
   * Resolved client IP. Persisted into `details.client_ip` so no schema
   * migration is needed; surfaced as a typed top-level field on the read
   * path. Null for system-initiated audits (install pipeline, cycle-budget
   * overflow) where no Hono context exists.
   */
  client_ip: string | null;
  details: Record<string, unknown>;
}

/** One audit row, in the shape both writers below take. */
export interface AuditLogEntry {
  key_id?: string;
  /** Space scope. Pass `c.get("apiKey")?.space_id ?? null` from route
   *  handlers; null for system-initiated audits and for the bootstrap-admin
   *  shape on self-hosted single-space deployments. */
  space_id?: string | null;
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
   * and awaiting it does not make it one. Sixteen call sites awaited it
   * inside a try/catch built to fail the operation on an unaudited write;
   * every one of those was unreachable. Awaiting is still worth doing where
   * the row has to be issued inside the caller's transaction, but say so at
   * the call site, because the failure handling reads as live otherwise.
   *
   * Use `logOrThrow` when an unaudited operation must not stand.
   */
  log(entry: AuditLogEntry): Promise<void>;
  /**
   * Write an audit row and propagate a failure to the caller.
   *
   * For the operations where an unaudited success is worse than a loud
   * failure: an account hard-delete, and the connection install and
   * uninstall, which are the two ways a credential's whole authority
   * changes hands. Untracked deliberately — the caller is awaiting it, so
   * there is nothing in flight for shutdown to drain.
   *
   * **Propagating is the whole of what this promises.** It is not by
   * itself a transactional write. Which connection the insert lands on is
   * decided by the db handle the store was built with and by whatever
   * request context is installed around the call, neither of which is this
   * method's to choose. A caller that needs the row to commit or roll back
   * with its own transaction has to put the store on that transaction; the
   * account cascade is the one that does, and it says how.
   */
  logOrThrow(entry: AuditLogEntry): Promise<void>;
  list(filters: {
    action?: string;
    resource_type?: string;
    resource_id?: string;
    since?: string;
    until?: string;
    limit?: number;
    cursor?: string;
    /** Space-scope filter. When set, returns only rows whose `space_id`
     *  matches. When omitted, every row is returned — bootstrap-admin reads
     *  on a self-hosted deployment, plus the cleanup job which is global. */
    space_id?: string | null;
  }): Promise<PaginatedResult<AuditEntry>>;
  /**
   * Hard-delete rows whose `timestamp` is older than the retention window.
   * The optional `spaceId` filter lets the cleanup job fan out per-space,
   * honoring per-space retention overrides:
   *
   * - `undefined` — every row older than the cutoff (unscoped sweep).
   * - `string` — only rows where `space_id` matches.
   * - `null` — only rows where `space_id IS NULL` (system-initiated
   *   audits + the no-space rows that single-space self-hosts use).
   *
   * Returns the number of rows actually deleted.
   */
  cleanup(retentionDays: number, spaceId?: string | null): Promise<number>;
  /**
   * Redact rows that identify a specific `auth_user.id` ahead of a
   * hard-delete of the account. Rewrites `audit_log.details` to
   * `{ redacted: true, user_id_sha256: <hex> }` for every row whose
   * `resource_id === authUserId` OR whose `details` JSON object contains
   * any field whose value equals `authUserId` (exact-equality match —
   * substring matches are ignored to avoid false positives).
   *
   * The row's `action`, `resource_type`, `timestamp`, and `id` are
   * preserved — the audit chain remains intact; only personally identifying
   * payload is scrubbed.
   *
   * Returns the number of rows rewritten.
   */
  redactForUser(authUserId: string): Promise<number>;
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
  space_id: string | null;
  payload: string;
  /**
   * The connection whose action set off this chain of events. Null for
   * events originating from a human caller.
   */
  originating_connection_id: string | null;
  /** Hop number from the originating event. 0 = first event in a chain. */
  hop_count: number;
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
    space_id?: string;
    payload: string;
    /** Cycle-detection metadata. */
    originating_connection_id?: string | null;
    hop_count?: number;
  }): Promise<bigint>;

  /** Retrieve events after a given ID, optionally filtered by space. */
  getAfter(
    afterId: bigint,
    limit: number,
    spaceId?: string,
  ): Promise<PersistedEvent[]>;

  /**
   * Delete events older than the given retention window. Same `spaceId`
   * semantics as `AuditStore.cleanup`: undefined sweeps everything, a
   * string scopes to that space, `null` scopes to rows whose
   * `space_id IS NULL`. Returns count deleted.
   */
  cleanup(retentionHours: number, spaceId?: string | null): Promise<number>;

  /** Smallest surviving event id, scoped to a space when provided.
   *  Returns null when no events match. Used by the SSE route to
   *  detect clients whose `Last-Event-ID` predates the retention
   *  window so it can emit a terminal `catchup_too_old` event
   *  instead of silently resuming mid-stream. */
  getMinRetainedId(spaceId?: string): Promise<bigint | null>;
}

// ---------------------------------------------------------------------------
// Settings store (instance-wide KV for bootstrap sentinel etc.)
// ---------------------------------------------------------------------------

export interface SettingsStore {
  /** Returns null when the key has not been set. */
  get(key: string): Promise<string | null>;
  /** Upsert — overwrites any existing value for the key. */
  set(key: string, value: string): Promise<void>;
  /** Atomic insert-or-bail: returns true if this caller's INSERT created the
   *  row, false if a row already existed. Used by the bootstrap path so that
   *  exactly one of N concurrent `POST /keys` on a fresh DB wins the right
   *  to mint the seed admin key. */
  claim(key: string, value: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Aggregate storage interface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edge store
// ---------------------------------------------------------------------------

export interface EdgeListFilters {
  edge_type?: string | string[];
  limit?: number;
  cursor?: string;
}

export interface EdgeStore {
  /** Create an edge. Constraint enforcement (cardinality / cycles / type) sits outside. */
  createRaw(input: CreateEdgeInput, spaceId?: string): Promise<Edge>;
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
   * Global list of edges across the whole space. Used by clients that need
   * "every edge of type X" (thread-root counting, taxonomy traversal, etc.)
   * — replaces the N+1 walk-every-item pattern. Space-scoped; trashed-item
   *  filtering is the caller's responsibility (edges to trashed items are
   *  still real edges from a graph perspective).
   */
  list(
    filters?: EdgeListFilters & { spaceId?: string },
  ): Promise<PaginatedResult<Edge>>;
  /**
   * Replace an edge's properties in place. `source_id` / `target_id` /
   * `edge_type` are immutable. When `spaceId` is supplied the UPDATE is
   * additionally fenced to that space so a space-scoped caller cannot
   * mutate another space's edge by id — a cross-space id matches zero
   * rows and throws `edge ... not found`. Omitting `spaceId` leaves the
   * update unscoped (platform-admin / single-space self-host).
   */
  updateProperties(
    id: string,
    properties: Record<string, unknown>,
    spaceId?: string,
  ): Promise<Edge>;
  /**
   * Delete an edge by id. When `spaceId` is supplied the DELETE is fenced
   * to that space so a space-scoped caller cannot delete another space's
   * edge by id — a cross-space id matches zero rows and is a silent no-op
   * (the route layer's prior 404-cloak is the user-visible signal). Omitting
   * `spaceId` leaves the delete unscoped (platform-admin / single-space
   * self-host).
   */
  delete(id: string, spaceId?: string): Promise<void>;
  deleteBySource(
    sourceId: string,
    edgeType?: string,
    spaceId?: string,
  ): Promise<void>;
  deleteByTarget(
    targetId: string,
    edgeType?: string,
    spaceId?: string,
  ): Promise<void>;
  /**
   * Batched `deleteBySource` — drop every edge whose `source_id` is in
   * `sourceIds`, optionally filtered by `edge_type`. Single SQL DELETE per
   * call regardless of how many ids are passed. Returns the number of
   * rows deleted; an empty `sourceIds` is a 0-row no-op. Used by the
   * bulk-action purge worker so 100 items' worth of outbound edges drop
   * in one statement instead of 100.
   */
  deleteBySourceBatch(sourceIds: string[], edgeType?: string): Promise<number>;
  /** Mirror of `deleteBySourceBatch` for inbound edges. */
  deleteByTargetBatch(targetIds: string[], edgeType?: string): Promise<number>;
  /**
   * Count edges where the given item is source. Used for cardinality checks.
   * When `spaceId` is supplied the count is fenced to that space so a
   * space-scoped cardinality check never folds in another space's edges.
   */
  countBySource(
    sourceId: string,
    edgeType: string,
    spaceId?: string,
  ): Promise<number>;
  /**
   * Count edges where the given item is target. Used for cardinality checks.
   * Same `spaceId` fence semantics as `countBySource`.
   */
  countByTarget(
    targetId: string,
    edgeType: string,
    spaceId?: string,
  ): Promise<number>;
  /**
   * Batched `countBySource` — for each distinct `(source_id, edge_type)` pair
   * returns the row count. Key format: `${source_id}|${edge_type}`. Pairs
   * absent from the result map have count zero. One SQL query per distinct
   * `edge_type` in `pairs`. `spaceId` fences each query to that space.
   */
  countsBySourceBatch(
    pairs: { source_id: string; edge_type: string }[],
    spaceId?: string,
  ): Promise<Map<string, number>>;
  /**
   * Batched `countByTarget` — mirror of `countsBySourceBatch`, keyed as
   * `${target_id}|${edge_type}`.
   */
  countsByTargetBatch(
    pairs: { target_id: string; edge_type: string }[],
    spaceId?: string,
  ): Promise<Map<string, number>>;
  /**
   * Exact-duplicate check (source_id, target_id, edge_type). `spaceId`
   * fences the lookup so a cross-space edge with the same triple is invisible.
   */
  existsExact(
    sourceId: string,
    targetId: string,
    edgeType: string,
    spaceId?: string,
  ): Promise<boolean>;
  /**
   * Batched `existsExact` — returns the subset of triples that already exist.
   * Key format: `${source_id}|${target_id}|${edge_type}`. Callers check
   * membership to decide whether to reject a proposed edge as a duplicate.
   * One SQL query per distinct `edge_type`. `spaceId` fences each query.
   */
  existsExactBatch(
    pairs: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }[],
    spaceId?: string,
  ): Promise<Set<string>>;
  /**
   * Batched triple-to-Edge lookup. For each `(source_id, target_id, edge_type)`
   * that matches an existing row, returns the full `Edge` keyed as
   * `${source_id}|${target_id}|${edge_type}`. Triples with no match are
   * absent. Used by `POST /edges/bulk` upsert to resolve duplicate edges to
   * their ids for in-place property updates. One SQL query per distinct
   * `edge_type`.
   *
   * When `spaceId` is supplied the lookup is fenced to that space so a
   * space-scoped bulk upsert never resolves (and then mutates) another
   * space's edge that happens to share the same `(source, target, type)`
   * triple. Omitting `spaceId` leaves the lookup unscoped.
   */
  findByTriplesBatch(
    pairs: {
      source_id: string;
      target_id: string;
      edge_type: string;
    }[],
    spaceId?: string,
  ): Promise<Map<string, Edge>>;
  /**
   * All outbound edges of a given type from sourceId. Used for cycle checks,
   * cascade-on-delete, and edge hydration when the caller wants every entry.
   * `spaceId` fences the walk so cycle detection never traverses another
   * space's edges.
   */
  listOutboundOfType(
    sourceId: string,
    edgeType: string,
    spaceId?: string,
  ): Promise<Edge[]>;
  /**
   * All edges touching the given item — outbound (item is source) and inbound
   * (item is target). Used by cascade-on-delete to gather the full edge set
   * around an item being deleted. `spaceId` fences the gather so cascade
   * planning never reads across spaces.
   */
  listAllByItem(
    itemId: string,
    spaceId?: string,
  ): Promise<{ outbound: Edge[]; inbound: Edge[] }>;
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
 * Cross-instance coordination primitives. On Postgres, `withJobLock` wraps
 * `pg_try_advisory_lock` so a named background job runs on at most one
 * instance per tick. On SQLite, every backing database is single-process
 * by definition, so the implementation is a pass-through.
 */
/**
 * Cleanup hooks for the better-auth `auth_session` table. Better Auth itself
 * owns the session TTL via `expiresAt`; this store exists only to drop rows
 * past that timestamp on a periodic sweep so the table doesn't grow unbounded
 * across hosted multi-space scale.
 *
 * Instance-wide by design — `auth_session` carries no `space_id` column, the
 * deletion criterion is purely time-based, and there's no per-space retention
 * knob. Mirrors the `VersionThinner` shape rather than the per-space fan-out
 * used for retention-window jobs.
 */
export interface AuthSessionStore {
  /** Delete every `auth_session` row whose `expires_at` is strictly
   *  before `now`. Returns the number of rows deleted. */
  deleteExpired(now: Date): Promise<number>;
}

/**
 * Account-lifecycle store. Surfaces the `auth_user.deletion_state` +
 * `pending_deletion_at` columns for the GDPR account-deletion lifecycle.
 * Grouped under a single sub-interface so the route layer reads as
 * `storage.accountLifecycle.markPendingDeletion(...)` and the surface
 * is greppable as a unit.
 *
 * The hard-delete cascade itself is a top-level `Storage` method
 * (`deleteAccountCascade`) because it spans every per-space table plus
 * the auth island — it doesn't sit cleanly inside one sub-store. The
 * cascade re-checks `deletion_state === 'pending_deletion'` and
 * `pending_deletion_at < cutoffIso` inside its transaction (with `FOR
 * UPDATE` on PG to serialize against the cancel route's
 * `cancelPendingDeletion` UPDATE), and short-circuits if either predicate
 * is no longer true.
 */
export interface AccountLifecycleStore {
  /** Flip `auth_user.deletion_state` → `'pending_deletion'`, stamp
   *  `pending_deletion_at = nowIso`, AND inside the same transaction:
   *  revoke every `api_keys` row for the user's space + delete every
   *  `auth_session` for the user. Idempotent — re-running on a
   *  pending row just re-stamps `pending_deletion_at`. */
  markPendingDeletion(authUserId: string, nowIso: string): Promise<void>;
  /** Flip the state back to `'active'` and clear `pending_deletion_at`.
   *  Returns `true` when a row was actually flipped; `false` when the
   *  UPDATE matched zero rows (account already cancelled or already
   *  hard-deleted by a cascade that won the race). The cancel routes
   *  branch on the return: `true` → standard "Account restored"
   *  confirmation; `false` → "already permanently deleted" themed page +
   *  distinct audit action so the audit trail is honest. */
  cancelPendingDeletion(authUserId: string): Promise<boolean>;
  /** Read the lifecycle row by `auth_user.id`. Returns null when no
   *  matching row exists. */
  getAccountLifecycle(authUserId: string): Promise<{
    deletion_state: DeletionState;
    pending_deletion_at: string | null;
  } | null>;
  /** Pre-sign-in middleware lookup keyed by lower-cased email. */
  getAccountLifecycleByEmail(email: string): Promise<{
    auth_user_id: string;
    deletion_state: DeletionState;
    pending_deletion_at: string | null;
  } | null>;
  /** Purger fan-out — every account whose `pending_deletion_at` is
   *  strictly older than `cutoffIso` and still in `pending_deletion`. */
  listPendingDeletionDue(
    cutoffIso: string,
  ): Promise<{ auth_user_id: string }[]>;
}

export interface CoordinationStore {
  /**
   * Attempt to acquire a named coordination lock, run `fn`, release the
   * lock. Returns `fn`'s result on acquisition, `undefined` when another
   * instance already holds the lock (the caller should treat this as a
   * no-op tick, not an error).
   */
  withJobLock<T>(
    name: string,
    fn: () => Promise<T>,
    options?: {
      /**
       * How long to wait for the underlying reservation before answering
       * `undefined`. Callers on a request path pass a tight budget — their
       * fallback is better than their user waiting; background ticks keep
       * the generous default and ride out load spikes. Ignored by the
       * SQLite implementation, which has nothing to reserve.
       */
      reserveTimeoutMs?: number;
    },
  ): Promise<T | undefined>;
  /**
   * `withJobLock` for the one caller whose `fn` runs for the process
   * lifetime rather than a tick — the reactive-run bridge's drainer
   * election. Separated because a permanent holder is capacity
   * subtracted from whatever pool serves it: on Postgres this reserves
   * from a dedicated single-connection client so a drainer can never
   * crowd out streams or job ticks. Same contract otherwise: `undefined`
   * when another instance holds the lock.
   */
  withLongLivedJobLock<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined>;
  /**
   * Acquire a named lock, waiting rather than skipping when another caller
   * holds it. Connection mint and uninstall use this to serialize lifecycle
   * decisions across server instances; unlike a background-job lock, either
   * operation must eventually run and re-check state under the same lock.
   *
   * `fn` runs outside whatever the implementation uses to hold the lock, on
   * the connection the storage layer would normally use. An implementation
   * must not assume it can bracket `fn` in its own transaction: callers open
   * transactions of their own. The Postgres implementation is transaction-
   * scoped for the pooler reasons in `pg/coordination-store.ts`, so a lock
   * held here survives exactly as long as this call and no longer.
   */
  withExclusiveLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Take a named lock on the caller's **current** transaction, releasing it
   * when that transaction ends. Must be called inside `runInTransaction`.
   *
   * This exists because `withExclusiveLock` cannot guard a write. It holds
   * its own connection for the length of `fn`, so a request that already
   * holds one needs a second — and once enough concurrent requests each hold
   * one and wait for another, the pool is exhausted by callers who will never
   * release. `runInTransaction` avoids that by routing through the ambient
   * transaction; a lock guarding a write has to do the same. It also has to,
   * for correctness: `withExclusiveLock` releases before the caller's
   * transaction commits, so the next lock-holder can read a count that does
   * not yet include the write it was meant to be excluded from. A lock that
   * ends with the transaction cannot have that gap.
   */
  lockInTransaction(name: string): Promise<void>;
}

/**
 * Cluster-shared rate-limit + per-email throttle counters.
 *
 * Backing table `rate_limit_windows` keyed on (family, window_key). Two
 * production consumers ride the same store:
 *
 *   - `rate-limit middleware` (family = "rate") — per-credential and
 *     per-space request windows. Window keys take the shape
 *     "<credential-id-or-ip>:<path-prefix>" and "space:<space-id>";
 *     window size from `AppConfig.rateLimitWindowMs` (default 60s).
 *   - `forgot-password per-email throttle` (family = "throttle") —
 *     window key "forgot-password:<lowercased-email>"; window size 1h.
 *
 * The single primitive — atomic increment-counter-bounded-by-window —
 * services both. Production storage (PG + SQLite) implements via
 * `INSERT ... ON CONFLICT DO UPDATE` so two server instances pointed at
 * the same DB share counters cluster-wide. SQLite is single-process by
 * file lock so "shared" collapses to "still correct in-process" — same
 * code path, same semantics.
 *
 * Hot path: one DB round-trip per gated request. Acceptable at target
 * scale (low-thousands of req/s peak); PG handles tens of thousands of
 * single-row upserts per second on commodity hardware.
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
   * The single-row UPDATE serializes concurrent writers via Postgres
   * row-level locking (and via SQLite's BEGIN IMMEDIATE on libsql), so
   * two instances racing the same key cannot both observe `count == 1`
   * inside one window.
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
   * trips on the hot path were pure multiplier. Keys are deduplicated
   * and applied in sorted order so two concurrent batches cannot
   * deadlock on row-lock ordering. Returns a map keyed by window key.
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
 * Typed handle that storage implementations expose for the better-auth
 * integration (§3.13). The two dialect-specific Drizzle handles diverge
 * structurally; the public Storage contract carries them as `unknown`
 * so the consumer (auth/instance.ts) is the single site that narrows.
 *
 * Both fields are optional on `Storage` because not every test fixture
 * needs to wire better-auth — leaving them unset disables the adapter
 * mount in `app.ts`.
 */
export interface BetterAuthStorageAdapter {
  /** Drizzle DB handle. Typed `unknown` here so the Storage interface
   *  stays portable; `auth/instance.ts` casts via `Parameters<typeof
   *  drizzleAdapter>[0]` so the surface is still typed at the consumer. */
  betterAuthDb: unknown;
  /** Dialect discriminator — `auth/instance.ts` uses this to pick the
   *  right Drizzle schema bundle. */
  betterAuthDialect: "sqlite" | "pg";
}

// ---------------------------------------------------------------------------
// bulk_action_jobs store
// ---------------------------------------------------------------------------

export type BulkActionJobStatus =
  "queued" | "in_progress" | "completed" | "failed" | "cancelled";

/** Server-side row shape for a `bulk_action_jobs` entry. The SDK-facing
 *  envelope (`BulkActionJob` in `@withmarfa/sdk/client`) is a strict subset
 *  — fields like `matched_ids`, `worker_id`, `worker_heartbeat_at`,
 *  `api_key_id`, and the original `input` are server-internal. */
export interface BulkActionJobRow {
  id: string;
  space_id: string | null;
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
  space_id: string | null;
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
   * and a row with the same `(space_id, idempotency_key)` already
   * exists, returns that existing row instead of creating a new one
   * — the `ON CONFLICT` happens at the unique-index level so this is a
   * race-safe replay path.
   */
  create(input: CreateBulkActionJobInput): Promise<BulkActionJobRow>;
  /** Fetch by id. Space scoping is the caller's responsibility — the
   *  store returns the row regardless. The route handler enforces auth
   *  (`api_key_id` match or admin). */
  getById(id: string): Promise<BulkActionJobRow | null>;
  /**
   * Atomically claim the next queued job. On Postgres, wraps a single
   * UPDATE in `SELECT … FOR UPDATE SKIP LOCKED` so multiple server
   * processes coordinate naturally. Sets `status='in_progress'`,
   * `started_at`, `worker_id`, `worker_heartbeat_at`. Returns the
   * claimed row, or `null` if the queue is empty.
   *
   * SQLite has no FOR UPDATE — single-process by design, so a plain
   * `UPDATE WHERE status='queued' RETURNING …` with `LIMIT 1` suffices.
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
   *  `cancelled`; no-op (returns `false`) on already-terminal rows.
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
   * `expireBeforeIso`. Returns the number of rows deleted. Called by
   * the maintenance sweep on the same cadence as `purgeTrashedOlderThan`.
   */
  gcExpired(expireBeforeIso: string): Promise<number>;
}

/** A file item the enrichment sweeper should extract text from. */
export interface EnrichmentCandidate {
  item_id: string;
  space_id: string | null;
  type: string;
  blob_ref: string;
  mime_type: string;
}

export interface EnrichmentStateInput {
  item_id: string;
  space_id: string | null;
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
  config_signature?: string | null;
}

export interface EnrichmentStateRecord extends EnrichmentStateInput {
  updated_at: string;
}

/**
 * Bookkeeping for the deterministic text-enrichment sweeper. One row per
 * file item the sweeper has looked at; the candidate query is the whole
 * trigger mechanism (state-based, never event-based, so integration
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

export interface Storage extends Partial<BetterAuthStorageAdapter> {
  items: ItemStore;
  metadata: MetadataStore;
  versions: VersionStore;
  types: TypeStore;
  search: SearchStore;
  keys: KeyStore;
  blobs: BlobStore;
  edges: EdgeStore;
  edgeTypes: EdgeTypeStore;
  oauth: OAuthStore;
  /** Thin lookup helpers over the @better-auth/oauth-provider plugin's
   *  tables (`auth_oauth_client`, `auth_oauth_consent`). Used by the
   *  consent route + grant-projection after-hooks. Optional — test
   *  contexts that skip the OAuth surface can omit. */
  oauthProvider?: OauthProviderStore;
  outboundWebhooks: WebhookStore;
  outboundWebhookDeliveries: WebhookDeliveryStore;
  inboundWebhooks: InboundWebhookStore;
  inboundWebhookEvents: InboundWebhookEventStore;
  connectionOauthTokens: ConnectionOAuthTokenStore;
  connectionLeasedTokens: ConnectionLeasedTokenStore;
  audit: AuditStore;
  eventLog: EventLogStore;
  /** Optional sweep store for expired better-auth session rows. Absent on
   *  test contexts that don't wire better-auth (the cleanup job in
   *  `index.ts` is gated on this being present). */
  authSessions?: AuthSessionStore;
  /** Account-lifecycle store (delete state + pending stamp). Always wired
   *  by both dialect factories; the route layer + the purger consult it.
   *  Marked optional only because some in-tree test stubs do not implement
   *  it; production Storage always exposes it. */
  accountLifecycle?: AccountLifecycleStore;
  settings: SettingsStore;
  coordination: CoordinationStore;
  /** Async substrate for `POST /items/bulk-actions`. Always wired on both
   *  dialects. The worker module reads + writes through this store; the
   *  route handler creates jobs + serves GET / DELETE. */
  bulkActionJobs: BulkActionJobStore;

  users?: UserStore;
  spaces?: SpaceStore;
  /** Per-space quotas. Always present (counts even when no per-space
   *  ceilings are set). */
  spaceQuotas: SpaceQuotaStore;
  /**
   * Cluster-shared rate-limit + per-email throttle counters. Always wired
   * by both dialect factories; the middleware + the forgot-password route
   * consult it. Required (not optional) because the rate-limit middleware
   * can't degrade gracefully without it — a missing store would silently
   * degrade to "no rate limit", which is the wrong default.
   */
  rateLimits: RateLimitStore;
  /** Deterministic text-enrichment bookkeeping. Always wired by both
   *  dialect factories; the sweeper is the only consumer. */
  enrichment: EnrichmentStore;
  /**
   * Optional reference to the wrapped Postgres Drizzle instance, exposed
   * so the RLS middleware can drive `db.transaction(...)` to wrap each
   * space-bounded request. Set only on the PG storage; `undefined` on
   * SQLite (RLS is PG-only). The middleware skips the role-switch wrapping
   * when this is undefined. Typed `unknown` for portability; the middleware
   * casts via the PgDb type at consumer-site.
   */
  pgDb?: unknown;
  /**
   * Optional reference to the underlying postgres-js client. Exposed so
   * streaming routes can `client.reserve()` a dedicated pool connection for
   * session-level RLS (the per-request middleware uses a transaction; streams
   * can't hold one open). Set only on the PG storage; `undefined` on SQLite.
   * Typed `unknown` for the same portability reason as `pgDb`; consumer-site
   * casts to `PgClient`.
   */
  pgClient?: unknown;
  /**
   * Dedicated postgres-js client for streaming RLS reservations. On the
   * direct (session-mode) endpoint when one is configured, so streaming's
   * session-level `SET ROLE` never strands on the app's transaction-mode
   * pooled connections; otherwise the same handle as `pgClient`. Set only on
   * PG storage; `undefined` on SQLite. Typed `unknown` for portability;
   * consumer-site casts to `PgClient`.
   */
  pgStreamClient?: unknown;
  runInTransaction<T>(fn: () => T | Promise<T>): Promise<T>;
  /**
   * Hard-delete every artifact tied to the given `auth_user.id`. Single
   * transaction; rollback on any failure. Re-checks inside its own
   * transaction that the account is still `pending_deletion` and
   * `pending_deletion_at < cutoffIso` before proceeding — short-circuits
   * and returns `false` if either is no longer true (e.g. the user clicked
   * cancel between the purger's snapshot and the cascade). On a clean run
   * returns `true`. The PG impl uses `SELECT ... FOR UPDATE` so a
   * concurrent `cancelPendingDeletion` blocks until the cascade either
   * commits or the re-check skips.
   */
  /**
   * Hard-delete a space and every row scoped to it.
   *
   * Top-level for the same reason `deleteAccountCascade` is: it spans
   * every per-space table and needs the store layer for the item purge's
   * search-index cleanup, so it does not sit inside `SpaceStore`.
   *
   * This is the counterpart the cascade cannot serve — a space
   * provisioned by a platform credential has no `auth_user` behind it,
   * and until this existed there was no way to remove one. Conformance
   * creating a space per run is the standing case.
   *
   * Reports rather than throws, so the route maps the outcomes:
   * - `"deleted"` — the space and its rows are gone.
   * - `"not_found"` — no space with that id.
   * - `"has_users"` — refused. The cascade owns the auth island, and
   *   removing the space from under it would strand `users` and
   *   `auth_user`. That case belongs to the account-delete route.
   */
  deleteSpace(spaceId: string): Promise<"deleted" | "not_found" | "has_users">;
  deleteAccountCascade(authUserId: string, cutoffIso: string): Promise<boolean>;
  close(): Promise<void>;
}
