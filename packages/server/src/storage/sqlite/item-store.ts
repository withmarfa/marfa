import { safeJsonParse } from "../json-utils.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "../../page-limits.js";
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
  notInArray,
  getTableColumns,
  type SQL,
} from "drizzle-orm";
import { softDeleteClock } from "../soft-delete-clock.js";
import {
  generateId,
  isValidId,
  getResolvedFields,
  getTypeSchema,
  validateProperties,
  validateTransition,
  getEdgeTypeSchema,
  softDeleteState,
  parseFilter,
  MarfaError,
  ErrorCode,
  SYSTEM_DEFAULT_STATE,
  typePatternToSql,
  typeFilterTerms,
  typeSubtreeToSql,
} from "@withmarfa/shared";
import { resolveMergePolicy } from "../policy.js";
import {
  mergeUpdateProperties,
  resolveIncomingProperties,
} from "../merge-properties.js";
import { filterToSqlConditions, sourceFilterToSql } from "../filter-sql.js";
import type { Edge } from "@withmarfa/shared";
import type {
  ItemStatsAxis,
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
} from "@withmarfa/shared";
import type {
  CascadeRoot,
  ItemStore,
  ResolvedItem,
  ItemFilters,
  SortDirection,
  CursorSortKey,
  Tombstone,
  TombstoneSelector,
} from "../interface.js";
import {
  encodeKeyedCursor,
  cursorSortKey,
  decodeKeyedCursorNullable,
  normalizeTimeBound,
  parseSortField,
} from "../interface.js";
import { buildPropertySortExpr, propertySortValue } from "../property-sort.js";
import { closedToNewEdge } from "../edge-constraints.js";
import {
  ancestorUnavailable,
  attachResolution,
  conflictedSiblingIdFor,
  conflictedSiblingProperties,
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
  syncBlobReferences,
  type BlobProof,
} from "./blob-references.js";
import { isPrimaryKeyViolation } from "./pk-violation.js";
import type { SqliteVersionStore } from "./version-store.js";
import type { SqliteSearchStore } from "./search-store.js";
import { rowToItem } from "./helpers.js";

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

/**
 * Compiles the caller's readable-type patterns into one predicate.
 *
 * Shared by `list` and `stats` so the two cannot disagree about what a
 * credential can see. Both directions of disagreement have bitten: comparing
 * the patterns as literal identifiers reports zero rows for every
 * wildcard-scoped credential, and ignoring an empty list reports every row
 * to a credential that may read nothing.
 *
 * `undefined` in means "no filter", which is either a request that carried no
 * credential at all — bootstrap and the anonymous reads — or a server-internal
 * read with no caller to bound it. No authenticated caller produces it: its
 * permission map is the whole of what it may reach, so it always arrives with
 * a real list. An empty array is the opposite: a credential whose map, or
 * whose projected OAuth scopes, permit no type at all, which must see nothing
 * rather than everything. `undefined` out means "no predicate", so a caller
 * pushes the result only when it is present.
 */
function typePatternClause(pattern: string): SQL {
  const { global, exact, descendantPattern } = typePatternToSql(pattern);
  if (global) return sql`1=1`;
  // Only the empty string reaches here, and `resolveTypePermission` cannot
  // honor that as a grant or as an exclusion either — so `1=0` matches the
  // point check in both positions: it grants nothing, and negated it
  // withholds nothing.
  if (!exact) return sql`1=0`;
  if (!descendantPattern) return sql`${items.type} = ${exact}`;
  return sql`(${items.type} = ${exact} OR ${items.type} LIKE ${descendantPattern} ESCAPE '\\')`;
}

export function allowedTypesCondition(
  patterns: string[] | undefined,
  excluded: string[] = [],
): SQL | undefined {
  if (!patterns) return undefined;
  if (patterns.length === 0) return sql`1=0`;
  const clauses = typeFilterTerms(patterns, excluded).map(
    ({ pattern, minus }) => {
      const granted = typePatternClause(pattern);
      if (minus.length === 0) return granted;
      // `typeFilterTerms` has already dropped the exclusions this grant
      // outranks, so everything left genuinely carves into it.
      const carved = minus
        .map(typePatternClause)
        .reduce((acc, part) => sql`${acc} OR ${part}`);
      return sql`(${granted} AND NOT (${carved}))`;
    },
  );
  return or(...clauses);
}

type SqliteTx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

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
    /** The properties the losing write sent, whose digests are its own. */
    sent: Record<string, unknown>;
    mayCopyEdge?: (
      edgeType: string,
      sourceType: string,
      targetType: string,
    ) => boolean;
  },
): Promise<{ sibling: Item; edges: Edge[] } | null> {
  const { siblingId, row, now, mayCopyEdge } = args;
  const linkField = linkFieldOf(row.type);
  const properties =
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
      source: row.source,
      version: 1,
      schema_version: schemaVersion,
      ...instantColumnValues(properties),
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
    carried: digestsIn(args.sent),
    inherited,
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

  const copied: Edge[] = [];
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
    const own = outbound
      ? schema.written_at === "source"
      : schema.written_at === "target";
    if (!own) continue;
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
    copied.push({
      ...copy,
      properties: safeJsonParse<Record<string, unknown>>(
        copy.properties,
        {},
        "conflicted copy edge properties",
      ),
    });
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
      source: row.source ?? "unknown",
    } satisfies Item,
    edges: copied,
  };
}

/**
 * The WHERE terms a listing's filters compile to, cursor aside.
 *
 * One builder for the listing and the counts, so a count asked with a
 * listing's filters is the number of rows that listing would walk.
 */
function itemFilterConditions(filters: ItemFilters): SQL[] {
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

  if (filters.state) {
    conditions.push(eq(items.state, filters.state));
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
      conditions.push(eq(items.state, "active"));
    }
  }

  if (filters.type) {
    // `core.entity` and `core.entity.*` mean the same thing: the type and
    // everything under it. A bare identifier has always included its
    // subtypes here, so the explicit wildcard must too.
    const { global, exact, descendantPattern, extraTypes } = typeSubtreeToSql(
      filters.type,
    );
    if (!global && exact && descendantPattern) {
      const typeClause = or(
        eq(items.type, exact),
        sql`${items.type} LIKE ${descendantPattern} ESCAPE '\\'`,
        ...(extraTypes.length > 0 ? [inArray(items.type, extraTypes)] : []),
      );
      if (typeClause) conditions.push(typeClause);
    }
  }

  if (filters.source) conditions.push(eq(items.source, filters.source));

  if (filters.tier !== undefined) {
    conditions.push(eq(items.tier, filters.tier));
  }

  if (filters.exclude_system_types) {
    conditions.push(sql`${items.type} NOT LIKE 'system.%'`);
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
  // written in one fixed-width shape, so the calendar's window is a
  // range scan rather than a read of every event.
  if (filters.startsAtFrom !== undefined) {
    conditions.push(sql`${items.starts_at} >= ${filters.startsAtFrom}`);
  }
  if (filters.startsAtTo !== undefined) {
    conditions.push(sql`${items.starts_at} < ${filters.startsAtTo}`);
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

  if (filters.allowed_types) {
    const clause = allowedTypesCondition(
      filters.allowed_types,
      filters.excluded_types,
    );
    if (clause) conditions.push(clause);
  }

  const sourceLever = sourceFilterToSql(
    filters.source_filter,
    items.type,
    items.source,
  );
  if (sourceLever) conditions.push(sourceLever);

  if (filters.filter) {
    const expr = parseFilter(filters.filter);
    const filterConds = filterToSqlConditions(
      expr,
      items,
      filters.readable_sources,
    );
    if (expr.logical === "OR") {
      const orClause = or(...filterConds);
      if (orClause) conditions.push(orClause);
    } else {
      conditions.push(...filterConds);
    }
  }

  return conditions;
}

export class SqliteItemStore implements ItemStore {
  constructor(
    private db: DrizzleDb,
    private versionStore: SqliteVersionStore,
    private searchStore: SqliteSearchStore,
  ) {}

  async create(input: StoredCreateItemInput): Promise<Item> {
    const id = input.id ?? generateId();
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
    // an empty `{}` must still fail required-field checks (a core.note with
    // no body is invalid whether properties is empty or partially filled).
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
    const properties = validation.data;

    const now = new Date().toISOString();
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
          throw new MarfaError(
            ErrorCode.DUPLICATE_SOURCE,
            `Item with source=${input.source} source_id=${input.source_id} already exists`,
            { existing_id: existing.id },
          );
        }
      }

      // Asked again here, inside the write lock, because a type deleted
      // since the check above leaves the registry before its delete commits,
      // and a row written now would name a type nothing holds.
      const current = getTypeSchema(input.type);
      if (!current) {
        throw new MarfaError(
          ErrorCode.UNKNOWN_TYPE,
          `Unknown type: ${input.type}. Register it via POST /types before creating items of this type.`,
          { type: input.type },
        );
      }
      const schemaVersion = current.version;

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
            tier: input.tier ?? "library",
            properties: sql`jsonb(${JSON.stringify(properties)})`,
            created_at: now,
            updated_at: now,
            occurred_at: input.occurred_at ?? now,
            source: input.source,
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
          tags: JSON.stringify(input.tags ?? []),
        })
        .run();

      await syncLink(tx, { id, type: input.type, properties });
      await syncBlobReferences(
        tx,
        { id, properties },
        input.blob_proof ?? null,
      );
      if (input.source && input.source_id) {
        await forgetNaturalKey(tx, input.source, input.source_id);
      }

      // **A row born in the bin is not indexed**, the same rule `transition`
      // applies on the way in (`search-and-filters.md` 12): a trashed row
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
        source: input.source ?? "unknown",
        ...(input.source_id != null && { source_id: input.source_id }),
        ...(input.capture_latitude != null && {
          capture_latitude: input.capture_latitude,
        }),
        ...(input.capture_longitude != null && {
          capture_longitude: input.capture_longitude,
        }),
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
    const item = await this.findBySourceIdIncludingTrashed(source, sourceId);
    if (item?.state === "trashed") return null;
    return item;
  }

  async findBySourceIdIncludingTrashed(
    source: string,
    sourceId: string,
  ): Promise<Item | null> {
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
    sent: Record<string, unknown> | undefined,
  ): Promise<void> {
    await syncLink(tx, after, before.type);
    await syncBlobReferences(tx, after, proof, {
      carried: digestsIn(sent ?? {}),
    });
    if (before.source && sourceId && sourceId !== before.source_id) {
      await forgetNaturalKey(tx, before.source, sourceId);
    }
  }

  async getMany(
    ids: string[],
    opts?: { includeTrashed?: boolean },
  ): Promise<Map<string, Item>> {
    const out = new Map<string, Item>();
    if (ids.length === 0) return out;
    const unique = Array.from(new Set(ids));
    const where = inArray(items.id, unique);
    const rows = await this.db
      .select(itemColumns)
      .from(items)
      .where(where)
      .all();
    for (const row of rows) {
      if (row.state === "trashed" && opts?.includeTrashed !== true) continue;
      out.set(row.id, rowToItem(row));
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
      Math.min(filters.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    );

    // For a property sort, the ORDER BY / cursor comparison runs against a
    // JSON-extracted expression rather than a column. NULLS LAST is applied in
    // both directions, with `id` as a stable ascending tiebreak.
    const propertySort =
      sort.kind === "property"
        ? buildPropertySortExpr(items.properties, sort.field, filters.type)
        : null;

    const conditions: (SQL | undefined)[] = itemFilterConditions(filters);

    const systemSortCol =
      sort.kind === "system"
        ? sort.column === "updated_at"
          ? items.updated_at
          : sort.column === "occurred_at"
            ? items.occurred_at
            : items.created_at
        : null;

    if (filters.cursor) {
      const { v, id } = decodeKeyedCursorNullable(filters.cursor, cursorKey);
      if (propertySort) {
        // Keyset over a nullable, NULLS-LAST expression. `id` is an ascending
        // tiebreak in both directions, so the page boundary is a total order.
        const e = propertySort.expr;
        if (v === null) {
          // Already in the trailing NULL block — only later NULL rows remain.
          conditions.push(and(sql`${e} IS NULL`, gt(items.id, id)));
        } else {
          // Coerce the bound for the numeric path so the value comparison stays
          // numeric; the equality + id tiebreak advances past the boundary row.
          const bound = propertySort.numeric ? Number(v) : v;
          const valueCmp =
            dir === "desc" ? sql`${e} < ${bound}` : sql`${e} > ${bound}`;
          const clause = or(
            valueCmp,
            and(sql`${e} = ${bound}`, gt(items.id, id)),
            sql`${e} IS NULL`,
          );
          if (clause) conditions.push(clause);
        }
      } else if (systemSortCol && v !== null) {
        // System columns are NOT NULL, so the cursor value is always present.
        if (dir === "desc") {
          const clause = or(
            lt(systemSortCol, v),
            and(eq(systemSortCol, v), lt(items.id, id)),
          );
          if (clause) conditions.push(clause);
        } else {
          const clause = or(
            gt(systemSortCol, v),
            and(eq(systemSortCol, v), gt(items.id, id)),
          );
          if (clause) conditions.push(clause);
        }
      }
    }

    let orderBy;
    if (propertySort) {
      const e = propertySort.expr;
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

    const rows = await this.db
      .select(itemColumns)
      .from(items)
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(rowToItem);
    let cursor: string | null = null;

    if (hasMore) {
      const last = data.at(-1);
      if (!last) throw new Error("unreachable: hasMore but data is empty");
      const sortValue =
        sort.kind === "property"
          ? propertySortValue(last.properties, sort)
          : sort.column === "updated_at"
            ? last.updated_at
            : sort.column === "occurred_at"
              ? last.occurred_at
              : last.created_at;
      cursor = encodeKeyedCursor(sortValue, last.id, cursorKey);
    }

    return { data, next_cursor: cursor };
  }

  async update(
    id: string,
    input: StoredUpdateItemInput,
  ): Promise<ResolvedItem | ConflictResponse | AncestorUnavailableResponse> {
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
      if (row.state === "trashed") {
        throw new MarfaError(
          ErrorCode.INVALID_TRANSITION,
          "Cannot update trashed item",
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
      const now = new Date().toISOString();

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
            tier: row.tier,
            occurred_at: row.occurred_at,
            source_id: row.source_id,
            type: row.type,
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

        const merged = mergeUpdateProperties(
          currentProps,
          incomingProps,
          input.properties_mode ?? "merge",
        );
        const newVersion = row.version + 1;
        const newTier = input.tier ?? row.tier;

        const setClause: Record<string, unknown> = {
          properties: sql`jsonb(${JSON.stringify(merged)})`,
          // Unconditional, so a patch that removes `starts_at` nulls the
          // column rather than leaving the last value behind.
          ...instantColumnValues(merged),
          version: newVersion,
          updated_at: now,
          ...(input.tier !== undefined && { tier: input.tier }),
          ...(input.occurred_at !== undefined && {
            occurred_at: input.occurred_at,
          }),
          ...(input.source_id !== undefined && {
            source_id: input.source_id,
          }),
          // Only where a caller explicitly asked to re-type. Every other
          // door refuses a type that disagrees with the row rather than
          // passing one down here.
          ...(input.type !== undefined && { type: input.type }),
        };

        try {
          await tx.update(items).set(setClause).where(whereClause).run();
        } catch (err) {
          if (isSourceDedupViolation(err)) {
            throw new MarfaError(
              ErrorCode.SOURCE_ID_CONFLICT,
              `source_id "${String(input.source_id)}" is already in use under source "${row.source ?? "unknown"}"`,
              { source: row.source, source_id: input.source_id },
            );
          }
          throw err;
        }
        await this.keepKeysInStep(
          tx,
          { id, type: input.type ?? row.type, properties: merged },
          row,
          input.source_id,
          input.blob_proof ?? null,
          incomingProps,
        );

        await this.searchStore.remove(id);
        await this.searchStore.index(id, merged, input.type ?? row.type);

        return rowToItem({
          ...row,
          properties: JSON.stringify(merged),
          version: newVersion,
          updated_at: now,
          tier: newTier,
          ...(input.occurred_at !== undefined && {
            occurred_at: input.occurred_at,
          }),
          ...(input.source_id !== undefined && {
            source_id: input.source_id,
          }),
          // Carried onto the response as well as into the row: built from
          // the pre-update snapshot alone, the response would report the
          // type the item had stopped being, and a re-type would read as
          // having silently done nothing.
          ...(input.type !== undefined && { type: input.type }),
        });
      }

      // Resolve the ancestor version inside the same transaction (passing
      // `tx`) so it's consistent with the item row read above.
      // `input.version` is known-defined here: the omitted and
      // equal-version cases returned in the branch above.
      const ancestor = await this.versionStore.getByVersion(
        id,
        input.version,
        tx,
      );

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
      const clientProps: Record<string, unknown> = replacing
        ? Object.fromEntries(
            Object.entries(incomingProps).filter(([, value]) => value !== null),
          )
        : (incomingProps ?? {});
      const clearedProperties = replacing
        ? Object.keys(ancestor.properties).filter(
            (key) => !Object.hasOwn(clientProps, key),
          )
        : [];

      const result = detectConflict({
        clientProperties: clientProps,
        currentProperties: currentProps,
        ancestorProperties: ancestor.properties,
        clientFields,
        currentFields,
        ancestorFields: ancestor.item_fields,
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
      const movedSince =
        input.type !== undefined && row.type !== ancestor.item_fields.type;

      const ancestorFields = {
        current: snapshotFields,
        ancestor: {
          id,
          tier: (ancestor.item_fields.tier ?? row.tier) as Tier,
          occurred_at: ancestor.item_fields.occurred_at ?? row.occurred_at,
          source_id: ancestor.item_fields.source_id,
          type: ancestor.item_fields.type,
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
          siblingId = conflictedSiblingIdFor(id, input.version, input);
          sibling = await insertConflictedSibling(tx, this.searchStore, {
            siblingId,
            mayCopyEdge: input.may_copy_edge,
            row,
            now,
            proof: input.blob_proof ?? null,
            sent: clientProps,
            properties: conflictedSiblingProperties({
              clientProperties: clientProps,
              currentProperties: currentProps,
              keepBothFields: plan.keepBothFields,
              clearedProperties,
            }),
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

      // What the row ends up holding is judged here against the type it
      // ends up as. The route's prediction was made against the current
      // row, and a stale merge is made against the ancestor: a field the
      // body echoes at the ancestor's value is not applied, so where the
      // other writer removed it since, a move into a type that requires it
      // would land a row that type never admits. Judged only where the
      // write carries properties or a move, as the route judges a current
      // one: a type may gain a required field while rows that lack it
      // stand, and a write that changes nothing a schema has an opinion
      // about is not the write that has to satisfy it.
      const resultingType = input.type ?? row.type;
      const judged = input.properties !== undefined || input.type !== undefined;
      if (judged && getTypeSchema(resultingType)) {
        const validation = validateProperties(
          resultingType,
          resolvedProperties,
        );
        if (!validation.success) {
          throw new MarfaError(
            ErrorCode.INVALID_PROPERTIES,
            "Invalid properties",
            { errors: validation.errors },
          );
        }
      }

      // Same invariant as the fast path above: the version being left behind
      // is snapshotted so a later stale write can merge against it.
      await writeVersion(currentProps);
      const newVersion = row.version + 1;
      const newTier = resolvedFields.tier ?? row.tier;

      const mergeSet: Record<string, unknown> = {
        properties: sql`jsonb(${JSON.stringify(resolvedProperties)})`,
        ...instantColumnValues(resolvedProperties),
        version: newVersion,
        updated_at: now,
        ...(resolvedFields.tier !== undefined && { tier: resolvedFields.tier }),
        ...(resolvedFields.occurred_at !== undefined && {
          occurred_at: resolvedFields.occurred_at,
        }),
        ...(resolvedFields.source_id !== undefined && {
          source_id: resolvedFields.source_id,
        }),
        // A move is applied at a stale version as at the current one, the
        // merged properties having been held to the destination above.
        ...(input.type !== undefined && { type: input.type }),
      };

      try {
        await tx.update(items).set(mergeSet).where(whereClause).run();
      } catch (err) {
        if (isSourceDedupViolation(err)) {
          throw new MarfaError(
            ErrorCode.SOURCE_ID_CONFLICT,
            `source_id "${String(input.source_id)}" is already in use under source "${row.source ?? "unknown"}"`,
            { source: row.source, source_id: input.source_id },
          );
        }
        throw err;
      }
      await this.keepKeysInStep(
        tx,
        { id, type: input.type ?? row.type, properties: resolvedProperties },
        row,
        resolvedFields.source_id ?? undefined,
        input.blob_proof ?? null,
        incomingProps,
      );

      await this.searchStore.remove(id);
      await this.searchStore.index(
        id,
        resolvedProperties,
        input.type ?? row.type,
      );

      return attachResolution(
        rowToItem({
          ...row,
          properties: JSON.stringify(resolvedProperties),
          version: newVersion,
          updated_at: now,
          tier: newTier,
          ...(input.type !== undefined && { type: input.type }),
          // An item's own time is never null on the row, so a resolved
          // value of null is a field the write did not settle rather than
          // one it cleared.
          ...(resolvedFields.occurred_at != null && {
            occurred_at: resolvedFields.occurred_at,
          }),
          ...(resolvedFields.source_id !== undefined && {
            source_id: resolvedFields.source_id,
          }),
        }),
        resolution,
        sibling?.sibling,
        sibling?.edges,
      );
    });
  }

  async delete(id: string, trashedWith?: CascadeRoot): Promise<void> {
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

    const now = new Date().toISOString();
    await this.db
      .update(items)
      .set({
        state: target,
        updated_at: now,
        // The sweep's clock starts here rather than at the modification
        // time, which a later write to the trashed row would move.
        // `softDeleteClock` carries why.
        ...softDeleteClock(row.type, row.state, target, now),
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

  async purge(id: string): Promise<void> {
    const row = await this.getRaw(id);
    if (!row) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    // Purge is the hard delete behind a soft one, so the gate is "already
    // soft-deleted" rather than the literal `trashed` — which a `system.*`
    // row can never reach, and which would therefore make its rows
    // unpurgeable.
    const target = softDeleteState(row.type);
    if (row.state !== target) {
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
    await recordTombstones(this.db, [id], new Date().toISOString());
    // metadata and versions cascade; search index must be removed explicitly.
    await this.db.delete(items).where(eq(items.id, id)).run();

    await this.searchStore.remove(id);
  }

  async bulkPurge(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const unique = Array.from(new Set(ids));
    const scopedWhere = inArray(items.id, unique);

    return await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: items.id, type: items.type, state: items.state })
        .from(items)
        .where(scopedWhere)
        .all();
      // The single purge's gate, judged here so no caller can purge a row
      // that is not soft-deleted, whatever it checked beforehand.
      const scopedIds = rows
        .filter((row) => row.state === softDeleteState(row.type))
        .map((row) => row.id);
      if (scopedIds.length === 0) return [];

      for (const id of scopedIds) {
        await this.searchStore.remove(id);
      }
      await this.rehomeTrashRecords(scopedIds, tx);
      await recordTombstones(tx, scopedIds, new Date().toISOString());
      await tx.delete(items).where(inArray(items.id, scopedIds)).run();
      return scopedIds;
    });
  }

  async purgeTrashedOlderThan(beforeDate: string): Promise<number> {
    const baseConditions = [
      eq(items.state, "trashed"),
      // The window runs from when the row entered the bin, not from when it
      // was last written: `updated_at` moves on any write to a trashed row,
      // a tag or an extension write included, so measuring from it would
      // restart the clock on an edit made in the bin.
      lt(items.trashed_at, beforeDate),
    ];
    const where = and(...baseConditions);

    return await this.db.transaction(async (tx) => {
      const idRows = await tx
        .select({ id: items.id })
        .from(items)
        .where(where)
        .all();
      if (idRows.length === 0) return 0;

      const ids = idRows.map((row) => row.id);
      for (const id of ids) {
        await this.searchStore.remove(id);
      }
      // Edges carry no FK to items, so nothing else ever collects them —
      // without this the background sweep leaves a dangling edge row for
      // every relationship a purged item had. Same statement shape as the
      // bulk-action purge worker.
      // Nothing is announced for any of it, here or in the revoked-grant
      // sweep: `TrashPurger` carries why, and it is a decision rather than
      // an omission.
      await this.rehomeTrashRecords(ids, tx);
      await recordTombstones(tx, ids, new Date().toISOString());
      await tx.delete(edges).where(inArray(edges.source_id, ids)).run();
      await tx.delete(edges).where(inArray(edges.target_id, ids)).run();
      await tx.delete(items).where(inArray(items.id, ids)).run();
      return ids.length;
    });
  }

  async purgeRevokedAppGrantsOlderThan(beforeDate: string): Promise<number> {
    // A grant revoked through the user-facing path keeps
    // `state: "active"`, so this asks `properties` rather than the
    // lifecycle, and `kind = 'app'` keeps the sweep to application grants.
    const where = and(
      eq(items.type, "system.connection"),
      sql`json_extract(${items.properties}, '$.kind') = 'app'`,
      sql`json_extract(${items.properties}, '$.status') = 'revoked'`,
      sql`json_extract(${items.properties}, '$.revoked_at') < ${beforeDate}`,
    );

    return await this.db.transaction(async (tx) => {
      const idRows = await tx
        .select({ id: items.id })
        .from(items)
        .where(where)
        .all();
      if (idRows.length === 0) return 0;

      const ids = idRows.map((row) => row.id);
      for (const id of ids) {
        await this.searchStore.remove(id);
      }
      await tx.delete(edges).where(inArray(edges.source_id, ids)).run();
      await tx.delete(edges).where(inArray(edges.target_id, ids)).run();
      await tx.delete(items).where(inArray(items.id, ids)).run();
      return ids.length;
    });
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

    const now = new Date().toISOString();
    await this.db
      .update(items)
      .set({
        state: "active",
        updated_at: now,
        ...softDeleteClock(row.type, row.state, "active", now),
      })
      .where(eq(items.id, id))
      .run();
    await this.clearTrashRecords(id);

    await this.searchStore.index(id, row.properties, row.type);

    return { ...row, state: "active" as ItemState, updated_at: now };
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

    const now = new Date().toISOString();
    await this.db
      .update(items)
      .set({
        state,
        updated_at: now,
        ...softDeleteClock(row.type, row.state, state, now),
      })
      .where(eq(items.id, id))
      .run();

    if (state === "trashed") {
      await this.searchStore.remove(id);
    } else if (row.state === "trashed") {
      await this.clearTrashRecords(id);
      await this.searchStore.index(id, row.properties, row.type);
    }

    return { ...row, state, updated_at: now };
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
