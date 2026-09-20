/**
 * A permission map measured against another permission map.
 *
 * **The ceiling question is not the grant question, and answering it with the
 * grant machinery is fail-open.** A grant is a list of literals, so "does this
 * cover that" is answered per literal. A permission map ranks an exact entry
 * above every wildcard, so it can deny a row rather than omit one — and a list
 * has no way to say that. Reduce a map to the literals it confers and every
 * `none` disappears, which is exactly the entries that were holding a wildcard
 * down.
 *
 * That is not a corner. `content:read` — the most ordinary grant there is —
 * projects to a map with a global `read` and a `none` on every system type, so
 * the shape is the common one rather than a constructed edge case.
 */
import { describe, it, expect } from "vitest";
import { firstReachBeyondMap, scopesToTypePermissions } from "./scopes.js";

describe("firstReachBeyondMap on the type axis", () => {
  it("refuses a wildcard that erases a denial the held map carries", () => {
    // The escalation this function exists for. The request reads as a no-op
    // and is a widening: the same wildcard, minus the entries beneath it.
    const held = { "*": "read", "system.credential": "none" } as const;
    expect(firstReachBeyondMap("type", held, { "*": "read" })).toBe(
      "system.credential",
    );
  });

  it("is the real shape of a content grant, not a constructed one", () => {
    const held = scopesToTypePermissions(["content:read"]);
    expect(Object.values(held)).toContain("none");
    const beyond = firstReachBeyondMap("type", held, { "*": "read" });
    expect(beyond).not.toBe(null);
  });

  it("passes a map against itself", () => {
    // The default mint takes the creator's maps wholesale, so identity has to
    // be covered or no key could be minted without naming every family.
    const held = scopesToTypePermissions(["content:read"]);
    expect(firstReachBeyondMap("type", held, held)).toBe(null);
  });

  it("passes a narrowing", () => {
    expect(
      firstReachBeyondMap(
        "type",
        { "*": "read" },
        { "*": "read", "core.note": "none" },
      ),
    ).toBe(null);
    expect(firstReachBeyondMap("type", { "core.note": "read" }, {})).toBe(null);
  });

  it("refuses a level above the held one on a type the held map names", () => {
    expect(
      firstReachBeyondMap(
        "type",
        { "core.note": "read" },
        { "core.note": "write" },
      ),
    ).toBe("core.note");
  });

  it("refuses a subtree the held map only denies deeper in", () => {
    expect(
      firstReachBeyondMap(
        "type",
        { "core.*": "read", "core.note": "none" },
        { "core.*": "read" },
      ),
    ).toBe("core.note");
  });

  it("refuses a wildcard wider than a concrete grant", () => {
    expect(
      firstReachBeyondMap("type", { "core.note": "write" }, { "*": "read" }),
    ).toBe("*");
  });

  it("does not refuse a subtree the held map covers from above", () => {
    expect(
      firstReachBeyondMap("type", { "*": "write" }, { "core.*": "write" }),
    ).toBe(null);
  });

  it("catches a subtree denial the requested map reaches around", () => {
    // Held denies everything under `a`; requested grants globally and names
    // only a narrower denial, so real types under `a` escalate.
    expect(
      firstReachBeyondMap(
        "type",
        { "*": "read", "a.*": "none" },
        { "*": "read", "a.b": "none" },
      ),
    ).not.toBe(null);
  });

  it("treats the parent of a subtree wildcard as covered by it", () => {
    // `core.*` is parent-inclusive on both sides, so `core` itself must not
    // read as a widening.
    expect(
      firstReachBeyondMap("type", { "core.*": "read" }, { "core.*": "read" }),
    ).toBe(null);
    expect(
      firstReachBeyondMap("type", { "core.*": "read" }, { core: "read" }),
    ).toBe(null);
  });
});

describe("firstReachBeyondMap on the leveled axes", () => {
  it("refuses a level above the held one", () => {
    expect(firstReachBeyondMap("edge", { "*": "read" }, { "*": "write" })).toBe(
      "*",
    );
    expect(
      firstReachBeyondMap("metadata", { types: "read" }, { types: "write" }),
    ).toBe("types");
    expect(
      firstReachBeyondMap("profile", { "*": "read" }, { handle: "write" }),
    ).toBe("handle");
  });

  it("passes what the held map covers", () => {
    expect(
      firstReachBeyondMap("edge", { "*": "write" }, { references: "read" }),
    ).toBe(null);
    expect(
      firstReachBeyondMap("metadata", { "*": "write" }, { types: "write" }),
    ).toBe(null);
    expect(
      firstReachBeyondMap("profile", { "*": "write" }, { handle: "read" }),
    ).toBe(null);
  });

  it("refuses a namespace the held map does not name at all", () => {
    expect(firstReachBeyondMap("edge", {}, { references: "read" })).toBe(
      "references",
    );
    expect(firstReachBeyondMap("profile", {}, { handle: "read" })).toBe(
      "handle",
    );
  });

  it("keeps each axis to itself", () => {
    // A type key of `metadata` used to project to the literal `metadata:write`
    // and land in the metadata family, so a type entry conferred a metadata
    // grant. Comparing maps per axis has nowhere for that to happen.
    expect(firstReachBeyondMap("metadata", {}, { "*": "write" })).toBe("*");
  });
});
