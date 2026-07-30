import { afterEach, describe, expect, it } from "vitest";
import {
  subtreeWildcardRoot,
  typeMatchesPattern,
  typePatternToSql,
  typeSubtreeToSql,
} from "./type-patterns.js";
import {
  declaredDescendantsOutsideNamespace,
  registerTypeSchema,
  unregisterTypeSchema,
  type TypeSchema,
} from "./type-registry.js";
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
      extraTypes: [],
    });
  });

  it("decomposes an exact identifier into an equality alone", () => {
    expect(typePatternToSql("core.note")).toEqual({
      global: false,
      exact: "core.note",
      descendantPattern: null,
      extraTypes: [],
    });
  });

  it("flags the global wildcard so callers emit no predicate", () => {
    expect(typePatternToSql("*")).toEqual({
      global: true,
      exact: null,
      descendantPattern: null,
      extraTypes: [],
    });
  });

  it("escapes SQL LIKE metacharacters in valid identifier segments", () => {
    expect(typePatternToSql("demo.web_gallery.*")).toEqual({
      global: false,
      exact: "demo.web_gallery",
      descendantPattern: "demo.web\\_gallery.%",
      extraTypes: [],
    });
  });
});

describe("resolving names alone", () => {
  it("consults no registry when the caller supplies no space scope", () => {
    // Webhook filters and scope parsing match on identifiers only. Omitting the
    // scope has to keep them on exactly the predicate they always emitted, so
    // the declared half is opt-in rather than something a pure caller inherits.
    // `typePatternToSql` never resolves it at all — see its own comment.
    expect(typeSubtreeToSql("core.note").extraTypes).toEqual([]);
    expect(typeMatchesPattern("user.elsewhere", "core.note.*")).toBe(false);
    // A permission pattern never consults the registry, whatever is registered.
    expect(typePatternToSql("core.note.*").extraTypes).toEqual([]);
  });
});

describe("declared descendants are resolved per space", () => {
  const child = (id: string, parent: string): TypeSchema =>
    ({
      id,
      name: id,
      description: "test",
      parent,
      version: 1,
      fields: {},
    }) as unknown as TypeSchema;

  afterEach(() => {
    unregisterTypeSchema("user.alpha_child", "space-alpha");
    unregisterTypeSchema("user.beta_child", "space-beta");
  });

  it("resolves only the asking space's declared children", () => {
    registerTypeSchema(child("user.alpha_child", "core.note"), "space-alpha");
    registerTypeSchema(child("user.beta_child", "core.note"), "space-beta");

    expect(
      declaredDescendantsOutsideNamespace("core.note", "space-alpha"),
    ).toEqual(["user.alpha_child"]);
    expect(
      declaredDescendantsOutsideNamespace("core.note", "space-beta"),
    ).toEqual(["user.beta_child"]);
  });

  // The item store's space fence would drop another space's rows anyway, so a
  // cross-space resolver leaks no data today. This is the second layer, and it
  // is asserted here rather than left to the first: a resolver that reaches the
  // global set is wrong on its own terms, and proving it through the query path
  // only proves the fence.
  it("does not reach another space's registry", () => {
    registerTypeSchema(child("user.beta_child", "core.note"), "space-beta");
    expect(
      declaredDescendantsOutsideNamespace("core.note", "space-alpha"),
    ).not.toContain("user.beta_child");
  });

  it("returns nothing for a root nothing declares", () => {
    registerTypeSchema(child("user.alpha_child", "core.note"), "space-alpha");
    expect(
      declaredDescendantsOutsideNamespace("core.bookmark", "space-alpha"),
    ).toEqual([]);
  });
});
