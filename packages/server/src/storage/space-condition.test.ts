/**
 * The decision, pinned.
 *
 * `spaceId: undefined` used to mean "no fence" in four stores and
 * `space_id IS NULL` in a fifth, and nothing anywhere said which was
 * intended. These assertions are the statement of which one won.
 *
 * They compare rendered SQL rather than asserting a predicate came back at
 * all. Definedness cannot tell `= ?` from `is null`, so an implementation
 * that answered `isNull` for a named space — the exact confusion this
 * module exists to end — would satisfy every one of them.
 */
import { describe, it, expect } from "vitest";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";
import { items } from "./sqlite/schema.js";
import {
  spaceBucketCondition,
  spaceCondition,
  spaceOrPlatformCondition,
} from "./space-condition.js";

/** The WHERE clause a condition renders to, or `null` when there is none.
 *  `QueryBuilder` needs no connection, so this stays a unit test. */
function whereClause(condition: SQL | undefined): string | null {
  if (condition === undefined) return null;
  const { sql } = new QueryBuilder()
    .select()
    .from(items)
    .where(condition)
    .toSQL();
  const at = sql.indexOf(" where ");
  return at === -1 ? null : sql.slice(at + " where ".length);
}

describe("spaceCondition", () => {
  it("produces no predicate at all for an absent space", () => {
    // The whole decision in one assertion. A caller with no space is the
    // platform tier, so it sees every space rather than only the rows that
    // belong to none.
    expect(whereClause(spaceCondition(items.space_id, undefined))).toBeNull();
  });

  it("narrows to the space-less rows only when asked with an explicit null", () => {
    expect(whereClause(spaceCondition(items.space_id, null))).toBe(
      '"items"."space_id" is null',
    );
  });

  it("narrows to a named space by equality", () => {
    expect(whereClause(spaceCondition(items.space_id, "spc_1"))).toBe(
      '"items"."space_id" = ?',
    );
  });
});

describe("spaceBucketCondition", () => {
  it("treats an absent space as the space-less bucket", () => {
    // The inverse of the decision above, deliberately, and named so that
    // choosing it is visible. A source name unique within a space has to be
    // compared against one domain, and the space-less rows are a domain.
    expect(whereClause(spaceBucketCondition(items.space_id, undefined))).toBe(
      '"items"."space_id" is null',
    );
    expect(whereClause(spaceBucketCondition(items.space_id, null))).toBe(
      '"items"."space_id" is null',
    );
  });

  it("still narrows by equality for a named space", () => {
    expect(whereClause(spaceBucketCondition(items.space_id, "spc_1"))).toBe(
      '"items"."space_id" = ?',
    );
  });
});

describe("spaceOrPlatformCondition", () => {
  it("follows the fence when there is no space to widen from", () => {
    // The widening is a widening of a fence, not a replacement for one:
    // with no space named there is nothing narrower to widen.
    expect(
      whereClause(spaceOrPlatformCondition(items.space_id, undefined)),
    ).toBeNull();
  });

  it("admits the named space and the platform-scoped rows, and nothing else", () => {
    expect(whereClause(spaceOrPlatformCondition(items.space_id, "spc_1"))).toBe(
      '("items"."space_id" = ? or "items"."space_id" is null)',
    );
  });
});
