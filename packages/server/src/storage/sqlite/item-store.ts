import { safeJsonParse } from "../json-utils.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT,
} from "../../page-limits.js";
import {
  eq,
  ne,
  and,
  or,
  lt,
  gt,
  gte,
  desc,
  asc,
  sql,
  inArray,
  getTableColumns,
  type SQL,
} from "drizzle-orm";
import { softDeleteClock } from "../soft-delete-clock.js";
import {
  generateId,
  isValidId,
  getTypeSchema,
  validateProperties,
  validateTransition,
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
import type { SourceFilterSettings } from "../filter-sql.js";
import type { TypeFilter } from "@withmarfa/shared";
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
  ItemStore,
  ResolvedItem,
  ItemFilters,
  SortDirection,
  CursorSortKey,
} from "../interface.js";
import {
  encodeKeyedCursor,
  cursorSortKey,
  decodeKeyedCursorNullable,
  normalizeTimeBound,
  parseSortField,
} from "../interface.js";
import { buildPropertySortExpr, propertySortValue } from "../property-sort.js";
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
import { edges, items, metadata } from "./schema.js";
import type { DrizzleDb } from "./connection.js";
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

function allowedTypesCondition(
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
 * deliberately does not inherit `source_id`: that tuple is unique,
 * and a copy claiming the original's natural key is a second row asserting it
 * is the same upstream record.
 */
async function insertConflictedSibling(
  tx: SqliteTx,
  searchStore: SqliteSearchStore,
  args: {
    siblingId: string;
    row: { type: string; source: string | null; tier: string };
    now: string;
    properties: Record<string, unknown>;
  },
): Promise<Item | null> {
  const { siblingId, row, now, properties } = args;
  const schemaVersion = getTypeSchema(row.type)?.version ?? 1;
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

  await tx
    .insert(metadata)
    .values({
      item_id: siblingId,
      tags: JSON.stringify([CONFLICTED_COPY_TAG]),
    })
    .onConflictDoNothing()
    .run();

  // Everything `create()` does, because this row is a create. Skipping the
  // index left the sibling unfindable by the search that is the ordinary way
  // to go looking for a conflicted copy.
  await searchStore.index(siblingId, properties, row.type);

  return {
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
  } satisfies Item;
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
      // to transient and retries forever. This refusal used to be the only
      // properties-versus-type mismatch answering `validation_error` --
      // creating an item, upserting onto a new natural key and bulk-writing
      // all reach it -- while the update, retype and strict-mode paths
      // raised `invalid_properties` from the route layer for the identical
      // failure. One failure cannot have two names and still be classified.
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

      const schemaVersion = getTypeSchema(input.type)?.version ?? 1;

      try {
        await tx
          .insert(items)
          .values({
            id,
            type: input.type,
            state,
            // A create can name its own state, and an archive restore names
            // `trashed` for a row that was in the bin when the archive was
            // taken. Stamping here rather than leaving it null means such a
            // row's retention window starts where every other trashed row's
            // does, instead of falling back to a modification time a later
            // edit would move.
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
            device: input.device,
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

      await this.searchStore.index(id, properties, input.type);

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
        ...(input.device != null && { device: input.device }),
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

  async list(filters: ItemFilters): Promise<PaginatedResult<Item>> {
    // A catch-up read owns its own ordering. `updated_after` is only
    // resumable over `(updated_at, id)` ascending — that is the order the
    // cursor walks and the order the index is built for — so the filter
    // implies it here rather than trusting every caller to ask for it.
    // The route refuses a request that asks for both this filter and a
    // contradicting sort, so the override below is never a caller's
    // explicit choice being discarded; holding the invariant in the store
    // as well is what makes it true for internal callers too.
    //
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

    // One test of the field decides both the ordering and the bound. Two
    // tests is what let an empty value order by `(updated_at, id)`
    // ascending and bound nothing, so a request that asked for a narrow
    // catch-up walked the whole corpus instead.
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
    const cursorKey: CursorSortKey = cursorSortKey(sort, dir);
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

    const conditions: (SQL | undefined)[] = [];

    if (filters.state) {
      conditions.push(eq(items.state, filters.state));
    } else if (!filters.all_states) {
      // The default hides the bin. `all_states` suppresses that and adds
      // nothing else: a catch-up has to see a row go to the bin, because
      // that transition is how a client learns to prune its local copy,
      // and a listing that moves the modification time and then hides the
      // row reports that nothing changed.
      conditions.push(ne(items.state, "trashed"));
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
      const filterConds = filterToSqlConditions(expr, items);
      if (expr.logical === "OR") {
        const orClause = or(...filterConds);
        if (orClause) conditions.push(orClause);
      } else {
        conditions.push(...filterConds);
      }
    }

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

    return { data, cursor, has_more: hasMore };
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

      const currentProps = safeJsonParse<Record<string, unknown>>(
        row.properties,
        {},
        "item update properties",
      );
      const incomingProps = resolveIncomingProperties(
        row.type,
        input.properties,
        input.null_clears === true,
      );
      const now = new Date().toISOString();
      const deviceId = row.device ?? undefined;

      // The version store's own write, inside this transaction, so the
      // snapshot and the update it records land together or not at all.
      const writeVersion = async (
        propertiesToSnapshot: Record<string, unknown>,
      ) => {
        await this.versionStore.create(
          id,
          row.version,
          propertiesToSnapshot,
          deviceId,
          tx,
        );
      };

      if (input.version === undefined || row.version === input.version) {
        // Every version-incrementing write snapshots the state it is leaving
        // behind. Three-way merge resolves a stale write against the snapshot
        // at the version the client sent, so a version that passed without
        // one can never be merged against: the server declares every
        // submitted field in conflict instead. A time-based throttle here
        // made that the common case rather than the rare one, because two
        // devices editing within the window is ordinary use. Volume is the
        // version thinner's problem, not this write's.
        await writeVersion(currentProps);

        const merged = mergeUpdateProperties(
          currentProps,
          incomingProps,
          input.null_clears === true,
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
          // Carried onto the response as well as into the row. Built from
          // the pre-update snapshot, this reported the type the item had
          // stopped being — a write that landed and answered with the old
          // value, which reads as the re-type having silently done nothing.
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
        return ancestorUnavailable(row.version, currentProps, input.version);
      }

      const result = detectConflict({
        clientProperties: incomingProps ?? {},
        currentProperties: currentProps,
        ancestorProperties: ancestor.properties,
      });

      const policy = resolveMergePolicy(row.type, (id) => getTypeSchema(id));

      // What the row ends up holding: the detector's merge when nothing
      // collided, the policy's resolution when something did and the caller
      // asked the server to resolve it.
      let resolvedProperties: Record<string, unknown>;
      let resolution: ConflictResolutionReport | undefined;
      // Null on the idempotent retry, where the row already existed.
      let sibling: Item | null = null;

      if (result.type === "conflict") {
        if (input.conflict_mode !== "auto") {
          return versionConflict(
            row.version,
            currentProps,
            input.version,
            ancestor.properties,
            result.conflicting_fields,
            policy,
          );
        }

        const plan = planAutoMerge({
          clientProperties: incomingProps ?? {},
          currentProperties: currentProps,
          ancestorProperties: ancestor.properties,
          conflictingFields: result.conflicting_fields,
          policy,
        });

        // The sibling is written here, inside the transaction that moves the
        // original on. A client doing this in two writes has no arrangement
        // that is atomic: dying between them leaves the losing edit nowhere
        // and the original already past it.
        let siblingId: string | undefined;
        if (plan.keepBothFields.length > 0) {
          siblingId = conflictedSiblingIdFor(id, input.version, input);
          sibling = await insertConflictedSibling(tx, this.searchStore, {
            siblingId,
            row,
            now,
            properties: conflictedSiblingProperties({
              clientProperties: incomingProps ?? {},
              currentProperties: currentProps,
              keepBothFields: plan.keepBothFields,
            }),
          });
        }

        resolvedProperties = plan.merged;
        resolution = {
          fields: result.conflicting_fields,
          strategy: plan.strategyByField,
          ...(siblingId !== undefined && { conflicted_copy_id: siblingId }),
        };
      } else {
        resolvedProperties = result.merged;
      }

      // Same invariant as the fast path above: the version being left behind
      // is snapshotted so a later stale write can merge against it.
      await writeVersion(currentProps);
      const newVersion = row.version + 1;
      const newTier = input.tier ?? row.tier;

      const mergeSet: Record<string, unknown> = {
        properties: sql`jsonb(${JSON.stringify(resolvedProperties)})`,
        ...instantColumnValues(resolvedProperties),
        version: newVersion,
        updated_at: now,
        ...(input.tier !== undefined && { tier: input.tier }),
        ...(input.occurred_at !== undefined && {
          occurred_at: input.occurred_at,
        }),
        ...(input.source_id !== undefined && {
          source_id: input.source_id,
        }),
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

      await this.searchStore.remove(id);
      await this.searchStore.index(id, resolvedProperties, row.type);

      return attachResolution(
        rowToItem({
          ...row,
          properties: JSON.stringify(resolvedProperties),
          version: newVersion,
          updated_at: now,
          tier: newTier,
          ...(input.occurred_at !== undefined && {
            occurred_at: input.occurred_at,
          }),
          ...(input.source_id !== undefined && {
            source_id: input.source_id,
          }),
        }),
        resolution,
        sibling ?? undefined,
      );
    });
  }

  async delete(id: string): Promise<void> {
    const row = await this.getRaw(id);
    if (!row) {
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    // A soft delete is a transition, so it goes through the same gate the
    // explicit transition route uses. Writing `trashed` unconditionally put
    // `system.*` rows into a state their own lifecycle does not contain:
    // no transition could produce it, no transition could leave it, and the
    // default listing hides trashed rows, so the result was invisible until
    // someone enumerated every state by hand.
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
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Only ${target} items can be purged`,
      );
    }

    // metadata and versions cascade; search index must be removed explicitly.
    await this.db.delete(items).where(eq(items.id, id)).run();

    await this.searchStore.remove(id);
  }

  async bulkPurge(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const unique = Array.from(new Set(ids));
    const scopedWhere = inArray(items.id, unique);

    return await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: items.id })
        .from(items)
        .where(scopedWhere)
        .all();
      const scopedIds = rows.map((row) => row.id);
      if (scopedIds.length === 0) return 0;

      for (const id of scopedIds) {
        await this.searchStore.remove(id);
      }
      await tx.delete(items).where(inArray(items.id, scopedIds)).run();
      return scopedIds.length;
    });
  }

  async purgeTrashedOlderThan(beforeDate: string): Promise<number> {
    const baseConditions = [
      eq(items.state, "trashed"),
      // The window runs from when the row entered the bin, not from when it
      // was last written. `updated_at` was standing in for that, and it moves
      // on any write to a trashed row — a tag or an extension write included
      // — so editing something already in the bin restarted its clock.
      //
      // `updated_at` survives as the fallback for a row carrying no stamp,
      // which after the backfill can only be one soft-deleted by a build
      // predating the column: a replica still rolling, or a soft delete that
      // landed while the migration was in flight. Falling back reproduces
      // exactly the behavior those rows have today, which is worse than the
      // stamp and far better than a row nothing can ever purge.
      lt(sql`COALESCE(${items.trashed_at}, ${items.updated_at})`, beforeDate),
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
      // Nothing is announced for any of it, here or in the two sibling
      // sweeps: `TrashPurger` carries why, and it is a decision rather
      // than an omission.
      await tx.delete(edges).where(inArray(edges.source_id, ids)).run();
      await tx.delete(edges).where(inArray(edges.target_id, ids)).run();
      await tx.delete(items).where(inArray(items.id, ids)).run();
      return ids.length;
    });
  }

  async purgeActivityOlderThan(beforeDate: string): Promise<number> {
    // The PG copy carries the reasoning: activity rows are `active` and
    // never trashed, so the trash sweep's predicate cannot serve.
    const baseConditions = [
      eq(items.type, "system.activity"),
      lt(items.created_at, beforeDate),
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
      // items_fts is a separate virtual table here, so unlike PG it needs
      // cleaning by hand.
      for (const id of ids) {
        await this.searchStore.remove(id);
      }
      await tx.delete(edges).where(inArray(edges.source_id, ids)).run();
      await tx.delete(edges).where(inArray(edges.target_id, ids)).run();
      await tx.delete(items).where(inArray(items.id, ids)).run();
      return ids.length;
    });
  }

  async purgeRevokedAppGrantsOlderThan(beforeDate: string): Promise<number> {
    // The PG copy carries the reasoning: a grant revoked through the
    // user-facing path keeps `state: "active"`, so this asks `properties`
    // rather than the lifecycle, and `kind = 'app'` keeps an integration
    // uninstall's routine `revoked` row out of a tombstone sweep.
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
    // above and `transition()` below already use. Writing `active`
    // unconditionally made this the one of four write paths that skipped the
    // graph, and a gate three paths apply and the fourth does not survives
    // review indefinitely because each path reads correctly on its own.
    //
    // What it stops is specific: `trashed` is not in the `system.*`
    // lifecycle, so a `system.connection` that somehow holds it must not be
    // able to walk out into `active` having passed no transition the graph
    // admits. The check lives here rather than in the route because keeping
    // the three siblings side by side is what stops them drifting again.
    // Its companion — refusing to create such a row in the first place —
    // deliberately sits at the route layer instead; see `POST /items` in
    // `routes/items.ts` for why `create` must stay permissive.
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

    await this.searchStore.index(id, row.properties, row.type);

    return { ...row, state: "active" as ItemState, updated_at: now };
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

    // State transitions always snapshot current properties.
    await this.versionStore.create(
      id,
      row.version,
      row.properties,
      row.device ?? undefined,
    );

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
    typeFilter?: TypeFilter,
    sourceFilter?: SourceFilterSettings,
    by: ItemStatsAxis = "state",
  ): Promise<Record<string, number>> {
    const conditions: (SQL | undefined)[] = [];
    const typeClause = allowedTypesCondition(
      typeFilter?.allowed,
      typeFilter?.excluded,
    );
    if (typeClause) conditions.push(typeClause);
    // Counts have to agree with the listing they summarize, so the read
    // lever applies here too.
    const sourceLever = sourceFilterToSql(
      sourceFilter,
      items.type,
      items.source,
    );
    if (sourceLever) conditions.push(sourceLever);

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
