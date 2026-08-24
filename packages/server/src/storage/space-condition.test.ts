/**
 * The decision, pinned.
 *
 * `spaceId: undefined` used to mean "no fence" in four stores and
 * `space_id IS NULL` in a fifth, and nothing anywhere said which was
 * intended. These assertions are the statement of which one won, in a form
 * that fails if somebody quietly changes it back.
 */
import { describe, it, expect } from "vitest";
import { items } from "./sqlite/schema.js";
import {
  spaceBucketCondition,
  spaceCondition,
  spaceOrPlatformCondition,
} from "./space-condition.js";

describe("spaceCondition", () => {
  it("produces no predicate at all for an absent space", () => {
    // The whole decision in one assertion. A caller with no space is the
    // platform tier, so it sees every space rather than only the rows that
    // belong to none.
    expect(spaceCondition(items.space_id, undefined)).toBeUndefined();
  });

  it("narrows to the space-less rows only when asked with an explicit null", () => {
    expect(spaceCondition(items.space_id, null)).toBeDefined();
  });

  it("narrows to a named space", () => {
    expect(spaceCondition(items.space_id, "spc_1")).toBeDefined();
  });
});

describe("spaceBucketCondition", () => {
  it("always produces a predicate, so a uniqueness check is never unbounded", () => {
    // The inverse of the decision above, deliberately, and named so that
    // choosing it is visible. A source name unique within a space has to be
    // compared against one domain, and the space-less rows are a domain.
    expect(spaceBucketCondition(items.space_id, undefined)).toBeDefined();
    expect(spaceBucketCondition(items.space_id, null)).toBeDefined();
    expect(spaceBucketCondition(items.space_id, "spc_1")).toBeDefined();
  });
});

describe("spaceOrPlatformCondition", () => {
  it("follows the fence when there is no space to widen from", () => {
    // The widening is a widening of a fence, not a replacement for one:
    // with no space named there is nothing narrower to widen.
    expect(spaceOrPlatformCondition(items.space_id, undefined)).toBeUndefined();
  });

  it("produces a predicate for a named space", () => {
    expect(spaceOrPlatformCondition(items.space_id, "spc_1")).toBeDefined();
  });
});
