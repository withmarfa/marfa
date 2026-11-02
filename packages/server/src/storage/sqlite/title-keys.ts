import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  MAX_RESOLUTION_DEPTH,
  getTypeSchema,
  isSystemType,
  listTypes,
} from "@withmarfa/shared";
import type { DrizzleDb } from "./connection.js";
import type { SqliteTxContext } from "./request-context.js";

type Executor = DrizzleDb | SqliteTxContext;

/**
 * The longest name, in UTF-16 code units, that `POST /items/titles` takes
 * and the longest title that has a key. A name is a few words, and a title
 * past this is a body typed into the wrong field.
 */
export const MAX_NAME_UNITS = 1000;

const WHITE_SPACE = /^\p{White_Space}$/u;

/** The name without the Unicode `White_Space` at either end. */
export function trimName(text: string): string {
  // No `White_Space` code point is outside the Basic Multilingual Plane, so
  // a scan by UTF-16 unit finds the same edges.
  let start = 0;
  let end = text.length;
  while (start < end && WHITE_SPACE.test(text.charAt(start))) start += 1;
  while (end > start && WHITE_SPACE.test(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/**
 * A name as the core's `names::folded` makes it: trimmed of Unicode
 * `White_Space`, in NFC, lowercased one code point at a time with no context
 * rule (so a final sigma stays `σ`), and in NFC again.
 * `conformance/fixtures/name-fold.json` holds both implementations to the
 * same cases.
 */
export function foldName(text: string): string {
  let lowered = "";
  for (const point of trimName(text).normalize("NFC")) {
    lowered += point.toLowerCase();
  }
  return lowered.normalize("NFC");
}

interface TitleHints {
  parent?: string | undefined;
  display_hints?: { title_field?: string | undefined } | undefined;
}

/**
 * The property a type's items are titled by: the nearest `title_field` in its
 * chain, and `title` where none sets one or the chain cannot be walked.
 */
export function titleFieldIn(
  type: string,
  lookup: (id: string) => TitleHints | undefined,
): string {
  const seen = new Set<string>();
  let at = lookup(type);
  let id: string | undefined = type;
  while (at !== undefined && id !== undefined) {
    if (seen.has(id) || seen.size >= MAX_RESOLUTION_DEPTH) return "title";
    seen.add(id);
    const field = at.display_hints?.title_field;
    if (field !== undefined) return field;
    id = at.parent;
    at = id === undefined ? undefined : lookup(id);
  }
  return "title";
}

export function titleFieldOf(type: string): string {
  return titleFieldIn(type, getTypeSchema);
}

/**
 * What an item is found by: its title folded, or `null` for an item with no
 * key (a `system.*` item, or one with no text in its title property).
 */
export function titleKeyFrom(
  type: string,
  field: string,
  properties: Record<string, unknown>,
): string | null {
  if (isSystemType(type)) return null;
  const title = properties[field];
  if (typeof title !== "string") return null;
  const trimmed = trimName(title);
  return trimmed === "" || trimmed.length > MAX_NAME_UNITS
    ? null
    : foldName(trimmed);
}

export function titleKeyOf(
  type: string,
  properties: Record<string, unknown>,
): string | null {
  return titleKeyFrom(type, titleFieldOf(type), properties);
}

/** Brings the item's key in step with the type and properties it now holds. */
export async function syncTitleKey(
  db: Executor,
  row: { id: string; type: string; properties: Record<string, unknown> },
): Promise<void> {
  const key = titleKeyOf(row.type, row.properties);
  if (key === null) {
    await db.run(sql`DELETE FROM item_title_keys WHERE item_id = ${row.id}`);
    return;
  }
  await db.run(sql`
    INSERT INTO item_title_keys (item_id, title_key) VALUES (${row.id}, ${key})
    ON CONFLICT (item_id) DO UPDATE SET title_key = excluded.title_key
  `);
}

/**
 * Makes the keys of every item of `type` again, under the property the
 * registry now titles it by. A key is decided when the row is written, so a
 * registry change that moves `title_field` leaves the stored keys by the old
 * property until this runs. `reindexChangedTypes` calls it for each type
 * whose title property moved, in the transaction that made the change. A row
 * in the bin keeps its key, so it is made again too.
 */
export async function rekeyType(db: Executor, type: string): Promise<void> {
  const rows = await db.all<{ id: string; properties: string }>(sql`
    SELECT id, json(properties) AS properties FROM items WHERE type = ${type}
  `);
  for (const row of rows) {
    await syncTitleKey(db, {
      id: row.id,
      type,
      properties: JSON.parse(row.properties) as Record<string, unknown>,
    });
  }
}

/**
 * The text of an item's title, as the property its type is titled by holds
 * it, and null where that is not text. A type no `title_field` reaches is
 * titled by `title`, as is one the registry does not hold.
 */
export function titleTextSql(
  typeColumn: SQLWrapper,
  properties: SQLWrapper,
): SQL {
  const text = (field: string): SQL => {
    const path = `$.${JSON.stringify(field)}`;
    return sql`CASE WHEN json_type(${properties}, ${path}) = 'text' THEN json_extract(${properties}, ${path}) END`;
  };
  const byField = new Map<string, string[]>();
  for (const { id } of listTypes()) {
    const field = titleFieldOf(id);
    if (field === "title") continue;
    byField.set(field, [...(byField.get(field) ?? []), id]);
  }
  if (byField.size === 0) return text("title");
  const cases = [...byField].map(
    ([field, ids]) =>
      sql`WHEN ${typeColumn} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}) THEN ${text(field)}`,
  );
  return sql`CASE ${sql.join(cases, sql` `)} ELSE ${text("title")} END`;
}
