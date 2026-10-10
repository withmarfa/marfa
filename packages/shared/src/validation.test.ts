import { describe, expect, it } from "vitest";
import {
  isValidTimestamp,
  isValidBlobHash,
  isValidTypeIdentifier,
  isValidTypePattern,
  isValidEdgeTypeIdentifier,
  RESERVED_ROOTS,
  matchesTypePattern,
  resolveTypePermission,
} from "./validation.js";
import {
  NAMESPACE_TIER_ROOTS,
  SCOPE_FAMILY_ROOTS,
  BANNED_ROOT,
} from "./scope-roots.js";

describe("isValidTimestamp", () => {
  it("accepts full ISO 8601 with Z", () => {
    expect(isValidTimestamp("2026-03-15T14:30:00Z")).toBe(true);
  });

  it("accepts full ISO 8601 with offset", () => {
    expect(isValidTimestamp("2026-03-15T14:30:00+05:00")).toBe(true);
  });

  it("accepts full ISO 8601 with fractional seconds", () => {
    expect(isValidTimestamp("2026-03-15T14:30:00.123Z")).toBe(true);
  });

  it("accepts date-only", () => {
    expect(isValidTimestamp("2026-03-15")).toBe(true);
  });

  it("accepts year-month", () => {
    expect(isValidTimestamp("2026-03")).toBe(true);
  });

  it("accepts year only", () => {
    expect(isValidTimestamp("2026")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidTimestamp("")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isValidTimestamp("not-a-date")).toBe(false);
  });

  it("rejects invalid date (Feb 30)", () => {
    expect(isValidTimestamp("2026-02-30")).toBe(false);
  });

  it.each([
    "2026-01-01T00:30:00+02:00",
    "2026-12-31T23:30:00-02:00",
    "0099-01-01T00:30:00+02:00",
  ])("accepts an offset crossing a calendar boundary: %s", (value) => {
    expect(isValidTimestamp(value)).toBe(true);
  });

  it.each(["2026-02-30T01:00:00+02:00", "2026-02-29T23:00:00-02:00"])(
    "rejects an impossible local calendar date: %s",
    (value) => {
      expect(isValidTimestamp(value)).toBe(false);
    },
  );
});

describe("isValidBlobHash", () => {
  it("accepts valid sha256 hash", () => {
    expect(
      isValidBlobHash(
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b861",
      ),
    ).toBe(true);
  });

  it("rejects missing prefix", () => {
    expect(
      isValidBlobHash(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b861",
      ),
    ).toBe(false);
  });

  it("rejects wrong algorithm prefix", () => {
    expect(
      isValidBlobHash(
        "md5:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b861",
      ),
    ).toBe(false);
  });

  it("rejects uppercase hex", () => {
    expect(
      isValidBlobHash(
        "sha256:E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B861",
      ),
    ).toBe(false);
  });

  it("rejects short hash", () => {
    expect(isValidBlobHash("sha256:abc123")).toBe(false);
  });
});

describe("isValidTypeIdentifier", () => {
  it("accepts two-segment identifier", () => {
    expect(isValidTypeIdentifier("core.note")).toBe(true);
  });

  it("accepts three-segment identifier", () => {
    expect(isValidTypeIdentifier("core.media.book")).toBe(true);
  });

  it("accepts underscores in segments", () => {
    expect(isValidTypeIdentifier("core.entity.job_title")).toBe(true);
  });

  it("rejects single segment", () => {
    expect(isValidTypeIdentifier("note")).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(isValidTypeIdentifier("Core.Note")).toBe(false);
  });

  it("accepts hyphens in segments", () => {
    expect(isValidTypeIdentifier("core.my-type")).toBe(true);
  });

  it("accepts dot-separated community types", () => {
    expect(isValidTypeIdentifier("demo.web_gallery")).toBe(true);
    expect(isValidTypeIdentifier("acme.deal")).toBe(true);
  });

  it("accepts multi-segment publisher types (publisher.foo.bar)", () => {
    expect(isValidTypeIdentifier("acme.calendar.event")).toBe(true);
    expect(isValidTypeIdentifier("acme.tasks.task")).toBe(true);
    expect(isValidTypeIdentifier("acme.deeply.nested.type")).toBe(true);
  });

  it("rejects slash-separated identifiers", () => {
    expect(isValidTypeIdentifier("demo/web-gallery")).toBe(false);
    expect(isValidTypeIdentifier("acme/deal")).toBe(false);
  });

  it("rejects identifiers over 128 characters", () => {
    const long = "core." + "a".repeat(124);
    expect(isValidTypeIdentifier(long)).toBe(false);
  });

  it("rejects segment starting with number", () => {
    expect(isValidTypeIdentifier("core.2note")).toBe(false);
  });
});

describe("matchesTypePattern", () => {
  it("matches exact type", () => {
    expect(matchesTypePattern("core.note", ["core.note"])).toBe(true);
  });

  it("matches wildcard prefix", () => {
    expect(matchesTypePattern("core.media.book", ["core.media.*"])).toBe(true);
  });

  it("matches global wildcard", () => {
    expect(matchesTypePattern("core.note", ["*"])).toBe(true);
  });

  it("does not match unrelated pattern", () => {
    expect(matchesTypePattern("core.note", ["core.media.*"])).toBe(false);
  });

  it("matches against any pattern in the array", () => {
    expect(matchesTypePattern("core.note", ["core.media.*", "core.note"])).toBe(
      true,
    );
  });

  it("wildcard prefix matches parent type too", () => {
    expect(matchesTypePattern("core.media", ["core.media.*"])).toBe(true);
  });

  it("wildcard prefix does not match a sibling sharing the text prefix", () => {
    // `core.media.*` covers `core.media` and its descendants — not
    // `core.mediation`, which merely starts with the same characters.
    expect(matchesTypePattern("core.mediation", ["core.media.*"])).toBe(false);
  });
});

describe("resolveTypePermission", () => {
  it("returns exact match permission", () => {
    expect(
      resolveTypePermission("core.note", {
        "core.note": "write",
        "core.media.*": "read",
      }),
    ).toBe("write");
  });

  it("returns wildcard prefix permission", () => {
    expect(
      resolveTypePermission("core.media.book", {
        "core.media.*": "read",
      }),
    ).toBe("read");
  });

  it("returns global wildcard permission", () => {
    expect(
      resolveTypePermission("core.note", {
        "*": "read",
      }),
    ).toBe("read");
  });

  it("returns none when no pattern matches", () => {
    expect(
      resolveTypePermission("core.note", {
        "core.media.*": "write",
      }),
    ).toBe("none");
  });

  it("prefers longer prefix over shorter", () => {
    expect(
      resolveTypePermission("core.media.book", {
        "core.*": "read",
        "core.media.*": "write",
      }),
    ).toBe("write");
  });

  it("prefers exact match over wildcard", () => {
    expect(
      resolveTypePermission("core.media.book", {
        "core.media.*": "read",
        "core.media.book": "write",
      }),
    ).toBe("write");
  });

  it("prefers wildcard prefix over global wildcard", () => {
    expect(
      resolveTypePermission("core.media.book", {
        "*": "none",
        "core.media.*": "write",
      }),
    ).toBe("write");
  });

  // Parent-inclusion is what makes a grant of `core.media.*` reach
  // `core.media`, and the same rule makes a denial of `core.secret.*` reach
  // `core.secret`. Both are the pattern doing one job, but the deny direction
  // is the one a map author has to think about.
  it("denies the subtree root when the subtree is denied", () => {
    expect(
      resolveTypePermission("core.secret", {
        "*": "write",
        "core.secret.*": "none",
      }),
    ).toBe("none");
  });

  it("grants the subtree root when the subtree is granted", () => {
    expect(
      resolveTypePermission("core.media", {
        "core.media.*": "read",
      }),
    ).toBe("read");
  });

  it("lets an explicit entry for the root override the subtree denial", () => {
    expect(
      resolveTypePermission("core.secret", {
        "*": "write",
        "core.secret.*": "none",
        "core.secret": "read",
      }),
    ).toBe("read");
  });
});

describe("a type identifier never admits a slash", () => {
  it("in the identifier or the pattern", () => {
    // A slash reaching the type grammar would reach every scope literal and
    // permission-map key, where it can only ever name something that does
    // not exist.
    expect(isValidTypeIdentifier("acme/reader")).toBe(false);
    expect(isValidTypeIdentifier("core/note")).toBe(false);
    expect(isValidTypePattern("core/note")).toBe(false);
    expect(isValidTypePattern("core/media.*")).toBe(false);
  });
});

describe("the reserved roots are derived rather than typed out", () => {
  // The set is what stops a registered type ever sharing a first segment with
  // an OAuth scope family. This pins the derivation so the next family is
  // protected by having been declared.
  it("is exactly the namespace tiers, every scope-family root, and the banned one", () => {
    expect([...RESERVED_ROOTS].sort()).toEqual(
      [...NAMESPACE_TIER_ROOTS, ...SCOPE_FAMILY_ROOTS, BANNED_ROOT].sort(),
    );
  });

  it("keeps the banned root reserved although nothing is named for it", () => {
    // It heads no permission, no scope family and no tier, so every other
    // assertion in this file passes with it removed. What removing it would
    // do is let a publisher claim the one word `GLOSSARY.md` bans outright
    // and register types beneath it.
    expect(RESERVED_ROOTS.has(BANNED_ROOT)).toBe(true);
    expect(isValidTypeIdentifier(`${BANNED_ROOT}.anything`)).toBe(false);
  });

  it("holds every scope-family root, which is the property that was missing", () => {
    // Mutation check: drop a name from SCOPE_FAMILY_ROOTS and this reddens.
    for (const root of SCOPE_FAMILY_ROOTS) {
      expect(RESERVED_ROOTS.has(root), root).toBe(true);
    }
  });

  it("refuses `metadata` and `edge` as type roots", () => {
    // `parseScope` tries the metadata and edge matchers BEFORE the type
    // matcher, so a type registered under a claimed `metadata` handle could
    // never have its own scope literal read as a type grant:
    // `metadata.types:write` is taken by the metadata family first, and that
    // is the scope gating `POST /types`.
    for (const root of ["metadata", "edge"]) {
      expect(RESERVED_ROOTS.has(root), root).toBe(true);
      expect(isValidTypeIdentifier(`${root}.anything`), root).toBe(false);
    }
  });

  it("still admits a publisher root the registry occupies", () => {
    // A publisher root the registry holds is a namespace collision rather
    // than a grammar confusion, answered by the seed refusing to overwrite a
    // registration it did not write. `acme.calendar.event` has to stay a
    // valid identifier, which putting the root in this set would prevent.
    expect(RESERVED_ROOTS.has("acme")).toBe(false);
    expect(isValidTypeIdentifier("acme.calendar.event")).toBe(true);
  });
});

describe("isValidEdgeTypeIdentifier", () => {
  it("admits the shipped kebab vocabulary", () => {
    for (const id of [
      "about",
      "attached-to",
      "authored-by",
      "derived-from",
      "in-collection",
      "in-thread",
      "parent-of",
      "references",
      "supersedes",
    ]) {
      expect(isValidEdgeTypeIdentifier(id), id).toBe(true);
    }
  });

  it("refuses what a hyphen exemption would admit", () => {
    // Skipping the check for anything hyphenated would let every one of
    // these register.
    for (const id of ["-", "MY-EDGE", "a b-c", "../-", "..--..", "-leading"]) {
      expect(isValidEdgeTypeIdentifier(id), id).toBe(false);
    }
  });

  it("defers to the type grammar for a namespaced identifier", () => {
    // Same tiers, same arity, same reserved-root refusals. A second dotted
    // grammar here is how the two axes drift, which is the defect this closes
    // arriving from the other direction.
    expect(isValidEdgeTypeIdentifier("acme.list-member")).toBe(true);
    expect(isValidEdgeTypeIdentifier("user.mine")).toBe(true);
    expect(isValidEdgeTypeIdentifier("metadata.anything")).toBe(false);
    expect(isValidEdgeTypeIdentifier("acme")).toBe(true);
  });
});
