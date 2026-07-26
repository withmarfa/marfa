import { describe, expect, it } from "vitest";
import {
  subtreeWildcardRoot,
  typeMatchesPattern,
  typePatternToSql,
} from "./type-patterns.js";
import { matchesTypePattern, resolveTypePermission } from "./validation.js";
import { expandWildcardScopes } from "./scopes.js";

// One table, four consumers. Each of these gates used to answer the
// parent-inclusion question on its own, and they did not agree: a credential
// holding `core.media.*` was admitted to `core.media` by the consent screen's
// expansion and denied by the permission map. The table is the contract; every
// consumer is asserted against it.
const CASES: {
  pattern: string;
  type: string;
  matches: boolean;
  why: string;
}[] = [
  { pattern: "*", type: "core.note", matches: true, why: "global wildcard" },
  {
    pattern: "*",
    type: "system.credential",
    matches: true,
    why: "global wildcard reaches reserved namespaces",
  },
  {
    pattern: "core.note",
    type: "core.note",
    matches: true,
    why: "exact identifier",
  },
  {
    pattern: "core.note",
    type: "core.notes",
    matches: false,
    why: "exact identifier is not a prefix",
  },
  {
    pattern: "core.media.*",
    type: "core.media.book",
    matches: true,
    why: "descendant",
  },
  {
    pattern: "core.media.*",
    type: "core.media",
    matches: true,
    why: "parent-inclusive: the subtree includes its root",
  },
  {
    pattern: "core.media.*",
    type: "core.mediation",
    matches: false,
    why: "text prefix is not a subtree",
  },
  {
    pattern: "core.media.*",
    type: "core.note",
    matches: false,
    why: "unrelated subtree",
  },
  {
    pattern: "core.*",
    type: "core.media.book",
    matches: true,
    why: "wildcard covers the whole namespace, at any depth",
  },
  {
    pattern: "core.*",
    type: "coreish.thing",
    matches: false,
    why: "namespace boundary is the dot, not the characters",
  },
];

describe("typeMatchesPattern", () => {
  for (const c of CASES) {
    it(`${c.pattern} ${c.matches ? "covers" : "excludes"} ${c.type} — ${c.why}`, () => {
      expect(typeMatchesPattern(c.type, c.pattern)).toBe(c.matches);
    });
  }
});

describe("wildcard semantics are the same in every consumer", () => {
  for (const c of CASES) {
    it(`${c.pattern} vs ${c.type}`, () => {
      // Webhook type filters and the SSE stream filter.
      expect(matchesTypePattern(c.type, [c.pattern])).toBe(c.matches);

      // Credential and OAuth-projected permission maps.
      expect(resolveTypePermission(c.type, { [c.pattern]: "read" })).toBe(
        c.matches ? "read" : "none",
      );

      // The consent screen's scope expansion. The global wildcard is
      // deliberately not enumerated — it projects to a `{ "*": verb }`
      // permission so it keeps covering runtime types the consent screen has
      // never heard of — so only subtree patterns are compared here.
      if (c.pattern !== "*") {
        const expanded = expandWildcardScopes([`${c.pattern}:read`], [c.type]);
        expect(expanded.includes(`${c.type}:read`)).toBe(c.matches);
      }
    });
  }

  it("passes the global wildcard through unexpanded", () => {
    expect(expandWildcardScopes(["*:read"], ["core.note"])).toEqual(["*:read"]);
  });
});

describe("subtreeWildcardRoot", () => {
  it("returns the covered root", () => {
    expect(subtreeWildcardRoot("core.media.*")).toBe("core.media");
    expect(subtreeWildcardRoot("core.*")).toBe("core");
  });

  it("returns null for the global wildcard and exact identifiers", () => {
    expect(subtreeWildcardRoot("*")).toBeNull();
    expect(subtreeWildcardRoot("core.note")).toBeNull();
  });
});

describe("typePatternToSql", () => {
  it("decomposes a subtree wildcard into an equality plus a prefix", () => {
    expect(typePatternToSql("core.media.*")).toEqual({
      global: false,
      exact: "core.media",
      descendantPattern: "core.media.%",
    });
  });

  it("decomposes an exact identifier into an equality alone", () => {
    expect(typePatternToSql("core.note")).toEqual({
      global: false,
      exact: "core.note",
      descendantPattern: null,
    });
  });

  it("flags the global wildcard so callers emit no predicate", () => {
    expect(typePatternToSql("*")).toEqual({
      global: true,
      exact: null,
      descendantPattern: null,
    });
  });

  it("escapes SQL LIKE metacharacters in valid identifier segments", () => {
    expect(typePatternToSql("demo.web_gallery.*")).toEqual({
      global: false,
      exact: "demo.web_gallery",
      descendantPattern: "demo.web\\_gallery.%",
    });
  });
});
