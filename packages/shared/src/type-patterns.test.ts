import { afterEach, describe, expect, it } from "vitest";
import {
  subtreeWildcardRoot,
  decidingPattern,
  matchesTypeFilter,
  patternRank,
  typeMatchesPattern,
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
    type: "system.folder",
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

describe("one ranking for a permission map", () => {
  it("ranks an exact identifier over the longest wildcard over a shorter one over the global wildcard", () => {
    const ranked = ["*", "core.*", "core.media.*", "core.media.book"].map(
      patternRank,
    );
    expect([...ranked].sort((a, b) => a - b)).toEqual(ranked);
    expect(new Set(ranked).size).toBe(ranked.length);
  });

  it("decides a type by its most specific covering entry, in any order", () => {
    const patterns = ["*", "core.*", "core.media.*", "core.media.book"];
    for (const order of [patterns, [...patterns].reverse()]) {
      expect(decidingPattern("core.media.book", order)).toBe("core.media.book");
      expect(decidingPattern("core.media.film", order)).toBe("core.media.*");
      expect(decidingPattern("core.media", order)).toBe("core.media.*");
      expect(decidingPattern("core.note", order)).toBe("core.*");
      expect(decidingPattern("user.note", order)).toBe("*");
    }
    expect(decidingPattern("user.note", ["core.*"])).toBeUndefined();
  });

  /**
   * Every map over a small vocabulary of patterns, against every type the
   * patterns can tell apart: the point check and the list filter's predicate
   * answer alike. The SQL compiler is held to `matchesTypeFilter` in the
   * server's `filter-sql-type.test.ts`.
   */
  it("gives the point check and the list filter one answer for every map", () => {
    const patterns = [
      "*",
      "core.*",
      "core.media.*",
      "core.media.book",
      "core.media",
      "core.note",
      "user.*",
      "user.secret",
    ];
    const types = [
      "core.media",
      "core.media.book",
      "core.media.film",
      "core.mediation",
      "core.note",
      "core.note.private",
      "user.secret",
      "user.diary",
      "acme.thing",
    ];
    const levels = ["absent", "read", "write", "none"] as const;
    let maps: Record<string, "read" | "write" | "none">[] = [{}];
    for (const pattern of patterns) {
      maps = maps.flatMap((map) =>
        levels.map((level) =>
          level === "absent" ? map : { ...map, [pattern]: level },
        ),
      );
    }
    for (const map of maps) {
      const allowed = Object.keys(map).filter((p) => map[p] !== "none");
      const excluded = Object.keys(map).filter((p) => map[p] === "none");
      for (const type of types) {
        expect({
          map,
          type,
          listed: matchesTypeFilter(type, { allowed, excluded }),
        }).toEqual({
          map,
          type,
          listed: resolveTypePermission(type, map) !== "none",
        });
      }
    }
    expect(maps).toHaveLength(levels.length ** patterns.length);
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
    unregisterTypeSchema("user.cycle_a");
    unregisterTypeSchema("user.cycle_b");
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

  it("skips a type whose declared chain cycles, rather than throwing", () => {
    registerTypeSchema(child("user.alpha_child", "core.note"));
    registerTypeSchema(child("user.cycle_a", "user.cycle_b"));
    registerTypeSchema(child("user.cycle_b", "user.cycle_a"));
    expect(declaredDescendantsOutsideNamespace("core.note")).toEqual([
      "user.alpha_child",
    ]);
  });
});
