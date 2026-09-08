/**
 * One implementation of "does this type match that pattern", checked as a
 * property rather than as a list of cases.
 *
 * `resolveTypePermission` used to write the parent-inclusion rule out again
 * inline — `type !== root && !type.startsWith(root + ".")` — beside the copy in
 * `typeMatchesPattern`, and `isValidTypePattern` used to re-decompose a
 * trailing `.*` beside the copy in `subtreeWildcardRoot`. Neither was wrong on
 * the day it was written. **`type-patterns.ts` records what a second copy
 * costs**: two functions that both return a plausible boolean about who may
 * read what, and a drift between them that no test asks about because each
 * copy is tested against itself.
 *
 * So the checks here are relations rather than examples:
 *
 *   - Resolution agrees with a declarative statement of the same rule — filter
 *     by `typeMatchesPattern`, rank by root length, take the most specific —
 *     across a cross product of permission maps and types. Written by sorting
 *     rather than by a single pass, so agreeing with it is not a copy agreeing
 *     with itself.
 *   - Nothing resolves to a pattern that does not match, and something that
 *     matches always resolves to something.
 *   - Validity agrees with decomposition: a pattern is a subtree wildcard to
 *     the validator exactly when `subtreeWildcardRoot` finds a root in it.
 *
 * The corpus deliberately holds the pair that a naive prefix test gets wrong —
 * `core.note.*` against `core.notebook` — and the pair that a naive longest-
 * string test gets wrong, where a shorter root matches and a longer one does
 * not.
 */
import { describe, it, expect } from "vitest";
import { resolveTypePermission, isValidTypePattern } from "./validation.js";
import {
  GLOBAL_TYPE_WILDCARD,
  subtreeWildcardRoot,
  typeMatchesPattern,
} from "./type-patterns.js";
import type { TypePermission } from "./types.js";

const TYPES = [
  "core",
  "core.note",
  "core.note.draft",
  "core.notebook",
  "core.file",
  "core.file.image",
  "other",
  "other.thing",
];

const PATTERNS = [
  GLOBAL_TYPE_WILDCARD,
  "core.*",
  "core.note.*",
  "core.notebook.*",
  "core.file.*",
  "core",
  "core.note",
  "core.notebook",
  "other.*",
  "other",
];

const LEVELS: TypePermission[] = ["read", "write", "none"];

/**
 * The rule, stated rather than walked: of every entry whose pattern matches,
 * the most specific one wins, where an exact identifier beats every wildcard,
 * a longer subtree root beats a shorter one, and the global wildcard is the
 * floor.
 */
function referenceResolve(
  type: string,
  permissions: Record<string, TypePermission>,
): TypePermission {
  const specificity = (pattern: string): number => {
    if (pattern === type) return Number.MAX_SAFE_INTEGER;
    if (pattern === GLOBAL_TYPE_WILDCARD) return -1;
    return subtreeWildcardRoot(pattern)?.length ?? -1;
  };
  const matching = Object.entries(permissions).filter(([pattern]) =>
    typeMatchesPattern(type, pattern),
  );
  if (matching.length === 0) return "none";
  const best = [...matching].sort(
    ([a], [b]) => specificity(b) - specificity(a),
  )[0];
  return best?.[1] ?? "none";
}

/** Every pair and triple of the pattern corpus, levels cycled so two entries
 *  in one map rarely carry the same answer. */
function* maps(): Generator<Record<string, TypePermission>> {
  for (let i = 0; i < PATTERNS.length; i++) {
    for (let j = i + 1; j < PATTERNS.length; j++) {
      yield {
        [PATTERNS[i]!]: LEVELS[i % 3]!,
        [PATTERNS[j]!]: LEVELS[(j + 1) % 3]!,
      };
      for (let k = j + 1; k < PATTERNS.length; k++) {
        yield {
          [PATTERNS[i]!]: LEVELS[i % 3]!,
          [PATTERNS[j]!]: LEVELS[(j + 1) % 3]!,
          [PATTERNS[k]!]: LEVELS[(k + 2) % 3]!,
        };
      }
    }
  }
}

describe("resolveTypePermission agrees with the matcher it is built on", () => {
  it("answers what the rule says, over every map and type in the corpus", () => {
    let checked = 0;
    const disagreements: string[] = [];
    for (const permissions of maps()) {
      for (const type of TYPES) {
        checked++;
        const got = resolveTypePermission(type, permissions);
        const want = referenceResolve(type, permissions);
        if (got !== want) {
          disagreements.push(
            `${type} against ${JSON.stringify(permissions)}: got ${got}, rule says ${want}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
    // The corpus is not empty and the loop actually ran — otherwise the
    // assertion above passes on nothing, which is how a property test dies.
    expect(checked).toBeGreaterThan(1000);
  });

  it("never answers from a pattern that does not match the type", () => {
    for (const pattern of PATTERNS) {
      for (const type of TYPES) {
        const answer = resolveTypePermission(type, { [pattern]: "write" });
        expect(answer).toBe(
          typeMatchesPattern(type, pattern) ? "write" : "none",
        );
      }
    }
  });
});

describe("longest-prefix precedence", () => {
  it("takes the longer root when two subtree wildcards both match", () => {
    const forward = resolveTypePermission("core.note.draft", {
      "core.*": "read",
      "core.note.*": "write",
    });
    const reversed = resolveTypePermission("core.note.draft", {
      "core.note.*": "write",
      "core.*": "read",
    });
    // Insertion order is not part of the rule, and an implementation that
    // stopped at the first match would answer differently here.
    expect(forward).toBe("write");
    expect(reversed).toBe("write");
  });

  it("prefers an exact identifier over any wildcard covering it", () => {
    expect(
      resolveTypePermission("core.note", {
        "*": "write",
        "core.*": "write",
        "core.note": "none",
      }),
    ).toBe("none");
  });

  it("falls to the global wildcard only when nothing more specific matches", () => {
    expect(
      resolveTypePermission("other.thing", { "*": "read", "core.*": "write" }),
    ).toBe("read");
  });

  it("does not treat a longer root that does not match as more specific", () => {
    // `core.notebook.*` is the longer root and covers nothing here; a rank
    // computed before matching would hand back its level.
    expect(
      resolveTypePermission("core.note", {
        "core.*": "read",
        "core.notebook.*": "write",
      }),
    ).toBe("read");
  });

  it("does not let a subtree wildcard leak across a shared name prefix", () => {
    // The case a bare `startsWith(root)` gets wrong: `core.notebook` begins
    // with `core.note` and is not inside it.
    expect(
      resolveTypePermission("core.notebook", { "core.note.*": "write" }),
    ).toBe("none");
    expect(typeMatchesPattern("core.notebook", "core.note.*")).toBe(false);
  });

  it("resolves the parent of a subtree wildcard, which is what granting one means", () => {
    expect(resolveTypePermission("core.note", { "core.note.*": "write" })).toBe(
      "write",
    );
  });
});

describe("isValidTypePattern agrees with the decomposition", () => {
  const CANDIDATES = [
    GLOBAL_TYPE_WILDCARD,
    "core",
    "core.note",
    "core.note.draft",
    "core.*",
    "core.note.*",
    ".*",
    "*.*",
    "core.",
    "core..note",
    "core/note",
    "Core.Note",
    "core.note.",
    "9core",
    "core.9note",
    "core-note",
    "core_note",
    "",
    "a".repeat(129),
    `${"a".repeat(127)}.*`,
  ];

  it("asks only about the root once a root is found", () => {
    // The independent statement: a subtree wildcard is valid exactly when
    // every segment of its root is a lower-case identifier segment. Written
    // out here rather than reused from the module, so agreement is agreement
    // and not one expression checking itself.
    const SEGMENT = /^[a-z][a-z0-9_-]*$/;
    let wildcards = 0;
    for (const value of CANDIDATES) {
      if (value === GLOBAL_TYPE_WILDCARD || value.length > 128) continue;
      const root = subtreeWildcardRoot(value);
      if (root === null) {
        // Nothing without a root is a subtree wildcard, so anything valid
        // here is valid as an identifier — and an identifier never ends `.*`.
        if (isValidTypePattern(value)) {
          expect(value.endsWith(".*")).toBe(false);
        }
        continue;
      }
      wildcards++;
      expect(isValidTypePattern(value)).toBe(
        root.split(".").every((segment) => SEGMENT.test(segment)),
      );
    }
    expect(wildcards).toBeGreaterThan(2);
  });

  it("accepts a subtree wildcard whose root is a valid namespace", () => {
    expect(isValidTypePattern("core.*")).toBe(true);
    expect(isValidTypePattern("core.note.*")).toBe(true);
    // A single segment is a namespace too — `core.*` is the ordinary grant.
    expect(subtreeWildcardRoot("core.*")).toBe("core");
  });

  it("refuses a trailing wildcard with no root before it", () => {
    expect(isValidTypePattern(".*")).toBe(false);
    expect(subtreeWildcardRoot(".*")).toBe(null);
  });

  it("refuses everything the identifier grammar refuses", () => {
    for (const bad of [
      "core.",
      "core..note",
      "core/note",
      "Core.Note",
      "9core",
      "",
    ]) {
      expect(isValidTypePattern(bad)).toBe(false);
    }
  });

  it("holds the length bound, and holds it before decomposing", () => {
    expect(isValidTypePattern("a".repeat(129))).toBe(false);
    expect(isValidTypePattern(`${"a".repeat(127)}.*`)).toBe(false);
    expect(isValidTypePattern(`${"a".repeat(120)}.*`)).toBe(true);
  });

  it("every valid subtree wildcard matches its own root and a child of it", () => {
    for (const value of CANDIDATES) {
      const root = subtreeWildcardRoot(value);
      if (root === null || !isValidTypePattern(value)) continue;
      expect(typeMatchesPattern(root, value)).toBe(true);
      expect(typeMatchesPattern(`${root}.child`, value)).toBe(true);
    }
  });
});
