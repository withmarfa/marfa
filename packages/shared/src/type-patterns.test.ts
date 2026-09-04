import { afterEach, describe, expect, it } from "vitest";
import {
  subtreeWildcardRoot,
  typeAnswersSubtreeFilter,
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

/**
 * The in-memory read filter answers what the SQL one selects.
 *
 * `typeAnswersSubtreeFilter` exists so the stream, which has no query to
 * hang a predicate on, resolves `?type=` the way `/items` compiles it.
 * That promise is only worth making if the two agree about every input,
 * and the one that is easy to get wrong is the scope argument: the SQL
 * side reads `undefined` as "resolve names only" and `null` as the real
 * null-space bucket, while the registry lookup underneath the predicate
 * treats the two alike. So a predicate that simply forwarded the value
 * would resolve declared parentage where its twin resolves none — the
 * disagreement it exists to prevent, in the one caller who omits the
 * argument.
 */
describe("the read filter's predicate answers what its SQL twin selects", () => {
  const SPACE = "space-predicate-parity";
  const OUTSIDE = "user.declared_note";
  /** Registered into the NULL-space bucket, which is what makes the
   *  `undefined` case discriminating: `resolveSchema` reads `undefined`
   *  and `null` alike, so a predicate that forwarded the value verbatim
   *  would resolve this one while `typeSubtreeToSql` returns no declared
   *  extras at all. A child registered only into a named space cannot
   *  catch that — the lookup finds nothing either way. */
  const NULL_BUCKET_CHILD = "user.null_bucket_note";

  const declaredChild = (id: string): TypeSchema =>
    ({
      id,
      name: id,
      description: "test",
      parent: "core.note",
      version: 1,
      fields: {},
    }) as unknown as TypeSchema;

  afterEach(() => {
    unregisterTypeSchema(OUTSIDE, SPACE);
    unregisterTypeSchema(NULL_BUCKET_CHILD, null);
  });

  /** Membership as the SQL clauses decide it, for comparison. */
  const sqlAdmits = (
    type: string,
    filter: string,
    spaceId?: string | null,
  ): boolean => {
    const { global, exact, descendantPattern, extraTypes } = typeSubtreeToSql(
      filter,
      spaceId,
    );
    if (global) return true;
    if (exact !== null && type === exact) return true;
    if (
      descendantPattern !== null &&
      type.startsWith(descendantPattern.replace(/\\(.)/g, "$1").slice(0, -1))
    ) {
      return true;
    }
    return extraTypes.includes(type);
  };

  for (const spaceId of [SPACE, null, undefined] as const) {
    it(`agrees with the SQL decomposition for spaceId=${String(spaceId)}`, () => {
      registerTypeSchema(declaredChild(OUTSIDE), SPACE);
      registerTypeSchema(declaredChild(NULL_BUCKET_CHILD), null);

      for (const [type, filter] of [
        ["core.note", "core.note"],
        ["core.note.private", "core.note"],
        ["core.note.private", "core.note.*"],
        ["core.media", "core.note"],
        ["anything.at.all", "*"],
        // The two the scope argument decides: named outside the filter's
        // namespace, reachable only through a declared parent. The
        // null-bucket one separates `undefined` from `null`, which the
        // registry lookup underneath does not.
        [OUTSIDE, "core.note"],
        [NULL_BUCKET_CHILD, "core.note"],
      ] as const) {
        expect({
          type,
          filter,
          admitted: typeAnswersSubtreeFilter(type, filter, spaceId),
        }).toEqual({
          type,
          filter,
          admitted: sqlAdmits(type, filter, spaceId),
        });
      }
    });
  }
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
