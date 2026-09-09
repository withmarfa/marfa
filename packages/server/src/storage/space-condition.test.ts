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
  spaceSentinelCondition,
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

/** The clause and the values bound into it. The SQL text alone cannot tell an
 *  `= ''` from an `= undefined`: both render `= ?`, and only the second is a
 *  NULL comparison that matches nothing. */
function compiled(condition: SQL): { sql: string; params: unknown[] } {
  const { sql, params } = new QueryBuilder()
    .select()
    .from(items)
    .where(condition)
    .toSQL();
  const at = sql.indexOf(" where ");
  return { sql: sql.slice(at + " where ".length), params };
}

describe("spaceCondition", () => {
  it("produces no predicate at all for an absent space", () => {
    // The whole decision in one assertion. A caller with no space is the
    // operator tier, so it sees every space rather than only the rows that
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

describe("spaceSentinelCondition", () => {
  it("binds the empty string for an absent space, and never IS NULL", () => {
    // Two failures, not one, and the SQL text only shows the first.
    //
    // `IS NULL` against a `NOT NULL DEFAULT ''` column matches no row and
    // raises nothing. But `eq(column, undefined)` renders the same
    // `= ?` and binds `undefined`, which reaches Postgres as NULL and
    // matches nothing either — so asserting the SQL alone passes against a
    // helper that has lost its `?? ""` entirely. The bound value is what
    // makes this test about the sentinel rather than about the operator.
    for (const absent of [undefined, null]) {
      const { sql, params } = compiled(
        spaceSentinelCondition(items.space_id, absent),
      );
      expect(sql).toBe('"items"."space_id" = ?');
      expect(params).toEqual([""]);
    }
    expect(whereClause(spaceBucketCondition(items.space_id, undefined))).toBe(
      '"items"."space_id" is null',
    );
  });

  it("narrows by equality for a named space, like its sibling", () => {
    const { sql, params } = compiled(
      spaceSentinelCondition(items.space_id, "spc_1"),
    );
    expect(sql).toBe('"items"."space_id" = ?');
    expect(params).toEqual(["spc_1"]);
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
