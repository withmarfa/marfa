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

// One table, three consumers. Each gate answers the parent-inclusion question,
// whether `core.media.*` reaches `core.media`, and a credential admitted by one
// and denied by another would read as a grant that works on some doors only.
// The table is the contract; every consumer is asserted against it.
const CASES: {
  pattern: string;
  type: string;
  matches: boolean;
  why: string;
}[] = [
  { pattern: "*", type: "core.note", matches: true, why: "global wildcard" },
  {
    pattern: "*",
    type: "system.device",
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
    });
  }
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
  it("consults no registry where the caller matches on identifiers alone", () => {
    // Webhook filters and scope parsing match on identifiers only, so the
    // declared half stays out of the predicate they emit.
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
 * and the one that is easy to get wrong is the declared clause: a predicate
 * that resolved declared parentage where its twin resolves none would be
 * exactly the disagreement this exists to prevent.
 */
describe("the read filter's predicate answers what its SQL twin selects", () => {
  const OUTSIDE = "user.declared_note";

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
    unregisterTypeSchema(OUTSIDE);
  });

  /** Membership as the SQL clauses decide it, for comparison. */
  const sqlAdmits = (type: string, filter: string): boolean => {
    const { global, exact, descendantPattern, extraTypes } =
      typeSubtreeToSql(filter);
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

  it("agrees with the SQL decomposition", () => {
    registerTypeSchema(declaredChild(OUTSIDE));

    for (const [type, filter] of [
      ["core.note", "core.note"],
      ["core.note.private", "core.note"],
      ["core.note.private", "core.note.*"],
      ["core.media", "core.note"],
      ["anything.at.all", "*"],
      // Named outside the filter's namespace, reachable only through a
      // declared parent.
      [OUTSIDE, "core.note"],
    ] as const) {
      expect({
        type,
        filter,
        admitted: typeAnswersSubtreeFilter(type, filter),
      }).toEqual({
        type,
        filter,
        admitted: sqlAdmits(type, filter),
      });
    }
  });
});

describe("declared descendants", () => {
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
    unregisterTypeSchema("user.alpha_child");
  });

  it("names a child declared outside the root's namespace", () => {
    registerTypeSchema(child("user.alpha_child", "core.note"));
    expect(declaredDescendantsOutsideNamespace("core.note")).toEqual([
      "user.alpha_child",
    ]);
  });

  it("returns nothing for a root nothing declares", () => {
    registerTypeSchema(child("user.alpha_child", "core.note"));
    expect(declaredDescendantsOutsideNamespace("core.bookmark")).toEqual([]);
  });
});
