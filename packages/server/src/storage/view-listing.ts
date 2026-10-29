/**
 * What a saved view lists, as SQL: its sort, the keyset position a cursor
 * names, and the `parent-of` subtree of its `beneath`. The working copy
 * evaluates the same view in `core/marfa-core/src/views.rs`, and the device
 * fixture `views-items-live.test.ts` holds the two to one answer, so a change
 * to an ordering rule here is a change there.
 */
import {
  and,
  asc,
  desc,
  gt,
  lt,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  ErrorCode,
  MarfaError,
  getTypeSchema,
  listTypes,
} from "@withmarfa/shared";
import {
  decodeKeyedCursor,
  encodeKeyedCursor,
  type ViewListing,
  type ViewSortKey,
} from "./interface.js";
import { resolveTypeSchema } from "./policy.js";
import { buildPropertySortExpr } from "./property-sort.js";
import { items } from "./sqlite/schema.js";

type Direction = "asc" | "desc";

interface Term {
  expr: SQL;
  direction: Direction;
  /** Whether the expression can be `NULL`, which sorts after every value. */
  nullable: boolean;
}

export interface ViewOrder {
  terms: Term[];
  /** The direction `items.id` breaks a tie in. */
  tie: Direction;
}

export const PARENT_OF = "parent-of";

const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIMESTAMPS: ReadonlySet<string> = new Set([
  "created_at",
  "updated_at",
  "occurred_at",
]);

function refuse(message: string): MarfaError {
  return new MarfaError(ErrorCode.VALIDATION_ERROR, message);
}

function propertyExpr(name: string): SQL {
  return buildPropertySortExpr(items.properties, name);
}

function propertyName(by: string): string {
  const name = by.slice("properties.".length);
  if (!PROPERTY_NAME.test(name)) {
    throw refuse(`Invalid property field "${by}"`);
  }
  return name;
}

/**
 * An item's title is the property its type's `title_field` names, from the
 * nearest type in its chain that sets one, and `title` where none does.
 */
function titleExpr(): SQL {
  const typesByField = new Map<string, string[]>();
  for (const schema of listTypes()) {
    let field: string | undefined;
    try {
      field = resolveTypeSchema(schema.id, getTypeSchema)?.display_hints
        ?.title_field;
    } catch {
      // A chain that cannot be walked titles by `title`, as it does on a read.
    }
    if (field === undefined || field === "title") continue;
    const group = typesByField.get(field);
    if (group) group.push(schema.id);
    else typesByField.set(field, [schema.id]);
  }
  const cases = [...typesByField].map(
    ([field, ids]) =>
      sql`WHEN ${items.type} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}) THEN ${propertyExpr(field)}`,
  );
  if (cases.length === 0) return propertyExpr("title");
  return sql`CASE ${sql.join(cases, sql` `)} ELSE ${propertyExpr("title")} END`;
}

function term(by: string, direction: Direction): Term {
  if (by.startsWith("properties.")) {
    return { expr: propertyExpr(propertyName(by)), direction, nullable: true };
  }
  switch (by) {
    case "created_at":
    case "updated_at":
    case "occurred_at":
    case "type":
    case "state":
    case "tier":
      return { expr: sql`${items[by]}`, direction, nullable: false };
    case "title":
      return { expr: titleExpr(), direction, nullable: true };
    case "tags":
      return {
        expr: sql`(SELECT min(je.value) FROM metadata m, json_each(m.tags) je WHERE m.item_id = ${items.id})`,
        direction,
        nullable: true,
      };
    default:
      throw refuse(`Unsupported view field "${by}"`);
  }
}

/**
 * The order a view lists in: its keys, first key first, an absent value after
 * every present one in either direction, then `items.id` ascending. A view
 * with no keys lists the newest `occurred_at` first, and one key on a time
 * breaks a tie in that key's direction.
 */
export function viewOrder(keys: readonly ViewSortKey[]): ViewOrder {
  if (keys.length > 10) throw refuse("A view accepts at most 10 sort keys");
  if (keys.length === 0) {
    return {
      terms: [term("occurred_at", "desc")],
      tie: "desc",
    };
  }
  const [only] = keys;
  return {
    terms: keys.map((key) => term(key.by, key.direction)),
    tie:
      keys.length === 1 && only !== undefined && TIMESTAMPS.has(only.by)
        ? only.direction
        : "asc",
  };
}

/** `ORDER BY` terms, in the order they apply. */
export function orderBy(order: ViewOrder): SQL[] {
  const clauses: SQL[] = [];
  for (const { expr, direction, nullable } of order.terms) {
    if (nullable) clauses.push(sql`${expr} IS NULL`);
    clauses.push(direction === "asc" ? asc(expr) : desc(expr));
  }
  clauses.push(order.tie === "asc" ? asc(items.id) : desc(items.id));
  return clauses;
}

type KeyValue = string | number | null;

/**
 * The cursor names the view and the version of it that issued it, so any
 * change to the view, its sort and query among them, refuses an old cursor.
 */
function cursorKey(view: Pick<ViewListing, "id" | "version">): string {
  return `view-items:${view.id}:${String(view.version)}`;
}

export function keyValue(raw: unknown): KeyValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  throw new Error("A view sort value is not a string, a finite number or null");
}

export function encodeViewCursor(
  view: Pick<ViewListing, "id" | "version">,
  values: readonly KeyValue[],
  id: string,
): string {
  return encodeKeyedCursor(JSON.stringify(values), id, cursorKey(view));
}

function malformedCursor(): MarfaError {
  return new MarfaError(
    ErrorCode.VALIDATION_ERROR,
    "Invalid pagination cursor",
  );
}

/**
 * The rows after the position a cursor names, in `order`. Each key
 * contributes a branch where every key before it ties and it is the first to
 * differ, and the last branch is a full tie broken by `items.id`.
 */
export function afterCursor(
  view: Pick<ViewListing, "id" | "version">,
  order: ViewOrder,
  cursor: string,
): SQL {
  const { v, id } = decodeKeyedCursor(cursor, cursorKey(view));
  let values: unknown;
  try {
    values = JSON.parse(v);
  } catch {
    throw malformedCursor();
  }
  if (
    !Array.isArray(values) ||
    values.length !== order.terms.length ||
    !values.every(
      (value) =>
        value === null ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value)),
    )
  ) {
    throw malformedCursor();
  }
  const held = values as KeyValue[];
  const branches: (SQL | undefined)[] = [];
  const tied: SQL[] = [];
  order.terms.forEach((t, i) => {
    const value = held[i] ?? null;
    if (value !== null) {
      const past =
        t.direction === "asc"
          ? sql`${t.expr} > ${value}`
          : sql`${t.expr} < ${value}`;
      branches.push(
        and(...tied, t.nullable ? sql`(${t.expr} IS NULL OR ${past})` : past),
      );
    }
    tied.push(sql`${t.expr} IS ${value}`);
  });
  branches.push(
    and(...tied, order.tie === "asc" ? gt(items.id, id) : lt(items.id, id)),
  );
  const after = or(...branches);
  if (after === undefined) throw malformedCursor();
  return after;
}

/**
 * The rows at `root` and beneath it by `parent-of`, at any depth. The walk
 * passes only through rows `readable` admits, so a row the reader cannot read
 * joins no path, and a set rather than a list ends it on a cycle.
 */
export function beneathSql(
  root: string,
  readable: (type: SQLWrapper, source: SQLWrapper) => SQL | undefined,
): SQL {
  const through = readable(sql`s.type`, sql`s.source`);
  return sql`${items.id} IN (WITH RECURSIVE beneath(id) AS (
    SELECT ${root}
    UNION
    SELECT e.target_id FROM edges e
      JOIN beneath b ON e.source_id = b.id
      JOIN items s ON s.id = e.source_id
      WHERE e.edge_type = ${PARENT_OF}${through ? sql` AND ${through}` : sql``}
  ) SELECT id FROM beneath)`;
}
