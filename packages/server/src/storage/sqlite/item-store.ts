import { isDeepStrictEqual } from "node:util";
import { safeJsonParse } from "../json-utils.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_LISTING_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "../../page-limits.js";
import { distinctTags } from "../../tag-limits.js";
import {
  eq,
  and,
  or,
  lt,
  gt,
  gte,
  desc,
  asc,
  sql,
  inArray,
  isNotNull,
  notInArray,
  getTableColumns,
  type SQL,
} from "drizzle-orm";
import { softDeleteClock } from "../soft-delete-clock.js";
import {
  itemName,
  markStructuralReadChange,
  generateId,
  isValidId,
  getResolvedFields,
  getTypeSchema,
  ALL_TYPE_IDS,
  isValidTypeIdentifier,
  scheduleIssues,
  validateProperties,
  validateTransition,
  getEdgeTypeSchema,
  softDeleteState,
  parseFilter,
  MarfaError,
  ErrorCode,
  SYSTEM_DEFAULT_STATE,
  GLOBAL_TYPE_WILDCARD,
} from "@withmarfa/shared";
import { resolveMergePolicy, resolveTypeSchema } from "../policy.js";
import {
  inAnswerOrder,
  mergeUpdateProperties,
  resolveIncomingProperties,
} from "../merge-properties.js";
import {
  filterToSqlConditions,
  notSystemTypeSql,
  MISSING_SOURCE,
  sourceColumnSql,
  sourceFilterToSql,
  typeFilterSql,
  typeSubtreeSql,
  typesSql,
} from "../filter-sql.js";
import type { SourceFilterSettings } from "../filter-sql.js";
import type { Edge } from "@withmarfa/shared";
import type {
  ItemSummary,
  TrashDetails,
  TrashSummary,
  ItemSummaryFilters,
  ItemStatsAxis,
  ArchivedItemDates,
  StoredCreateItemInput,
  StoredUpdateItemInput,
} from "../interface.js";
import { instantColumnValues } from "../instant-columns.js";
import type {
  Item,
  AncestorUnavailableResponse,
  ConflictResolutionReport,
  ConflictResponse,
  Tier,
  ItemState,
  PaginatedResult,
  VersionWriter,
} from "@withmarfa/shared";
import type {
  BlobProof,
  CascadeRoot,
  ItemStore,
  ResolvedItem,
  ItemFilters,
  SortDirection,
  CursorSortKey,
  Tombstone,
  TombstoneSelector,
  ViewListing,
} from "../interface.js";
import {
  NaturalKeyHeld,
  encodeKeyedCursor,
  cursorSortKey,
  decodeKeyedCursorNullable,
  normalizeTimeBound,
  parseSortField,
} from "../interface.js";
import {
  buildPropertySortExpr,
  propertySortBound,
  propertySortValue,
} from "../property-sort.js";
import { closedToNewEdge } from "../edge-constraints.js";
import {
  afterCursor,
  beneathSql,
  encodeViewCursor,
  keyValue,
  orderBy,
  viewOrder,
} from "../view-listing.js";
import {
  MAX_STATEMENT_PARAMETERS,
  typeSlices,
  typeSliceSql,
  type TypeSlice,
} from "../type-slices.js";
import {
  ancestorUnavailable,
  attachResolution,
  conflictedSiblingIdFor,
  conflictedSiblingProperties,
  CONFLICTED_COPY_EDGE,
  CONFLICTED_COPY_TAG,
  detectConflict,
  planAutoMerge,
  versionConflict,
} from "../conflict.js";
import type { ItemFieldValues, SnapshotItemFields } from "../conflict.js";
import {
  cascade_marks,
  edges,
  item_links,
  items,
  metadata,
  trash_cascades,
} from "./schema.js";
import type { DrizzleDb } from "./connection.js";
import {
  forgetNaturalKey,
  linkFieldOf,
  readLinkTombstones,
  readNaturalKeyTombstones,
  recordTombstones,
  settleLinkTombstones,
  settleNaturalKeyTombstones,
  syncLink,
} from "./item-links.js";
import {
  blobLending,
  digestsIn,
  edgeBlobLending,
  fileBytes,
  syncBlobReferences,
  syncEdgeBlobReferences,
} from "./blob-references.js";
import { isPrimaryKeyViolation } from "./pk-violation.js";
import { isFileType, stampedFileSize } from "./file-size.js";
import type { SqliteVersionStore } from "./version-store.js";
import type { SqliteSearchStore } from "./search-store.js";
import {
  type ItemRow,
  rowToItem,
  rowWriter,
  writerColumns,
} from "./helpers.js";
import type { WriterColumns } from "./helpers.js";
import * as clock from "../../clock.js";

/**
 * The order of a listing of the bin alone that names no `sort`: when each
 * row went there, newest first unless `direction=asc`. A row an archive
 * restored to the bin without that time stands at its last write, which is
 * no earlier than the move.
 */
const BINNED_ORDER = { kind: "binned" } as const;
// Written as `idx_items_state_binned_at` writes it, which SQLite reads in
// order only for the same expression.
const binnedAt = sql<string>`CASE WHEN ${items.trashed_at} IS NULL THEN ${items.updated_at} ELSE ${items.trashed_at} END`;

function isBinListing(filters: ItemFilters): boolean {
  return (
    filters.sort === undefined &&
    filters.all_states !== true &&
    filters.states?.length === 1 &&
    filters.states[0] === "trashed"
  );
}

// The stored properties column is SQLite's binary JSONB encoding. Every read
// projects it back to JSON text via json() so rowToItem can parse it; every
// write converts through jsonb(). In-place updates elsewhere must use
// jsonb_set — json_set returns text and would silently revert the encoding.
const itemColumns = {
  ...getTableColumns(items),
  properties: sql<string>`json(${items.properties})`.as("properties"),
};

/**
 * Detect a SQLite unique-constraint violation on `idx_items_source_dedup`.
 * The route-layer pre-check catches the common case; this covers the narrow
 * race window between that check and the insert.
 */
function isSourceDedupViolation(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (
    code.includes("SQLITE_CONSTRAINT") &&
    message.includes("idx_items_source_dedup")
  ) {
    return true;
  }
  if (message.includes("idx_items_source_dedup")) return true;
  return false;
}

/** An application grant a person revoked: the row's own `status`, not its
 *  lifecycle `state`, which the revoke leaves alone. */
function isRevokedAppGrantRow(row: Item): boolean {
  return (
    row.type === "system.connection" &&
    row.properties.kind === "app" &&
    row.properties.status === "revoked"
  );
}

type SqliteTx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

/**
 * A file row's `size_bytes` made the server's (`stampedFileSize`), written in
 * the transaction that wrote the row, once its reference index has decided
 * whether `blob_ref` lends. A create passes `arrange` to keep a size it adds
 * where a read answers it (`items/property-order-create`). Answers what the row
 * now holds.
 */
async function keepFileSize(
  tx: SqliteTx,
  row: { id: string; type: string; properties: Record<string, unknown> },
  arrange: (stamped: Record<string, unknown>) => Record<string, unknown> = (
    stamped,
  ) => stamped,
): Promise<Record<string, unknown>> {
  const found = await stampedFileSize(tx, row);
  if (found === undefined) return row.properties;
  const stamped = arrange(found);
  await tx
    .update(items)
    .set({ properties: sql`jsonb(${JSON.stringify(stamped)})` })
    .where(eq(items.id, row.id))
    .run();
  return stamped;
}

function linkRequired(type: string): boolean {
  const field = linkFieldOf(type);
  return (
    field !== undefined && getResolvedFields(type)?.[field]?.required === true
  );
}

/**
 * Writes the keep-both sibling in the caller's transaction.
 *
 * `onConflictDoNothing` rather than a plain insert: the id is derived from the
 * write's idempotency key, so a genuine re-execution of the same write arrives
 * here with the id it used last time. Doing nothing is then correct — the
 * sibling this write is responsible for already exists — where an error would
 * turn a safe retry into a failure and a fresh id would duplicate a
 * "conflicted copy" the person created once.
 *
 * The sibling inherits the original's `source` so it lists beside it, and
 * deliberately does not inherit `source_id` or the link its type names:
 * both are unique, and a copy claiming either is a second row asserting it
 * is the same upstream record.
 *
 * It takes the original's tags and the edges the original's own file writes,
 * so it stays where the original was found; only those a second holder may
 * take, the writer could make, not to the bin, and none that cascade outbound
 * or block a delete, so discarding it touches nothing else.
 *
 * It is linked to the original by a `derived-from` edge, whatever the writer's
 * edge grants: the link is the resolution's, as a cascade is the delete's, and
 * without it nothing finds the copy from the original or the original from the
 * copy once the verdict naming it is gone. None of the original's own
 * `derived-from` edges is copied, so the copy's one edge of that type names
 * its original.
 */
async function insertConflictedSibling(
  tx: SqliteTx,
  searchStore: SqliteSearchStore,
  args: {
    siblingId: string;
    row: { id: string; type: string; source: string | null; tier: string };
    now: string;
    properties: Record<string, unknown>;
    proof: BlobProof;
    refuseUnprovenFile: boolean;
    /** The digests the losing write sent that its base version lacked. */
    carried: ReadonlySet<string>;
    /** The sign-in the losing write came from, which wrote the copy. */
    writer: VersionWriter | null;
    mayCopyEdge?: (
      edgeType: string,
      sourceType: string,
      targetType: string,
    ) => boolean;
  },
): Promise<{ sibling: Item; edges: Edge[] } | null> {
  const { siblingId, row, now, mayCopyEdge } = args;
  const linkField = linkFieldOf(row.type);
  let properties =
    linkField === undefined
      ? args.properties
      : Object.fromEntries(
          Object.entries(args.properties).filter(([key]) => key !== linkField),
        );
  const schemaVersion = getTypeSchema(row.type)?.version ?? 0;
  const inserted = await tx
    .insert(items)
    .values({
      id: siblingId,
      type: row.type,
      state: "active",
      tier: row.tier as "library" | "feed",
      properties: sql`jsonb(${JSON.stringify(properties)})`,
      created_at: now,
      updated_at: now,
      occurred_at: now,
      source: row.source ?? MISSING_SOURCE,
      version: 1,
      schema_version: schemaVersion,
      ...instantColumnValues(properties),
      ...writerColumns(args.writer),
    })
    .onConflictDoNothing()
    .returning({ id: items.id });
  // Already there: the idempotent retry. The run that wrote it did the
  // indexing and the announcing, and doing either again would report a
  // create that did not happen.
  if (inserted.length === 0) return null;
  // The sibling starts from the row's own properties, so a digest it copies
  // lends as it lent there; only one new to it is the losing writer's.
  const inherited = await blobLending(tx, row.id);
  await syncBlobReferences(tx, { id: siblingId, properties }, args.proof, {
    carried: args.carried,
    inherited,
    bytes: args.refuseUnprovenFile
      ? fileBytes(row.type, properties)
      : undefined,
  });
  properties = await keepFileSize(tx, {
    id: siblingId,
    type: row.type,
    properties,
  });

  const [held] = await tx
    .select({ tags: metadata.tags })
    .from(metadata)
    .where(eq(metadata.item_id, row.id))
    .all();
  const tags = [
    ...new Set([
      ...(held
        ? safeJsonParse<string[]>(held.tags, [], "conflicted copy tags")
        : []),
      CONFLICTED_COPY_TAG,
    ]),
  ];
  await tx
    .insert(metadata)
    .values({ item_id: siblingId, tags: JSON.stringify(tags) })
    .onConflictDoNothing()
    .run();

  // Written without the edge checker, as the copies below are: `derived-from`
  // takes any type at either end, and the sibling is new, so the link closes
  // no cycle.
  const derivedFrom = {
    id: generateId(),
    source_id: siblingId,
    target_id: row.id,
    edge_type: CONFLICTED_COPY_EDGE,
    properties: "{}",
    created_at: now,
    updated_at: now,
    version: 1,
  };
  await tx.insert(edges).values(derivedFrom).run();
  const copied: Edge[] = [{ ...derivedFrom, properties: {} }];
  // Copied without the edge checker. The sibling is new, holds no edge but its
  // link, and has the row's type, so a copy satisfies every type constraint
  // the original did, takes only one of a type at an end that holds one, and
  // cannot close a cycle: a cycle through the sibling would need one through
  // the row already.
  const touching = await tx
    .select()
    .from(edges)
    .where(or(eq(edges.source_id, row.id), eq(edges.target_id, row.id)))
    .all();
  for (const edge of touching) {
    const outbound = edge.source_id === row.id;
    const [other] = await tx
      .select({ type: items.type, state: items.state })
      .from(items)
      .where(eq(items.id, outbound ? edge.target_id : edge.source_id))
      .all();
    // An end in the bin, gone, or closed to new edges is one the edge door
    // would refuse.
    if (other === undefined || other.state === "trashed") continue;
    if (outbound && closedToNewEdge(edge.edge_type, other.state)) continue;
    const schema = getEdgeTypeSchema(edge.edge_type);
    if (schema === undefined) continue;
    // An edge no file writes belongs to the end it leaves, as a file's place
    // in a folder does.
    const own = outbound
      ? schema.written_at !== "target"
      : schema.written_at === "target";
    if (!own) continue;
    if (outbound && edge.edge_type === CONFLICTED_COPY_EDGE) continue;
    if (schema.cascade_on_delete === "block") continue;
    if (outbound && schema.cascade_on_delete === "cascade") continue;
    const sourceType = outbound ? row.type : other.type;
    const targetType = outbound ? other.type : row.type;
    if (mayCopyEdge?.(edge.edge_type, sourceType, targetType) !== true) {
      continue;
    }
    const allowed = outbound
      ? schema.cardinality === "many-to-one" ||
        schema.cardinality === "many-to-many"
      : schema.cardinality === "one-to-many" ||
        schema.cardinality === "many-to-many";
    if (!allowed) continue;
    const copy = {
      id: generateId(),
      source_id: outbound ? siblingId : edge.source_id,
      target_id: outbound ? edge.target_id : siblingId,
      edge_type: edge.edge_type,
      properties: edge.properties,
      created_at: now,
      updated_at: now,
      version: 1,
    };
    await tx.insert(edges).values(copy).run();
    const copiedProperties = safeJsonParse<Record<string, unknown>>(
      copy.properties,
      {},
      "conflicted copy edge properties",
    );
    // A digest the copy carries lends as it lent on the edge it was copied
    // from.
    await syncEdgeBlobReferences(
      tx,
      { id: copy.id, properties: copiedProperties },
      null,
      { inherited: await edgeBlobLending(tx, edge.id) },
    );
    copied.push({ ...copy, properties: copiedProperties });
  }

  // Everything `create()` does, because this row is a create: unindexed, the
  // sibling is missed by the search people use to look for a conflicted copy.
  await searchStore.index(siblingId, properties, row.type);

  return {
    sibling: {
      id: siblingId,
      type: row.type,
      state: "active",
      tier: row.tier as Tier,
      properties,
      created_at: now,
      updated_at: now,
      occurred_at: now,
      version: 1,
      schema_version: schemaVersion,
      source: row.source ?? MISSING_SOURCE,
      trashed_at: null,
    } satisfies Item,
    edges: copied,
  };
}

/**
 * The WHERE terms a listing's filters compile to, cursor aside.
 *
 * One builder for the listing and the counts, so a count asked with a
 * listing's filters is the number of rows that listing would walk.
 *
 * `ordered` is for a read that walks the rows in a sort order. `typeSliced`
 * is for a read that applies the `type` filter itself, one slice at a time
 * (`typeSlices`), so the filter's own term is left out.
 */
function itemFilterConditions(
  filters: ItemFilters,
  { ordered = false, typeSliced = false } = {},
): SQL[] {
  // Every bound is re-spelled to the shape the stored columns carry
  // before it reaches a comparison: they are text columns and the
  // comparison is lexical, so a valid RFC 3339 instant at the wrong
  // width silently answers a different question. See
  // `normalizeTimeBound`.
  const updatedAfter = normalizeTimeBound(
    filters.updated_after,
    "updated_after",
  );
  const occurredAfter = normalizeTimeBound(
    filters.occurred_after,
    "occurred_after",
  );
  const occurredBefore = normalizeTimeBound(
    filters.occurred_before,
    "occurred_before",
  );
  const updatedBefore = normalizeTimeBound(
    filters.updated_before,
    "updated_before",
  );

  const conditions: SQL[] = [];

  // `core.entity` and `core.entity.*` mean the same thing: the type and
  // everything under it. A bare identifier has always included its
  // subtypes here, so the explicit wildcard must too.
  const typeClause = typesSql(items.type, filters.types);

  // Without statistics, SQLite can choose the state index even when most
  // rows are active. Steer typed active reads to the type index, but leave
  // other states eligible for the state index so selective reads stay cheap.
  const narrowsByType =
    typeClause !== undefined ||
    (filters.allowed_types !== undefined &&
      filters.allowed_types.length > 0 &&
      !filters.allowed_types.includes(GLOBAL_TYPE_WILDCARD));
  // An ordered read of the active state never wants the state index either:
  // it holds nearly every item, and walking it leaves a sort of all of them,
  // where the sort column's index would stop at the page.
  // A list that holds `active` is just as broad, so it is steered the same
  // way; the unary `+` keeps the term off the state index.
  const steerOff = (values: readonly string[]): boolean =>
    (narrowsByType || ordered) && values.includes("active");
  const stateIs = (value: string): SQL =>
    steerOff([value])
      ? sql`+${items.state} = ${value}`
      : eq(items.state, value);
  const stateIn = (values: readonly string[]): SQL =>
    steerOff(values)
      ? sql`+${items.state} IN (${sql.join(
          values.map((value) => sql`${value}`),
          sql`, `,
        )})`
      : inArray(items.state, [...values]);

  const states = filters.states;
  if (states !== undefined) {
    // An empty list names no state, so it matches no row; the doors refuse
    // one before it gets here.
    conditions.push(
      states.length === 1
        ? stateIs(states[0] as string)
        : states.length === 0
          ? sql`0`
          : stateIn(states),
    );
  } else if (!filters.all_states) {
    // The default is the active state. A listing answers what the reader
    // is working with, and archived, trashed and revoked are all rows
    // they put away. It is also the narrower of the two masks this door
    // could carry, which is what a caller who named nothing should get:
    // `revoked` is reachable only on a reserved type, and a default that
    // let it through published platform rows to an ordinary query.
    //
    // `all_states` suppresses the narrowing and adds nothing else: a
    // catch-up has to see a row leave the active state, because that
    // transition is how a client learns to prune its local copy, and a
    // listing that moves the modification time and then hides the row
    // reports that nothing changed.
    const excluded = filters.exclude_states;
    if (excluded && excluded.length > 0) {
      conditions.push(notInArray(items.state, [...excluded]));
    } else {
      conditions.push(stateIs("active"));
    }
  }

  if (typeClause && !typeSliced) conditions.push(typeClause);

  if (filters.source) {
    conditions.push(sql`${sourceColumnSql(items.source)} = ${filters.source}`);
  }

  if (filters.tier !== undefined) {
    conditions.push(eq(items.tier, filters.tier));
  }

  if (filters.exclude_system_types) {
    conditions.push(notSystemTypeSql(items.type));
  }

  if (occurredAfter !== undefined) {
    conditions.push(
      sql`COALESCE(${items.occurred_at}, ${items.created_at}) > ${occurredAfter}`,
    );
  }
  if (occurredBefore !== undefined) {
    conditions.push(
      sql`COALESCE(${items.occurred_at}, ${items.created_at}) < ${occurredBefore}`,
    );
  }
  // The one bound that stays inclusive. `updated_at` ties across a bulk
  // write, so a strict comparison drops every row sharing the cursor's
  // instant and a resuming client never learns they existed.
  if (updatedAfter !== undefined) {
    conditions.push(gte(items.updated_at, updatedAfter));
  }
  if (updatedBefore !== undefined) {
    conditions.push(lt(items.updated_at, updatedBefore));
  }

  // The normalized instant columns compare as text because they are
  // written in one fixed-width shape. Two disjuncts rather than one
  // `starts_at < to AND ends_at > from`, so each is a range over its own
  // index instead of the whole calendar's history.
  if (filters.spanOverlaps !== undefined) {
    const { from, to } = filters.spanOverlaps;
    conditions.push(
      sql`((${items.starts_at} >= ${from} AND ${items.starts_at} < ${to}) OR (${items.ends_at} > ${from} AND ${items.starts_at} < ${from}))`,
    );
  }

  if (filters.hasProperty !== undefined) {
    // The JSON path is assembled in JS and bound as a parameter, so a
    // caller-supplied key never reaches the statement text.
    conditions.push(
      sql`json_extract(${items.properties}, ${`$."${filters.hasProperty}"`}) IS NOT NULL`,
    );
  }

  if (filters.tags && filters.tags.length > 0) {
    for (const tag of filters.tags) {
      conditions.push(
        sql`EXISTS (
            SELECT 1 FROM metadata m, json_each(m.tags) je
            WHERE m.item_id = ${items.id} AND je.value = ${tag}
          )`,
      );
    }
  }

  const readable = typeFilterSql(items.type, {
    allowed: filters.allowed_types,
    excluded: filters.excluded_types ?? [],
  });
  if (readable) conditions.push(readable);

  const sourceLever = sourceFilterToSql(
    filters.source_filter,
    items.type,
    items.source,
  );
  if (sourceLever) conditions.push(sourceLever);

  if (filters.filter) {
    const expr = parseFilter(filters.filter);
    const filterConds = filterToSqlConditions(expr, items, {
      types: filters.readable_sources,
      source_filter: filters.source_filter,
    });
    if (expr.logical === "OR") {
      const orClause = or(...filterConds);
      if (orClause) conditions.push(orClause);
    } else {
      conditions.push(...filterConds);
    }
  }

  return conditions;
}

function withoutKeys(
  properties: Record<string, unknown>,
  keys: readonly string[] | undefined,
): Record<string, unknown> {
  if (keys === undefined) return properties;
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => !keys.includes(key)),
  );
}

/**
 * The properties a write stores: each value as validation answers it (a `url`
 * trimmed, `types/url-stored`), in the order the write found them
 * (`items/property-order-merge`). Validation answers the type's fields first,
 * so its order is not the row's. A property validation does not answer stays
 * as it was, and so does one it answers with nothing, which is a stored
 * `null` on an optional field: an update that does not touch it keeps it.
 */
function storedAsValidated(
  result: Record<string, unknown>,
  validated: Record<string, unknown>,
): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  for (const key of Object.keys(result)) {
    const answered = Object.hasOwn(validated, key) ? validated[key] : undefined;
    const value = answered === undefined ? result[key] : answered;
    if (value !== undefined)
      Object.defineProperty(stored, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return stored;
}

/**
 * What a write leaves the row holding, judged against the type the row ends
 * up as, at the current version and a stale one alike. Judged only where the
 * write carries properties or a move: a type may gain a required field while
 * rows that lack it stand, and a write that changes nothing a schema has an
 * opinion about is not the write that has to satisfy it. A status word is
 * judged where the write changes it or moves the row, so a word the type no
 * longer declares stands through a write that sends it back unchanged.
 */
function judgeResult(
  input: StoredUpdateItemInput,
  rowType: string,
  current: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (
    input.properties === undefined &&
    input.clear_properties === undefined &&
    input.type === undefined
  ) {
    return result;
  }
  const resultingType = input.type ?? rowType;
  const fields = input.prune_undeclared_properties
    ? getTypeSchema(resultingType)?.fields
    : undefined;
  if (fields !== undefined) {
    result = Object.fromEntries(
      Object.entries(result).filter(([key]) => Object.hasOwn(fields, key)),
    );
  }
  const written =
    resultingType === rowType
      ? Object.fromEntries(
          Object.entries(result).filter(
            ([key, value]) => !isDeepStrictEqual(value, current[key]),
          ),
        )
      : result;
  const validation = validateProperties(resultingType, result, { written });
  if (validation.success) return storedAsValidated(result, validation.data);
  const detail = validation.errors
    .map((e) => `${e.field}: ${e.message}`)
    .join("; ");
  throw new MarfaError(
    ErrorCode.INVALID_PROPERTIES,
    resultingType !== rowType
      ? `Cannot move item to "${resultingType}": ${detail}`
      : `Invalid properties: ${detail}`,
    { errors: validation.errors },
  );
}

/**
 * What a create refuses before it reads the database: a malformed id or
 * `occurred_at`, a type the registry does not hold, and properties that type
 * does not take. Answers the properties as validation coerced them.
 */
function creatableItem(
  input: Pick<
    StoredCreateItemInput,
    "id" | "type" | "properties" | "occurred_at"
  >,
): { occurred_at?: string; properties: Record<string, unknown> } {
  const occurredAt =
    input.occurred_at === undefined
      ? undefined
      : normalizeTimeBound(input.occurred_at, "occurred_at");
  if (input.id && !isValidId(input.id)) {
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
  }

  // Every item must carry a registered type. An unregistered identifier has
  // no schema to validate against, so accepting it would let typo'd or
  // ad-hoc types persist with zero conformance checking — the opposite of a
  // typed data layer's promise. Reject before any write. Custom types are
  // loaded into the registry at startup and on `POST /types`, so a legitimate
  // custom type resolves here.
  const typeSchema = getTypeSchema(input.type);
  if (!typeSchema) {
    throw new MarfaError(
      ErrorCode.UNKNOWN_TYPE,
      `Unknown type: ${input.type}. Register it via POST /types before creating items of this type.`,
      { type: input.type },
    );
  }
  // Validate properties against the type schema. Runs unconditionally —
  // an empty `{}` must still fail required-field checks (a core.task with
  // no title is invalid whether properties is empty or partially filled).
  // Persist the validated (coerced) properties so `null` on an optional
  // field — which validation treats as "unset" — drops out before the write
  // rather than landing as a stored null.
  const validation = validateProperties(input.type, input.properties);
  if (!validation.success) {
    // The specific code, not the generic one. A durable client's failure
    // classification is closed and keys on it: a schema refusal is
    // permanent, and a code the client does not recognize falls through
    // to transient and retries forever. The update, retype and
    // strict-mode paths answer `invalid_properties` for the identical
    // failure, and one failure cannot have two names and still be
    // classified.
    throw new MarfaError(ErrorCode.INVALID_PROPERTIES, "Invalid properties", {
      errors: validation.errors,
    });
  }
  return {
    ...(occurredAt !== undefined && { occurred_at: occurredAt }),
    properties: validation.data,
  };
}

/**
 * Whether a restore holds a row of `type` to the shape the type has: only a
 * `core` or `system` type this build ships, which the server's own code reads
 * and nothing can delete or replace. A platform type the build no longer ships
 * is not held, though the instance may still carry its row in the registry:
 * its items are taken as archived like any other.
 */
function restoreHoldsShape(type: string): boolean {
  return (ALL_TYPE_IDS as readonly string[]).includes(type);
}

/**
 * What a restore refuses of an item line before it reads the database: a type
 * that is no identifier and properties that are no object. A row of a `core`
 * or `system` type this build ships is then judged as a create is. Any other
 * row is refused only a malformed id or `occurred_at` and an event's schedule
 * or a task's `recurrence` that no read can unfold. Its properties come back as the archive holds
 * them, whatever shape its type has now and whether or not the type is
 * registered, even as a platform row the build retired, because a type may
 * gain a required field or be force-deleted while its rows stand
 * (`search-and-filters/restore-rows-shape-free`).
 */
export function restoredItem(
  input: Pick<
    StoredCreateItemInput,
    "id" | "type" | "properties" | "occurred_at"
  >,
): { occurred_at?: string; properties: Record<string, unknown> } {
  const named = `item ${String(input.id)}`;
  if (typeof input.type !== "string" || !isValidTypeIdentifier(input.type)) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid ${named}: type must be a type identifier`,
      { type: input.type },
    );
  }
  const properties: unknown = input.properties;
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties)
  ) {
    throw new MarfaError(
      ErrorCode.INVALID_PROPERTIES,
      `Invalid ${named}: properties must be an object`,
      { errors: [{ field: "_root", message: "Expected an object" }] },
    );
  }
  if (restoreHoldsShape(input.type)) return creatableItem(input);
  const occurredAt =
    input.occurred_at === undefined
      ? undefined
      : normalizeTimeBound(input.occurred_at, "occurred_at");
  if (input.id && !isValidId(input.id)) {
    throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
  }
  const errors = scheduleIssues(input.type, input.properties);
  if (errors.length > 0) {
    throw new MarfaError(ErrorCode.INVALID_PROPERTIES, "Invalid properties", {
      errors,
    });
  }
  return {
    ...(occurredAt !== undefined && { occurred_at: occurredAt }),
    properties: input.properties,
  };
}

export class SqliteItemStore implements ItemStore {
  constructor(
    private db: DrizzleDb,
    private versionStore: SqliteVersionStore,
    private searchStore: SqliteSearchStore,
  ) {}

  async restoreDates(id: string, dates: ArchivedItemDates): Promise<void> {
    if (
      dates.created_at === undefined &&
      dates.updated_at === undefined &&
      dates.restored_at === undefined &&
      dates.trashed_at === undefined &&
      dates.trashed_by === undefined
    )
      return;
    await this.db.update(items).set(dates).where(eq(items.id, id)).run();
  }

  async create(input: StoredCreateItemInput): Promise<Item> {
    const { occurred_at: occurredAt, properties: validated } =
      input.as_archived === true ? restoredItem(input) : creatableItem(input);
    if (occurredAt !== undefined) input = { ...input, occurred_at: occurredAt };
    const id = input.id ?? generateId();
    const declared = Object.keys(
      resolveTypeSchema(input.type, (typeId) => getTypeSchema(typeId))
        ?.fields ?? {},
    );
    let properties = inAnswerOrder(declared, validated, input.properties);

    const now = clock.now().toISOString();
    const state = input.state ?? SYSTEM_DEFAULT_STATE;

    return await this.db.transaction(async (tx) => {
      if (input.source && input.source_id) {
        const dedupConditions = [
          eq(items.source, input.source),
          eq(items.source_id, input.source_id),
        ];
        const existing = await tx
          .select({ id: items.id })
          .from(items)
          .where(and(...dedupConditions))
          .get();
        if (existing) {
          throw new NaturalKeyHeld(input.source, input.source_id, existing.id);
        }
      }

      // Asked again here, inside the write lock, because a type deleted
      // since the check above leaves the registry before its delete commits,
      // and a row written now would name a type nothing holds.
      const current = getTypeSchema(input.type);
      if (!current && input.as_archived !== true) {
        throw new MarfaError(
          ErrorCode.UNKNOWN_TYPE,
          `Unknown type: ${input.type}. Register it via POST /types before creating items of this type.`,
          { type: input.type },
        );
      }
      // A restore keeps the version the archive holds; without one, an
      // unregistered type has none to stamp.
      const schemaVersion =
        (input.as_archived === true ? input.schema_version : undefined) ??
        current?.version ??
        0;

      try {
        await tx
          .insert(items)
          .values({
            id,
            type: input.type,
            state,
            // A create can name its own state, and an archive restore names
            // `trashed` for a row that was in the bin when the archive was
            // taken. Stamped here so such a row's retention window starts
            // where every other trashed row's does.
            ...softDeleteClock(input.type, SYSTEM_DEFAULT_STATE, state, now),
            trashed_by:
              state === softDeleteState(input.type) && !input.as_archived
                ? (input.writer ?? null)
                : null,
            tier: input.tier ?? "library",
            properties: sql`jsonb(${JSON.stringify(properties)})`,
            created_at: now,
            updated_at: now,
            occurred_at: input.occurred_at ?? now,
            source: input.source ?? MISSING_SOURCE,
            source_id: input.source_id,
            // A restore recreates a row under its archived id, so it also
            // carries the version that id had reached. Every other create
            // starts at 1.
            version: input.version ?? 1,
            schema_version: schemaVersion,
            capture_latitude: input.capture_latitude,
            capture_longitude: input.capture_longitude,
            // Ordinary text columns beside the JSONB blob, not part of it.
            ...instantColumnValues(properties),
            ...writerColumns(input.writer ?? null),
          })
          .run();
      } catch (err) {
        if (isPrimaryKeyViolation(err, "items")) {
          throw new MarfaError(
            ErrorCode.CONFLICT,
            `Item with id=${id} already exists`,
            { existing_id: id },
          );
        }
        throw err;
      }

      await tx
        .insert(metadata)
        .values({
          item_id: id,
          tags: JSON.stringify(distinctTags(input.tags ?? [])),
        })
        .run();

      await syncLink(tx, { id, type: input.type, properties });
      await syncBlobReferences(
        tx,
        { id, properties },
        input.blob_proof ?? null,
        input.refuse_unproven_file === true
          ? { bytes: fileBytes(input.type, properties) }
          : {},
      );
      properties = await keepFileSize(
        tx,
        { id, type: input.type, properties },
        (stamped) => inAnswerOrder(declared, stamped, input.properties),
      );
      if (input.source && input.source_id) {
        await forgetNaturalKey(tx, input.source, input.source_id);
      }

      // **A row born in the bin is not indexed**, the same rule `transition`
      // applies on the way in (`search-and-filters/search-bin`): a trashed row
      // leaves the index rather than being narrowed out of the query, so it
      // is unmatched under `state=any` and under `state=trashed` alike.
      //
      // A create can name its own state, and a restore from an archive passes
      // the archived row's state straight through, so both doors can put a
      // trashed row here. Indexing it made `state=any` answer a row the rule
      // says no search reaches — and the device half was written against the
      // rule rather than against this, so the two disagreed.
      if (state !== "trashed") {
        await this.searchStore.index(id, properties, input.type);
      }

      return {
        id,
        type: input.type,
        state: state,
        tier: input.tier ?? "library",
        properties,
        created_at: now,
        updated_at: now,
        occurred_at: input.occurred_at ?? now,
        version: input.version ?? 1,
        schema_version: schemaVersion,
        source: input.source ?? MISSING_SOURCE,
        ...(input.source_id != null && { source_id: input.source_id }),
        ...(input.capture_latitude != null && {
          capture_latitude: input.capture_latitude,
        }),
        ...(input.capture_longitude != null && {
          capture_longitude: input.capture_longitude,
        }),
        trashed_at: state === softDeleteState(input.type) ? now : null,
      } satisfies Item;
    });
  }

  async get(id: string): Promise<Item | null> {
    const row = await this.db
      .select(itemColumns)
      .from(items)
      .where(eq(items.id, id))
      .get();
    if (!row) return null;
    if (row.state === "trashed") return null;
    return rowToItem(row);
  }

  async writersAt(
    rows: readonly { id: string; version: number }[],
  ): Promise<Map<string, VersionWriter | null>> {
    const found = new Map<string, VersionWriter | null>();
    if (rows.length === 0) return found;
    const wanted = JSON.stringify(rows.map((row) => [row.id, row.version]));
    const read = await this.db.all<WriterColumns & { id: string }>(sql`
      WITH wanted(id, version) AS (
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
        FROM json_each(${wanted})
      )
      SELECT items.id AS id, items.writer_kind AS writer_kind,
        items.writer_id AS writer_id, items.writer_name AS writer_name
      FROM items JOIN wanted
        ON items.id = wanted.id AND items.version = wanted.version
      UNION ALL
      SELECT versions.item_id, versions.writer_kind, versions.writer_id,
        versions.writer_name
      FROM versions JOIN wanted
        ON versions.item_id = wanted.id AND versions.version = wanted.version
    `);
    for (const row of read) found.set(row.id, rowWriter(row));
    return found;
  }

  // Internal get that includes trashed items (for restore, delete, transition)
  private async getRaw(id: string): Promise<Item | null> {
    const row = await this.db
      .select(itemColumns)
      .from(items)
      .where(eq(items.id, id))
      .get();
    if (!row) return null;
    return rowToItem(row);
  }

  getIncludingTrashed(id: string): Promise<Item | null> {
    return this.getRaw(id);
  }

  async findBySourceId(source: string, sourceId: string): Promise<Item | null> {
    const conditions = [
      eq(items.source, source),
      eq(items.source_id, sourceId),
    ];
    const row = await this.db
      .select(itemColumns)
      .from(items)
      .where(and(...conditions))
      .get();
    if (!row) return null;
    return rowToItem(row);
  }

  async findByLinks(
    type: string,
    values: readonly string[],
  ): Promise<Map<string, Item>> {
    const out = new Map<string, Item>();
    if (values.length === 0) return out;
    const rows = await this.db
      .select({ ...itemColumns, link: item_links.value })
      .from(items)
      .innerJoin(item_links, eq(item_links.item_id, items.id))
      .where(
        and(eq(item_links.type, type), inArray(item_links.value, [...values])),
      )
      .all();
    for (const { link, ...row } of rows) out.set(link, rowToItem(row));
    return out;
  }

  async findBySourceIds(
    source: string,
    sourceIds: readonly string[],
  ): Promise<Map<string, Item>> {
    const out = new Map<string, Item>();
    if (sourceIds.length === 0) return out;
    const rows = await this.db
      .select(itemColumns)
      .from(items)
      .where(
        and(eq(items.source, source), inArray(items.source_id, [...sourceIds])),
      )
      .all();
    for (const row of rows) {
      if (row.source_id !== null) out.set(row.source_id, rowToItem(row));
    }
    return out;
  }

  tombstones(type: string, selector: TombstoneSelector): Promise<Tombstone[]> {
    return "links" in selector
      ? readLinkTombstones(this.db, type, selector.links)
      : readNaturalKeyTombstones(
          this.db,
          type,
          selector.source,
          selector.source_ids,
        );
  }

  settleTombstones(
    type: string,
    selector: TombstoneSelector,
    settledAt: string,
  ): Promise<Tombstone[]> {
    return "links" in selector
      ? settleLinkTombstones(this.db, type, selector.links, settledAt)
      : settleNaturalKeyTombstones(
          this.db,
          type,
          selector.source,
          selector.source_ids,
          settledAt,
        );
  }

  private async keepKeysInStep(
    tx: SqliteTx,
    after: { id: string; type: string; properties: Record<string, unknown> },
    before: { type: string; source: string | null; source_id: string | null },
    sourceId: string | undefined,
    proof: BlobProof,
    carried: ReadonlySet<string>,
    refuseUnprovenFile: boolean,
  ): Promise<void> {
    await syncLink(tx, after, before.type);
    await syncBlobReferences(tx, after, proof, {
      carried,
      bytes: refuseUnprovenFile
        ? fileBytes(after.type, after.properties)
        : undefined,
    });
    if (before.source && sourceId && sourceId !== before.source_id) {
      await forgetNaturalKey(tx, before.source, sourceId);
    }
  }

  async getMany(
    ids: string[],
    opts?: { includeTrashed?: boolean; source_filter?: SourceFilterSettings },
  ): Promise<Map<string, Item>> {
    const out = new Map<string, Item>();
    if (ids.length === 0) return out;
    const unique = Array.from(new Set(ids));
    // The bulk cap exceeds SQLite's parameter limit; source terms also bind parameters.
    for (let offset = 0; offset < unique.length; offset += 500) {
      const where = and(
        inArray(items.id, unique.slice(offset, offset + 500)),
        sourceFilterToSql(opts?.source_filter, items.type, items.source),
      );
      const rows = await this.db
        .select(itemColumns)
        .from(items)
        .where(where)
        .all();
      for (const row of rows) {
        if (row.state === "trashed" && opts?.includeTrashed !== true) continue;
        out.set(row.id, rowToItem(row));
      }
    }
    return out;
  }

  async cascadeMarks(ids: string[]): Promise<Map<string, CascadeRoot>> {
    const out = new Map<string, CascadeRoot>();
    if (ids.length === 0) return out;
    const rows = await this.db
      .select()
      .from(cascade_marks)
      .where(inArray(cascade_marks.item_id, Array.from(new Set(ids))))
      .all();
    for (const row of rows) {
      out.set(row.item_id, {
        id: row.trashed_with,
        type: row.trashed_with_type,
      });
    }
    return out;
  }

  async trashDetailsOf(
    ids: readonly string[],
  ): Promise<Map<string, TrashDetails>> {
    const out = new Map<string, TrashDetails>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const rows = await this.db
        .select({
          id: items.id,
          trashed_at: items.trashed_at,
          trashed_by: items.trashed_by,
        })
        .from(items)
        .where(inArray(items.id, ids.slice(offset, offset + 500)))
        .all();
      for (const { id, ...details } of rows) out.set(id, details);
    }
    return out;
  }

  async listTrashSummaries(
    filters: ItemSummaryFilters,
  ): Promise<PaginatedResult<TrashSummary>> {
    const page = await this.listSummaries({ ...filters, state: "trashed" });
    const details = await this.trashDetailsOf(page.data.map((row) => row.id));
    return {
      ...page,
      data: page.data.map((row) => ({
        ...row,
        ...(details.get(row.id) ?? { trashed_at: null, trashed_by: null }),
      })),
    };
  }

  async listSummaries(
    filters: ItemSummaryFilters,
  ): Promise<PaginatedResult<ItemSummary>> {
    const limit = Math.max(
      MIN_PAGE_LIMIT,
      Math.min(filters.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    );
    const query = (filters.q ?? "").trim().toLowerCase();
    const offset = filters.offset ?? 0;
    let skipMatches = query ? offset : 0;
    const batchSize = query ? MAX_PAGE_LIMIT : limit + 1;
    const key = `item-summaries:${JSON.stringify([filters.type ?? null, query, filters.state ?? null])}`;
    let after = filters.cursor
      ? decodeKeyedCursorNullable(filters.cursor, key)
      : undefined;
    if (after?.v === null)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid summary cursor",
      );
    const conditions = itemFilterConditions({
      ...(filters.state
        ? { states: [filters.state] }
        : { exclude_states: ["trashed" as const] }),
      exclude_system_types: true,
      source_filter: filters.source_filter,
    });
    if (filters.type !== undefined)
      conditions.push(eq(items.type, filters.type));
    const data: ItemSummary[] = [];
    const hints = new Map<string, ReturnType<typeof resolveTypeSchema>>();
    // Search skips matching names in one bounded scan. Unfiltered pages skip
    // in SQL so late console pages never replay earlier pages or their names.
    for (;;) {
      const bound = after
        ? or(
            lt(items.created_at, String(after.v)),
            and(eq(items.created_at, String(after.v)), lt(items.id, after.id)),
          )
        : undefined;
      const rows = await this.db
        .select({
          id: items.id,
          type: items.type,
          version: items.version,
          source: items.source,
          created_at: items.created_at,
          properties: sql<string>`json(${items.properties})`,
        })
        .from(items)
        .where(and(...conditions, bound))
        .orderBy(desc(items.created_at), desc(items.id))
        .limit(batchSize)
        .offset(query ? 0 : offset)
        .all();
      for (const row of rows) {
        if (!hints.has(row.type))
          hints.set(row.type, resolveTypeSchema(row.type, getTypeSchema));
        const name = itemName(
          safeJsonParse<Record<string, unknown>>(
            row.properties,
            {},
            "item summary",
          ),
          hints.get(row.type)?.display_hints,
        );
        if (!name.toLowerCase().includes(query)) continue;
        if (skipMatches > 0) {
          skipMatches--;
          continue;
        }
        if (data.length === limit) {
          const last = data.at(-1);
          if (!last) throw new Error("Missing summary page boundary");
          return {
            data,
            next_cursor: encodeKeyedCursor(last.created_at, last.id, key),
          };
        }
        data.push({
          id: row.id,
          type: row.type,
          version: row.version,
          name,
          source: row.source ?? MISSING_SOURCE,
          created_at: row.created_at,
        });
      }
      if (rows.length < batchSize) return { data, next_cursor: null };
      const last = rows.at(-1);
      if (!last) throw new Error("Missing summary scan boundary");
      after = { v: last.created_at, id: last.id };
    }
  }

  async list(filters: ItemFilters): Promise<PaginatedResult<Item>> {
    // A catch-up read owns its own ordering. `updated_after` is only
    // resumable over `(updated_at, id)` ascending — that is the order the
    // cursor walks and the order the index is built for — so the filter
    // implies it here rather than trusting every caller to ask for it.
    // The route refuses a request that asks for both this filter and a
    // contradicting sort, so the override below is never a caller's
    // explicit choice being discarded; holding the invariant in the store
    // as well is what makes it true for internal callers too.
    const updatedAfter = normalizeTimeBound(
      filters.updated_after,
      "updated_after",
    );

    // One test of the field decides both the ordering and the bound. Two
    // tests would let an empty value order by `(updated_at, id)` ascending
    // and bound nothing, so a request that asked for a narrow catch-up
    // would walk the whole corpus instead.
    const catchUp = updatedAfter !== undefined;
    const sort = catchUp
      ? ({ kind: "system", column: "updated_at" } as const)
      : isBinListing(filters)
        ? BINNED_ORDER
        : parseSortField(filters.sort);
    const dir: SortDirection = catchUp ? "asc" : (filters.direction ?? "desc");
    // The cursor records the ordering that issued it — column and
    // direction, taken from the resolved values above rather than from
    // the raw parameters. Every ordering this listing offers compares
    // ISO timestamps or a JSON-extracted value, so the wrong one compares
    // cleanly and returns a page that is simply not the next page.
    const cursorKey: CursorSortKey = cursorSortKey("items", sort, dir);
    const limit = Math.max(
      MIN_PAGE_LIMIT,
      Math.min(filters.limit ?? DEFAULT_PAGE_LIMIT, MAX_LISTING_LIMIT),
    );

    // For a property sort, the ORDER BY / cursor comparison runs against a
    // JSON-extracted expression rather than a column. NULLS LAST is applied in
    // both directions, with `id` as a stable ascending tiebreak.
    const propertySort =
      sort.kind === "property"
        ? buildPropertySortExpr(items.properties, sort.field)
        : null;

    // A listing in a system order reads each slice of the type predicate in
    // that order and merges the slices, so a page reads about its own rows.
    const slices =
      sort.kind === "system"
        ? typeSlices({
            types: filters.types,
            allowed_types: filters.allowed_types,
          })
        : undefined;
    const cursorConditions: (SQL | undefined)[] = [];

    const systemSortCol =
      sort.kind === "system"
        ? sort.column === "updated_at"
          ? items.updated_at
          : sort.column === "occurred_at"
            ? items.occurred_at
            : items.created_at
        : sort.kind === "binned"
          ? binnedAt
          : null;

    if (filters.cursor) {
      const { v, id } = decodeKeyedCursorNullable(filters.cursor, cursorKey);
      if (propertySort) {
        // Keyset over a nullable, NULLS-LAST expression. `id` is an ascending
        // tiebreak in both directions, so the page boundary is a total order.
        const e = propertySort;
        if (v === null) {
          // Already in the trailing NULL block — only later NULL rows remain.
          cursorConditions.push(and(sql`${e} IS NULL`, gt(items.id, id)));
        } else {
          const bound = propertySortBound(v);
          const valueCmp =
            dir === "desc" ? sql`${e} < ${bound}` : sql`${e} > ${bound}`;
          const clause = or(
            valueCmp,
            and(sql`${e} = ${bound}`, gt(items.id, id)),
            sql`${e} IS NULL`,
          );
          if (clause) cursorConditions.push(clause);
        }
      } else if (systemSortCol && v !== null) {
        // System columns are NOT NULL, and so is `binnedAt`, so the cursor
        // value is always present.
        // One row-value comparison rather than its expansion into `OR`: an
        // index on the column and `id` answers it as a single range, where
        // the expansion is a range on the column and a test of every row in it.
        cursorConditions.push(
          dir === "desc"
            ? sql`(${systemSortCol}, ${items.id}) < (${v}, ${id})`
            : sql`(${systemSortCol}, ${items.id}) > (${v}, ${id})`,
        );
      }
    }

    let orderBy;
    if (propertySort) {
      const e = propertySort;
      // `(e IS NULL)` is 0 for present values, 1 for NULL — ordering it ascending
      // first pushes NULLs to the end regardless of the value direction.
      const valueOrder = dir === "desc" ? desc(e) : asc(e);
      orderBy = [sql`${e} IS NULL`, valueOrder, asc(items.id)];
    } else {
      const col = systemSortCol ?? items.created_at;
      orderBy =
        dir === "desc"
          ? [desc(col), desc(items.id)]
          : [asc(col), asc(items.id)];
    }

    // Every slice repeats the filters' parameters, and a statement binds
    // only so many, whatever the filters hold (tags, a type map in each
    // `backref` term, grants). The count is read from the statement itself,
    // and a listing that would pass the limit is read as one range and sorted.
    const statementOf = (sliced: TypeSlice[] | undefined) => {
      const where = [
        ...itemFilterConditions(filters, {
          ordered: sort.kind === "system",
          typeSliced: sliced !== undefined,
        }),
        ...cursorConditions,
      ];
      const read = (slice?: TypeSlice) =>
        this.db
          .select(itemColumns)
          .from(items)
          .where(and(...where, slice && typeSliceSql(items.type, slice)))
          .$dynamic();
      let merged = read(sliced?.[0]);
      for (const slice of sliced?.slice(1) ?? [])
        merged = merged.unionAll(read(slice));
      return merged.orderBy(...orderBy).limit(limit + 1);
    };
    let statement = statementOf(slices);
    if (
      slices !== undefined &&
      statement.toSQL().params.length > MAX_STATEMENT_PARAMETERS
    )
      statement = statementOf(undefined);
    const rows = await statement.all();

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(rowToItem);
    let cursor: string | null = null;

    if (hasMore) {
      const last = data.at(-1);
      if (!last) throw new Error("unreachable: hasMore but data is empty");
      const sortValue =
        sort.kind === "property"
          ? propertySortValue(last.properties, sort)
          : sort.kind === "binned"
            ? (last.trashed_at ?? last.updated_at)
            : sort.column === "updated_at"
              ? last.updated_at
              : sort.column === "occurred_at"
                ? last.occurred_at
                : last.created_at;
      cursor = encodeKeyedCursor(sortValue, last.id, cursorKey);
    }

    return { data, next_cursor: cursor };
  }

  async listInView(
    view: ViewListing,
    page: { limit?: number; cursor?: string },
  ): Promise<PaginatedResult<Item>> {
    const { query, reader } = view;
    const limit = Math.max(
      MIN_PAGE_LIMIT,
      Math.min(page.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    );
    const order = viewOrder(view.sort);
    const conditions = itemFilterConditions({
      ...reader,
      all_states: true,
      exclude_system_types: true,
      filter: query.filter,
      tier: query.tier === "all" ? undefined : query.tier,
    });
    conditions.push(
      inArray(items.state, [...(query.state ?? ["active", "archived"])]),
    );

    const named = (query.types ?? []).map((type) => type.trim());
    if (named.length > 0 && !named.includes(GLOBAL_TYPE_WILDCARD)) {
      const subtrees = named.map((type) => typeSubtreeSql(items.type, type));
      const held = or(...subtrees.filter((sub) => sub !== undefined));
      if (held) conditions.push(held);
    }
    if (query.beneath !== undefined) {
      conditions.push(
        beneathSql(query.beneath, (type, source) =>
          and(
            typeFilterSql(type, {
              allowed: reader.allowed_types,
              excluded: reader.excluded_types ?? [],
            }),
            sourceFilterToSql(reader.source_filter, type, source),
          ),
        ),
      );
    }
    if (page.cursor !== undefined) {
      conditions.push(afterCursor(view, order, page.cursor));
    }

    const keyColumns = Object.fromEntries(
      order.terms.map((term, i) => [
        `key_${String(i)}`,
        sql`${term.expr}`.as(`key_${String(i)}`),
      ]),
    );
    const rows = await this.db
      .select({ ...itemColumns, ...keyColumns })
      .from(items)
      .where(and(...conditions))
      .orderBy(...orderBy(order))
      .limit(limit + 1)
      .all();

    const data = rows.slice(0, limit).map(rowToItem);
    const last: Record<string, unknown> | undefined =
      rows.length > limit ? rows[limit - 1] : undefined;
    const lastItem = data.at(-1);
    if (last === undefined || lastItem === undefined) {
      return { data, next_cursor: null };
    }
    const values = order.terms.map((_, i) =>
      keyValue(last[`key_${String(i)}`]),
    );
    return {
      data,
      next_cursor: encodeViewCursor(view, values, lastItem.id),
    };
  }

  async update(
    id: string,
    input: StoredUpdateItemInput,
  ): Promise<ResolvedItem | ConflictResponse | AncestorUnavailableResponse> {
    if (input.occurred_at !== undefined) {
      input = {
        ...input,
        occurred_at: normalizeTimeBound(input.occurred_at, "occurred_at"),
      };
    }
    const whereClause = eq(items.id, id);

    return await this.db.transaction(async (tx) => {
      const row = await tx
        .select(itemColumns)
        .from(items)
        .where(whereClause)
        .get();
      if (!row) {
        throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
      }
      if (row.state === "trashed" && input.in_bin !== true) {
        throw new MarfaError(
          ErrorCode.INVALID_TRANSITION,
          "Cannot update trashed item",
        );
      }
      // A row whose type a forced delete removed has no schema to hold a
      // write to, and one registered again under its id may hold another
      // shape: its fields stay as they are until the type is back.
      if (!getTypeSchema(row.type)) {
        throw new MarfaError(
          ErrorCode.UNKNOWN_TYPE,
          `Unknown type: ${row.type}. Register it via POST /types before writing items of it.`,
          { type: row.type },
        );
      }
      // Asked inside the write lock, as a create asks it: a type deleted
      // since any earlier check is out of the registry before its delete
      // commits, so a move entering it now is refused rather than landing
      // a row that names nothing.
      if (
        input.type !== undefined &&
        input.type !== row.type &&
        !getTypeSchema(input.type)
      ) {
        throw new MarfaError(
          ErrorCode.UNKNOWN_TYPE,
          `Unknown type: ${input.type}. Register it via POST /types before moving items into it.`,
          { type: input.type },
        );
      }

      const currentProps = safeJsonParse<Record<string, unknown>>(
        row.properties,
        {},
        "item update properties",
      );
      // Nulls are read by the type the row ends up as: on a move, a null
      // clears a field the destination declares optional and is refused
      // on one it requires, whatever the type being left said about it.
      const incomingProps = resolveIncomingProperties(
        input.type ?? row.type,
        input.properties,
      );
      const now = clock.now().toISOString();

      // The row's own fields as they stand, which is what this version
      // will have held once the update below moves past it.
      const currentFields: ItemFieldValues = {
        tier: row.tier,
        occurred_at: row.occurred_at,
        source_id: row.source_id,
      };
      // The same three as a refusal's envelope carries them, with the row's
      // id: a caller told that one of them collided can read both sides, and
      // a create that named only a natural key learns which row refused it.
      const snapshotFields: SnapshotItemFields = {
        id,
        tier: row.tier as Tier,
        occurred_at: row.occurred_at,
        source_id: row.source_id,
        type: row.type,
      };

      // The version store's own write, inside this transaction, so the
      // snapshot and the update it records land together or not at all.
      const writeVersion = async (
        propertiesToSnapshot: Record<string, unknown>,
      ) => {
        await this.versionStore.create(
          id,
          row.version,
          propertiesToSnapshot,
          {
            tier: row.tier as Tier,
            occurred_at: row.occurred_at,
            source_id: row.source_id,
            type: row.type,
            writer: rowWriter(row),
          },
          tx,
        );
      };

      if (input.version === undefined || row.version === input.version) {
        // Every version-incrementing write snapshots the state it is leaving
        // behind: a stale write merges against the snapshot at the version
        // the caller named, and a version without one answers
        // `ancestor_unavailable`. Volume is the version thinner's problem,
        // not this write's.
        await writeVersion(currentProps);

        const merged = judgeResult(
          input,
          row.type,
          currentProps,
          withoutKeys(
            mergeUpdateProperties(
              currentProps,
              incomingProps,
              input.properties_mode ?? "merge",
            ),
            input.clear_properties,
          ),
        );
        return await this.persistUpdate(tx, row, {
          id,
          input,
          now,
          properties: merged,
          fields: {
            ...(input.tier !== undefined && { tier: input.tier }),
            ...(input.occurred_at !== undefined && {
              occurred_at: input.occurred_at,
            }),
            ...(input.source_id !== undefined && {
              source_id: input.source_id,
            }),
          },
          answeredOccurredAt: input.occurred_at,
          keysSourceId: input.source_id,
          carried: digestsIn(incomingProps ?? {}),
        });
      }

      // Resolve the ancestor version inside the same transaction (passing
      // `tx`) so it's consistent with the item row read above.
      // `input.version` is known-defined here: the omitted and
      // equal-version cases returned in the branch above.
      const stored = await this.versionStore.getByVersion(
        id,
        input.version,
        tx,
      );
      const ancestor =
        stored !== null && input.may_read_type(stored.type) ? stored : null;

      if (!ancestor) {
        // Its own answer rather than a conflict naming every field. See
        // `ErrorCode.ANCESTOR_UNAVAILABLE`: there is nothing to merge
        // against, and a resolution invented here loses an edit quietly.
        // Never auto-resolved, whatever the request asked for.
        return ancestorUnavailable(
          row.version,
          currentProps,
          input.version,
          snapshotFields,
        );
      }

      // A stale write is credited only for digests its own base version
      // lacked: one the base already held came from whoever wrote it there,
      // and may since have been removed, so echoing it back is not sending it.
      const baseDigests = digestsIn(ancestor.properties);
      const staleCarried = new Set(
        [...digestsIn(incomingProps ?? {})].filter(
          (hash) => !baseDigests.has(hash),
        ),
      );

      // Only the item fields this write names. A field it is silent about
      // is not a change and cannot collide, so a write that touches
      // properties alone names none of the three.
      const clientFields: ItemFieldValues = {
        ...(input.tier !== undefined && { tier: input.tier }),
        ...(input.occurred_at !== undefined && {
          occurred_at: input.occurred_at,
        }),
        ...(input.source_id !== undefined && { source_id: input.source_id }),
      };

      // Under `replace` the body is the whole of the caller's properties:
      // a null in it is a key left out, as the write at the current version
      // reads it, and a key the ancestor had and the body lacks is a change
      // the caller made: the caller cleared it.
      const replacing =
        input.properties_mode === "replace" && incomingProps !== undefined;
      // A file's size is the server's to set, on the row the write leaves
      // and on the versions it compares, so a stale write neither changes
      // nor clears it, and cannot collide on it. A value no write could
      // carry stays, to be refused as it is at the current version.
      const sized = isFileType(row.type) || isFileType(input.type ?? row.type);
      const serverSize = (key: string, value: unknown) =>
        sized &&
        key === "size_bytes" &&
        (value === null || Number.isSafeInteger(value));
      const clientProps: Record<string, unknown> = Object.fromEntries(
        Object.entries(incomingProps ?? {}).filter(
          ([key, value]) =>
            !(replacing && value === null) && !serverSize(key, value),
        ),
      );
      const clearedProperties = [
        ...(replacing
          ? Object.keys(ancestor.properties).filter(
              (key) =>
                !Object.hasOwn(clientProps, key) &&
                !(sized && key === "size_bytes"),
            )
          : []),
        ...(input.clear_properties ?? []),
      ];

      const result = detectConflict({
        clientProperties: clientProps,
        currentProperties: currentProps,
        ancestorProperties: ancestor.properties,
        clientFields,
        currentFields,
        ancestorFields: ancestor,
        clearedProperties,
      });

      const policy = resolveMergePolicy(row.type, (id) => getTypeSchema(id));

      // What the row ends up holding: the detector's merge when nothing
      // collided, the policy's resolution when something did and the caller
      // asked the server to resolve it.
      let resolvedProperties: Record<string, unknown>;
      // The item fields this write ends up applying. On the merge path
      // only the ones it genuinely changed, so an echoed value cannot
      // revert one written since; under `conflict=auto` the ones it named,
      // because the three carry no per-field merge strategy and the
      // resolution for them is the later writer.
      let resolvedFields: ItemFieldValues;
      let resolution: ConflictResolutionReport | undefined;
      // Null on the idempotent retry, where the row already existed.
      let sibling: { sibling: Item; edges: Edge[] } | null = null;

      // A move onto a row another writer has moved since the version the
      // caller read collides on the type, whatever else the write carries:
      // landing it would undo a move the caller never saw.
      const movedSince = input.type !== undefined && row.type !== ancestor.type;

      const ancestorFields = {
        current: snapshotFields,
        ancestor: {
          id,
          tier: ancestor.tier,
          occurred_at: ancestor.occurred_at,
          source_id: ancestor.source_id,
          type: ancestor.type,
        },
      };
      if (movedSince) {
        return versionConflict(
          row.version,
          currentProps,
          input.version,
          ancestor.properties,
          [
            ...(result.type === "conflict" ? result.conflicting_fields : []),
            "type",
          ].sort(),
          policy,
          ancestorFields,
        );
      }

      if (result.type === "conflict") {
        // A colliding write that also moves the type is not resolved: the
        // policy is the type being left's, and a copy the resolution wrote
        // would belong to neither type.
        if (input.conflict_mode !== "auto" || input.type !== undefined) {
          return versionConflict(
            row.version,
            currentProps,
            input.version,
            ancestor.properties,
            result.conflicting_fields,
            policy,
            ancestorFields,
          );
        }

        const plan = planAutoMerge({
          clientProperties: clientProps,
          currentProperties: currentProps,
          ancestorProperties: ancestor.properties,
          conflictingFields: result.conflicting_fields,
          collidingItemFields: result.collidingItemFields,
          policy,
          clearedProperties,
        });

        // The sibling is written here, inside the transaction that moves the
        // original on. A client doing this in two writes has no arrangement
        // that is atomic: dying between them leaves the losing edit nowhere
        // and the original already past it.
        let siblingId: string | undefined;
        if (plan.keepBothFields.length > 0) {
          // A copy carries no link, so it could not be a row of a type that
          // requires one.
          if (linkRequired(row.type)) {
            return versionConflict(
              row.version,
              currentProps,
              input.version,
              ancestor.properties,
              result.conflicting_fields,
              policy,
              ancestorFields,
            );
          }
          // The copy is a new item, so it is judged as a create of its type
          // would be and stored as that judgment answers it, and refusing it
          // refuses the whole write. A status word the write leaves alone is
          // kept, as in an update. Its schedule is judged whole, as a create's
          // is, so that a rule the losing writer set cannot be stored here
          // when every other door refuses it.
          const siblingProperties = conflictedSiblingProperties({
            clientProperties: clientProps,
            currentProperties: currentProps,
            keepBothFields: plan.keepBothFields,
            clearedProperties,
          });
          const validation = validateProperties(row.type, siblingProperties, {
            written: Object.fromEntries(
              Object.entries(siblingProperties).filter(
                ([name, value]) => !Object.is(value, currentProps[name]),
              ),
            ),
          });
          if (!validation.success) {
            throw new MarfaError(
              ErrorCode.INVALID_PROPERTIES,
              `Invalid properties: ${validation.errors
                .map((e) => `${e.field}: ${e.message}`)
                .join("; ")}`,
              { errors: validation.errors },
            );
          }
          siblingId = conflictedSiblingIdFor(id, input.version, input);
          sibling = await insertConflictedSibling(tx, this.searchStore, {
            siblingId,
            mayCopyEdge: input.may_copy_edge,
            row,
            now,
            proof: input.blob_proof ?? null,
            refuseUnprovenFile: input.refuse_unproven_file === true,
            carried: staleCarried,
            writer: input.writer ?? null,
            properties: storedAsValidated(siblingProperties, validation.data),
          });
        }

        resolvedProperties = plan.merged;
        // The genuine changes, not everything the write named: a field
        // echoed back at the value the caller read is not a change, and
        // applying it would revert a value written since — the same
        // revert the properties overlay refuses to make.
        resolvedFields = result.changedFields;
        resolution = {
          fields: result.conflicting_fields,
          strategy: plan.strategyByField,
          ...(siblingId !== undefined && { conflicted_copy_id: siblingId }),
        };
      } else {
        resolvedProperties = result.merged;
        resolvedFields = result.changedFields;
      }

      resolvedProperties = judgeResult(
        input,
        row.type,
        currentProps,
        resolvedProperties,
      );

      // Same invariant as the fast path above: the version being left behind
      // is snapshotted so a later stale write can merge against it.
      await writeVersion(currentProps);
      const persisted = await this.persistUpdate(tx, row, {
        id,
        input,
        now,
        properties: resolvedProperties,
        fields: resolvedFields,
        // An item's own time is never null on the row, so a resolved
        // value of null is a field the write did not settle rather than
        // one it cleared.
        answeredOccurredAt: resolvedFields.occurred_at ?? undefined,
        keysSourceId: resolvedFields.source_id ?? undefined,
        carried: staleCarried,
      });
      return attachResolution(
        persisted,
        resolution,
        sibling?.sibling,
        sibling?.edges,
      );
    });
  }

  /** The write both update paths end on: the row, the keys kept in step with
   *  it, the search index and the answer, inside the caller's transaction.
   *  `fields` are the item fields the row takes; `answeredOccurredAt` and
   *  `keysSourceId` are what the answer and the key sync read, which the two
   *  paths settle differently. */
  private async persistUpdate(
    tx: SqliteTx,
    row: ItemRow,
    write: {
      id: string;
      input: StoredUpdateItemInput;
      now: string;
      properties: Record<string, unknown>;
      fields: ItemFieldValues;
      answeredOccurredAt: string | undefined;
      keysSourceId: string | undefined;
      carried: ReadonlySet<string>;
    },
  ): Promise<Item> {
    const { id, input, now, fields } = write;
    const newVersion = row.version + 1;
    const newTier = fields.tier ?? row.tier;
    const type = input.type ?? row.type;

    const setClause: Record<string, unknown> = {
      properties: sql`jsonb(${JSON.stringify(write.properties)})`,
      // Unconditional, so a patch that removes `starts_at` nulls the
      // column rather than leaving the last value behind.
      ...instantColumnValues(write.properties),
      version: newVersion,
      updated_at: now,
      ...writerColumns(input.writer ?? null),
      ...(fields.tier !== undefined && { tier: fields.tier }),
      ...(fields.occurred_at !== undefined && {
        occurred_at: fields.occurred_at,
      }),
      ...(fields.source_id !== undefined && { source_id: fields.source_id }),
      // Only where a caller explicitly asked to re-type. Every other door
      // refuses a type that disagrees with the row rather than passing one
      // down here.
      ...(input.type !== undefined && { type: input.type }),
    };

    try {
      const written = await tx
        .update(items)
        .set(setClause)
        .where(eq(items.id, id))
        .run();
      if (
        written.rowsAffected > 0 &&
        input.type !== undefined &&
        input.type !== row.type
      ) {
        markStructuralReadChange();
        // A mark's type decides who may be told the row it names, so a
        // binned root that changes type takes its marks with it.
        if (row.state === "trashed")
          await tx
            .update(cascade_marks)
            .set({ trashed_with_type: input.type })
            .where(eq(cascade_marks.trashed_with, id))
            .run();
      }
    } catch (err) {
      if (isSourceDedupViolation(err)) {
        throw new MarfaError(
          ErrorCode.SOURCE_ID_CONFLICT,
          `source_id "${String(input.source_id)}" is already in use under source "${row.source ?? MISSING_SOURCE}"`,
          { source: row.source, source_id: input.source_id },
        );
      }
      throw err;
    }
    await this.keepKeysInStep(
      tx,
      { id, type, properties: write.properties },
      row,
      write.keysSourceId,
      input.blob_proof ?? null,
      write.carried,
      input.refuse_unproven_file === true,
    );
    const properties = await keepFileSize(tx, {
      id,
      type,
      properties: write.properties,
    });

    // The bin is never searched, so a row written there stays out of the index.
    if (row.state !== "trashed")
      await this.searchStore.index(id, properties, type);

    return rowToItem({
      ...row,
      properties: JSON.stringify(properties),
      version: newVersion,
      updated_at: now,
      tier: newTier,
      ...(write.answeredOccurredAt !== undefined && {
        occurred_at: write.answeredOccurredAt,
      }),
      ...(fields.source_id !== undefined && { source_id: fields.source_id }),
      // Carried onto the response as well as into the row: built from the
      // pre-update snapshot alone, the response would report the type the
      // item had stopped being, and a re-type would read as having silently
      // done nothing.
      ...(input.type !== undefined && { type: input.type }),
    });
  }

  async delete(
    id: string,
    trashedWith?: CascadeRoot,
    writer: VersionWriter | null = null,
  ): Promise<void> {
    const row = await this.getRaw(id);
    if (!row) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    // A soft delete is a transition, so it goes through the same gate the
    // explicit transition route uses. Writing `trashed` unconditionally would
    // put a `system.*` row into a state its own lifecycle does not contain:
    // no transition produces it, none leaves it, and no default listing
    // reports it, so it is reachable only by enumerating every state.
    const target = softDeleteState(row.type);
    // Idempotent: deleting something already soft-deleted is not an error,
    // and `trashed → trashed` is not a legal transition, so this has to
    // return before the gate rather than be admitted by it.
    if (row.state === target) return;
    const error = validateTransition(row.type, row.state, target);
    if (error) {
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, error);
    }

    const now = clock.now().toISOString();
    await this.db
      .update(items)
      .set({
        state: target,
        updated_at: now,
        // The sweep's clock starts here rather than at the modification
        // time, which a later write to the trashed row would move.
        // `softDeleteClock` carries why.
        ...softDeleteClock(row.type, row.state, target, now),
        trashed_by: writer,
      })
      .where(eq(items.id, id));
    if (trashedWith !== undefined && target === "trashed") {
      await this.db
        .insert(trash_cascades)
        .values({ item_id: id, trashed_with: trashedWith.id })
        .run();
      await this.db
        .insert(cascade_marks)
        .values({
          item_id: id,
          trashed_with: trashedWith.id,
          trashed_with_type: trashedWith.type,
        })
        .run();
    }

    await this.searchStore.remove(id);
  }

  async purge(
    id: string,
    opts: { revokedGrant?: boolean } = {},
  ): Promise<void> {
    const row = await this.getRaw(id);
    if (!row) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    // Purge is the hard delete behind a soft one, so the gate is "already
    // soft-deleted" rather than the literal `trashed` — which a `system.*`
    // row can never reach, and which would therefore make its rows
    // unpurgeable.
    const target = softDeleteState(row.type);
    const sweptGrant = opts.revokedGrant === true && isRevokedAppGrantRow(row);
    if (row.state !== target && !sweptGrant) {
      // The code the restore door answers for the same class of mistake.
      // Both doors are asking what may happen to a row in the state it is
      // in, and a caller sorting refusals by code would otherwise sort
      // these two apart on which door it asked.
      throw new MarfaError(
        ErrorCode.INVALID_TRANSITION,
        `Only ${target} items can be purged`,
      );
    }

    await this.rehomeTrashRecords([id]);
    await recordTombstones(this.db, [id], clock.now().toISOString());
    // metadata, versions and blob references cascade; the search index must
    // be removed explicitly.
    await this.db.delete(items).where(eq(items.id, id)).run();

    await this.searchStore.remove(id);
  }

  async listTrashedOlderThan(
    beforeDate: string,
    limit = 200,
  ): Promise<string[]> {
    const rows = await this.db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.state, "trashed"),
          // The window runs from when the row entered the bin, not from when
          // it was last written: `updated_at` moves on any write to a
          // trashed row, a tag or an extension write included, so measuring
          // from it would restart the clock on an edit made in the bin.
          lt(items.trashed_at, beforeDate),
        ),
      )
      .orderBy(items.trashed_at, items.id)
      .limit(limit)
      .all();
    return rows.map((row) => row.id);
  }

  async listExpiredFeed(
    type: string,
    beforeDate: string,
    after?: { created_at: string; id: string },
    limit = 200,
  ): Promise<{ id: string; created_at: string }[]> {
    // The literals are the partial index's own, which the planner can only
    // match to a predicate written the same way, not to a bound parameter.
    return this.db
      .select({ id: items.id, created_at: items.created_at })
      .from(items)
      .where(
        and(
          eq(items.type, type),
          sql`${items.tier} = 'feed' AND ${items.state} = 'active' AND ${items.restored_at} IS NULL`,
          lt(items.created_at, beforeDate),
          after
            ? sql`(${items.created_at}, ${items.id}) > (${after.created_at}, ${after.id})`
            : undefined,
        ),
      )
      .orderBy(items.created_at, items.id)
      .limit(limit)
      .all();
  }

  async restoredAtOf(ids: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const rows = await this.db
        .select({ id: items.id, restored_at: items.restored_at })
        .from(items)
        .where(
          and(
            inArray(items.id, ids.slice(offset, offset + 500)),
            isNotNull(items.restored_at),
          ),
        )
        .all();
      for (const row of rows) {
        if (row.restored_at !== null) found.set(row.id, row.restored_at);
      }
    }
    return found;
  }

  async listRevokedAppGrantsOlderThan(
    beforeDate: string,
    limit = 200,
  ): Promise<string[]> {
    // A grant revoked through the user-facing path keeps
    // `state: "active"`, so this asks `properties` rather than the
    // lifecycle, and `kind = 'app'` keeps the sweep to application grants.
    const rows = await this.db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.type, "system.connection"),
          sql`json_extract(${items.properties}, '$.kind') = 'app'`,
          sql`json_extract(${items.properties}, '$.status') = 'revoked'`,
          sql`json_extract(${items.properties}, '$.revoked_at') < ${beforeDate}`,
        ),
      )
      .orderBy(items.id)
      .limit(limit)
      .all();
    return rows.map((row) => row.id);
  }

  async listInactiveAppGrants(cutoffIso: string): Promise<
    {
      id: string;
      clientId: string | null;
      authUserId: string | null;
      lastUsedAt: string | null;
      grantedAt: string | null;
      properties: Record<string, unknown>;
    }[]
  > {
    // ISO-8601 strings compare lexically in timestamp order, which is what
    // every other sweep here relies on too. A grant never used falls back
    // to when it was granted, so a grant approved and forgotten retires on
    // the same clock as one used once and forgotten.
    // `itemColumns`, not `select()`: the properties column is read back
    // through `json()` so `rowToItem` can parse it, as every other read here
    // does. A raw select hands it the stored form and the parse comes back
    // empty, which reads as a grant with no client and no user.
    const rows = await this.db
      .select(itemColumns)
      .from(items)
      .where(
        and(
          eq(items.type, "system.connection"),
          eq(items.state, "active"),
          sql`json_extract(${items.properties}, '$.kind') = 'app'`,
          sql`json_extract(${items.properties}, '$.status') = 'active'`,
          sql`coalesce(json_extract(${items.properties}, '$.last_used_at'), json_extract(${items.properties}, '$.granted_at')) < ${cutoffIso}`,
        ),
      );
    return rows.map((row) => {
      const item = rowToItem(row);
      const props = item.properties;
      const str = (v: unknown): string | null =>
        typeof v === "string" ? v : null;
      return {
        id: item.id,
        clientId: str(props.client_id),
        authUserId: str(props.user_id),
        lastUsedAt: str(props.last_used_at),
        grantedAt: str(props.granted_at),
        properties: props,
      };
    });
  }

  async restore(id: string): Promise<Item> {
    const row = await this.getRaw(id);
    if (!row) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    if (row.state !== "trashed") {
      throw new MarfaError(ErrorCode.INVALID_TRANSITION, "Item is not trashed");
    }

    // A restore is a transition, so it goes through the same gate `delete()`
    // above and `transition()` below use; a gate three paths apply and the
    // fourth does not would survive review indefinitely, because each path
    // reads correctly on its own.
    //
    // What it stops is specific: `trashed` is not in the `system.*`
    // lifecycle, so a `system.connection` that somehow holds it must not be
    // able to walk out into `active` having passed no transition the graph
    // admits. The check lives here rather than in the route because keeping
    // the three siblings side by side is what stops them drifting. Its
    // companion, refusing to create such a row in the first place, sits at
    // the route layer instead; see `POST /items` in `routes/items.ts` for
    // why `create` stays permissive.
    const error = validateTransition(row.type, row.state, "active");
    if (error) {
      throw new MarfaError(ErrorCode.INVALID_TRANSITION, error);
    }

    const now = clock.now().toISOString();
    await this.db
      .update(items)
      .set({
        state: "active",
        updated_at: now,
        ...softDeleteClock(row.type, row.state, "active", now),
        trashed_by: null,
      })
      .where(eq(items.id, id))
      .run();
    await this.clearTrashRecords(id);

    await this.searchStore.index(id, row.properties, row.type);

    return {
      ...row,
      state: "active" as ItemState,
      updated_at: now,
      trashed_at: null,
    };
  }

  /** What a row leaving the bin leaves behind of the trash that took it. */
  private async clearTrashRecords(id: string): Promise<void> {
    await this.db
      .delete(trash_cascades)
      .where(eq(trash_cascades.item_id, id))
      .run();
    await this.db
      .delete(cascade_marks)
      .where(eq(cascade_marks.item_id, id))
      .run();
  }

  async restoreBeneath(id: string): Promise<Item[]> {
    const [own] = await this.db
      .select({ trashed_with: trash_cascades.trashed_with })
      .from(trash_cascades)
      .where(eq(trash_cascades.item_id, id))
      .all();
    const trashes = own === undefined ? [id] : [id, own.trashed_with];
    const taken = await this.db
      .select({ item_id: trash_cascades.item_id })
      .from(trash_cascades)
      .where(inArray(trash_cascades.trashed_with, trashes))
      .all();
    // A row a trash above took is brought back only from beneath this one:
    // restoring a child brings back its own children, not its siblings.
    const beneath = own === undefined ? null : await this.beneath(id);
    const restored: Item[] = [];
    for (const { item_id } of taken) {
      if (item_id === id || (beneath !== null && !beneath.has(item_id))) {
        continue;
      }
      const row = await this.getRaw(item_id);
      if (row?.state !== "trashed") {
        // Out of the bin by a door that kept no record of it, which leaves
        // nothing to bring back and a record that says otherwise.
        await this.clearTrashRecords(item_id);
        continue;
      }
      restored.push(await this.restore(item_id));
    }
    return restored;
  }

  /** Every row reachable from `id` along edges whose type cascades on
   *  delete, whatever their state: the rows a trash of `id` would take. */
  private async beneath(
    id: string,
    db: DrizzleDb | SqliteTx = this.db,
  ): Promise<Set<string>> {
    const reached = new Set<string>();
    let frontier = [id];
    while (frontier.length > 0) {
      const out = await db
        .select({ target_id: edges.target_id, edge_type: edges.edge_type })
        .from(edges)
        .where(inArray(edges.source_id, frontier))
        .all();
      frontier = [];
      for (const edge of out) {
        if (getEdgeTypeSchema(edge.edge_type)?.cascade_on_delete !== "cascade")
          continue;
        if (reached.has(edge.target_id) || edge.target_id === id) continue;
        reached.add(edge.target_id);
        frontier.push(edge.target_id);
      }
    }
    return reached;
  }

  /**
   * Keeps what a trash took restorable when the row it is keyed to is purged.
   * Each row that trash took becomes its own trash's root unless another of
   * them lies above it, and the rows beneath a root are keyed to it, so
   * restoring a row still brings back what lay beneath it. Left to go with
   * the purged row, a row restored from the middle of the subtree would come
   * back alone.
   */
  private async rehomeTrashRecords(
    purged: readonly string[],
    db: DrizzleDb | SqliteTx = this.db,
  ): Promise<void> {
    if (purged.length === 0) return;
    const gone = new Set(purged);
    const orphaned = (
      await db
        .select({ item_id: trash_cascades.item_id })
        .from(trash_cascades)
        .where(inArray(trash_cascades.trashed_with, [...gone]))
        .all()
    )
      .map((row) => row.item_id)
      .filter((id) => !gone.has(id));
    if (orphaned.length === 0) return;
    const under = new Map<string, Set<string>>();
    for (const id of orphaned) under.set(id, await this.beneath(id, db));
    for (const root of orphaned) {
      const above = orphaned.some(
        (other) => other !== root && under.get(other)?.has(root) === true,
      );
      if (above) continue;
      await db
        .delete(trash_cascades)
        .where(eq(trash_cascades.item_id, root))
        .run();
      const mine = orphaned.filter(
        (id) => id !== root && under.get(root)?.has(id) === true,
      );
      if (mine.length > 0) {
        await db
          .update(trash_cascades)
          .set({ trashed_with: root })
          .where(inArray(trash_cascades.item_id, mine))
          .run();
      }
    }
  }

  async transition(id: string, state: ItemState): Promise<Item> {
    const row = await this.getRaw(id);
    if (!row) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const error = validateTransition(row.type, row.state, state);
    if (error) {
      throw new MarfaError(ErrorCode.INVALID_TRANSITION, error);
    }

    const now = clock.now().toISOString();
    const stamp = softDeleteClock(row.type, row.state, state, now);
    await this.db
      .update(items)
      .set({
        state,
        updated_at: now,
        ...stamp,
        ...(row.state === softDeleteState(row.type) ||
        state === softDeleteState(row.type)
          ? { trashed_by: null }
          : {}),
      })
      .where(eq(items.id, id))
      .run();

    if (state === "trashed") {
      await this.searchStore.remove(id);
    } else if (row.state === "trashed") {
      await this.clearTrashRecords(id);
      await this.searchStore.index(id, row.properties, row.type);
    }

    return {
      ...row,
      state,
      updated_at: now,
      ...("trashed_at" in stamp && { trashed_at: stamp.trashed_at }),
    };
  }

  async countByType(type: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(items)
      .where(eq(items.type, type))
      .all();
    return row?.count ?? 0;
  }

  async stats(
    filters: ItemFilters,
    by: ItemStatsAxis = "state",
  ): Promise<Record<string, number>> {
    const conditions = itemFilterConditions(filters);

    const rows = await this.db
      .select({
        // The grouped column is chosen here rather than by two near-identical
        // query builders, so a filter added to one axis cannot be missed on
        // the other — which is what would break the totals agreeing.
        bucket: by === "type" ? items.type : items.state,
        count: sql<number>`count(*)`,
      })
      .from(items)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(by === "type" ? items.type : items.state)
      .all();

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.bucket] = row.count;
    }
    return result;
  }
}
