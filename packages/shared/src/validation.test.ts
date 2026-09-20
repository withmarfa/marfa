import { describe, expect, it } from "vitest";
import {
  isValidTimestamp,
  isValidStrictTimestamp,
  isValidBlobHash,
  isValidUrl,
  isValidEmail,
  isValidLanguageCode,
  isValidTypeIdentifier,
  isValidConnectorIdentifier,
  isValidTypePattern,
  isValidHandle,
  isReservedHandle,
  isValidEdgeTypeIdentifier,
  RESERVED_ROOTS,
  deriveHandleFromEmail,
  matchesTypePattern,
  resolveTypePermission,
} from "./validation.js";
import {
  NAMESPACE_TIER_ROOTS,
  SCOPE_FAMILY_ROOTS,
  RETIRED_ROOT,
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
});

describe("isValidStrictTimestamp", () => {
  it("accepts full timestamp with Z", () => {
    expect(isValidStrictTimestamp("2026-03-15T14:30:00Z")).toBe(true);
  });

  it("accepts full timestamp with offset", () => {
    expect(isValidStrictTimestamp("2026-03-15T14:30:00+05:00")).toBe(true);
  });

  it("rejects date-only", () => {
    expect(isValidStrictTimestamp("2026-03-15")).toBe(false);
  });

  it("rejects timestamp without timezone", () => {
    expect(isValidStrictTimestamp("2026-03-15T14:30:00")).toBe(false);
  });
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

describe("isValidUrl", () => {
  it("accepts https URLs", () => {
    expect(isValidUrl("https://example.com")).toBe(true);
  });

  it("accepts http URLs", () => {
    expect(isValidUrl("http://localhost:3000/path")).toBe(true);
  });

  it("rejects bare domains", () => {
    expect(isValidUrl("example.com")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidUrl("")).toBe(false);
  });
});

describe("isValidEmail", () => {
  it("accepts standard email", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
  });

  it("rejects missing @", () => {
    expect(isValidEmail("userexample.com")).toBe(false);
  });

  it("rejects missing domain", () => {
    expect(isValidEmail("user@")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(isValidEmail("user @example.com")).toBe(false);
  });
});

describe("isValidLanguageCode", () => {
  it("accepts simple language code", () => {
    expect(isValidLanguageCode("en")).toBe(true);
  });

  it("accepts language with region", () => {
    expect(isValidLanguageCode("en-US")).toBe(true);
  });

  it("accepts language with script", () => {
    expect(isValidLanguageCode("zh-Hans")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidLanguageCode("")).toBe(false);
  });

  it("rejects single character", () => {
    expect(isValidLanguageCode("e")).toBe(false);
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
    expect(isValidTypeIdentifier("google.calendar.event")).toBe(true);
    expect(isValidTypeIdentifier("google.tasks.task")).toBe(true);
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

describe("isValidHandle", () => {
  it("accepts plain alphanumeric handles within length bounds", () => {
    expect(isValidHandle("alice")).toBe(true);
    expect(isValidHandle("a1b2c3")).toBe(true);
    expect(isValidHandle("abc")).toBe(true);
    expect(isValidHandle("a".repeat(32))).toBe(true);
  });

  it("accepts hyphenated handles where the hyphens are interior", () => {
    expect(isValidHandle("august-cayzer")).toBe(true);
    expect(isValidHandle("a-b-c")).toBe(true);
  });

  it("rejects handles outside the 3–32 length window", () => {
    expect(isValidHandle("ab")).toBe(false);
    expect(isValidHandle("a")).toBe(false);
    expect(isValidHandle("")).toBe(false);
    expect(isValidHandle("a".repeat(33))).toBe(false);
  });

  it("rejects leading or trailing hyphens", () => {
    expect(isValidHandle("-abc")).toBe(false);
    expect(isValidHandle("abc-")).toBe(false);
  });

  it("rejects consecutive hyphens", () => {
    expect(isValidHandle("a--b")).toBe(false);
    expect(isValidHandle("foo--bar")).toBe(false);
  });

  it("rejects uppercase characters (canonical form is lowercase)", () => {
    expect(isValidHandle("Abc")).toBe(false);
    expect(isValidHandle("ABC")).toBe(false);
  });

  it("rejects non-alphanumeric characters other than hyphen", () => {
    expect(isValidHandle("foo.bar")).toBe(false);
    expect(isValidHandle("foo_bar")).toBe(false);
    expect(isValidHandle("foo bar")).toBe(false);
  });

  it("rejects every reserved namespace root", () => {
    expect(isValidHandle("core")).toBe(false);
    expect(isValidHandle("system")).toBe(false);
    expect(isValidHandle("app")).toBe(false);
    expect(isValidHandle("user")).toBe(false);
    expect(isValidHandle("marfa")).toBe(false);
    expect(isValidHandle("space")).toBe(false);
  });

  it("accepts a handle that merely names a company or a page", () => {
    // A handle is a namespace claim, not a URL path — nothing in the
    // server routes on one — so `google.invoice` or `settings.note` is
    // odd rather than dangerous, and the grammar is what decides.
    expect(isValidHandle("google")).toBe(true);
    expect(isValidHandle("settings")).toBe(true);
    expect(isValidHandle("admin")).toBe(true);
  });

  it("returns false for non-string input", () => {
    expect(isValidHandle(undefined as unknown as string)).toBe(false);
    expect(isValidHandle(null as unknown as string)).toBe(false);
    expect(isValidHandle(42 as unknown as string)).toBe(false);
  });
});

describe("deriveHandleFromEmail", () => {
  it("derives a valid handle from a clean local part", () => {
    expect(deriveHandleFromEmail("alice@example.com")).toBe("alice");
    expect(deriveHandleFromEmail("august-cayzer@example.com")).toBe(
      "august-cayzer",
    );
  });

  it("always returns a value that passes isValidHandle", () => {
    for (const email of [
      "alice@example.com",
      "a.b.c@example.com",
      "x@example.com",
      "@example.com",
      "UPPER.Case@Example.com",
      "weird!!!chars###@x.io",
      "system@example.com",
      "a-very-long-local-part-that-exceeds-the-thirty-two-char-limit@x.io",
      "...@x.io",
    ]) {
      const handle = deriveHandleFromEmail(email);
      expect(isValidHandle(handle), `handle for ${email}: ${handle}`).toBe(
        true,
      );
    }
  });

  it("lowercases and replaces dots and invalid runs with single hyphens", () => {
    expect(deriveHandleFromEmail("First.Last@example.com")).toBe("first-last");
    expect(deriveHandleFromEmail("a..b@example.com")).toBe("a-b");
    expect(deriveHandleFromEmail("a_b+c@example.com")).toBe("a-b-c");
  });

  it("pads a too-short local part to clear the 3-char floor", () => {
    expect(deriveHandleFromEmail("x@example.com")).toBe("user-x");
    // The bare "user" fallback is itself reserved, so it gets suffixed.
    expect(deriveHandleFromEmail("@example.com")).toBe("user-1");
  });

  it("caps the result at 32 characters with no trailing hyphen", () => {
    const handle = deriveHandleFromEmail(
      "a-very-long-local-part-that-keeps-going-well-past-the-limit@x.io",
    );
    expect(handle.length).toBeLessThanOrEqual(32);
    expect(handle.endsWith("-")).toBe(false);
  });

  it("suffixes a local part that lands on a reserved root", () => {
    const handle = deriveHandleFromEmail("system@example.com");
    expect(handle).toBe("system-1");
    expect(isReservedHandle(handle)).toBe(false);
    expect(isValidHandle(handle)).toBe(true);
  });

  it("does not suffix a local part that is merely a common word", () => {
    expect(deriveHandleFromEmail("admin@example.com")).toBe("admin");
  });
});

describe("isReservedHandle", () => {
  it("returns true for every reserved namespace root", () => {
    expect(isReservedHandle("core")).toBe(true);
    expect(isReservedHandle("system")).toBe(true);
    expect(isReservedHandle("app")).toBe(true);
    expect(isReservedHandle("user")).toBe(true);
    expect(isReservedHandle("marfa")).toBe(true);
    expect(isReservedHandle("space")).toBe(true);
  });

  it("returns false for everything that is not a root", () => {
    // The roots are the whole list: a handle collides with the type
    // grammar or it does not, and no other word is refused.
    expect(isReservedHandle("alice")).toBe(false);
    expect(isReservedHandle("august-cayzer")).toBe(false);
    expect(isReservedHandle("a1b2c3")).toBe(false);
    expect(isReservedHandle("admin")).toBe(false);
    expect(isReservedHandle("google")).toBe(false);
  });

  it("does not enforce length or grammar — that's isValidHandle's job", () => {
    // A too-short string is not "reserved" — it just isn't valid. The
    // route layer calls isReservedHandle first to surface a typed error,
    // then falls through to isValidHandle for everything else.
    expect(isReservedHandle("ab")).toBe(false);
    expect(isReservedHandle("--bad")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(isReservedHandle(undefined as unknown as string)).toBe(false);
    expect(isReservedHandle(null as unknown as string)).toBe(false);
  });
});

describe("isValidConnectorIdentifier", () => {
  it("accepts handle-slash-name", () => {
    expect(isValidConnectorIdentifier("readwise/reader")).toBe(true);
    expect(isValidConnectorIdentifier("marfa/rss-watcher")).toBe(true);
    expect(isValidConnectorIdentifier("google/calendar")).toBe(true);
  });

  it("accepts a dotted name half, so a family can carry a sub-namespace", () => {
    expect(isValidConnectorIdentifier("acme/calendar.events")).toBe(true);
  });

  it("does not judge reserved words — that is registration's question", () => {
    // `marfa` is a reserved root and the platform's own connectors live
    // under `marfa/`, so refusing reserved values syntactically would refuse
    // the shipped set. Whether a publisher may publish under a handle is
    // answered at registration, where the credential is in hand.
    expect(isValidConnectorIdentifier("marfa/podcasts")).toBe(true);
    expect(isValidConnectorIdentifier("todoist/tasks")).toBe(true);
  });

  it("takes exactly one slash, never a path", () => {
    expect(isValidConnectorIdentifier("acme/deep/name")).toBe(false);
    expect(isValidConnectorIdentifier("/leading")).toBe(false);
    expect(isValidConnectorIdentifier("trailing/")).toBe(false);
  });

  it("holds the handle to the handle grammar", () => {
    expect(isValidConnectorIdentifier("ab/short-handle")).toBe(false);
    expect(isValidConnectorIdentifier("do--uble/name")).toBe(false);
    expect(isValidConnectorIdentifier("Upper/name")).toBe(false);
    expect(isValidConnectorIdentifier("-lead/name")).toBe(false);
  });

  it("refuses the dot form the connectors shipped under before", () => {
    // Every stored name carries the slash now, so a dotted value names a
    // type. Accepting both was the migration window, and it is closed.
    expect(isValidConnectorIdentifier("readwise.reader")).toBe(false);
    expect(isValidConnectorIdentifier("withmarfa.inbox")).toBe(false);
    expect(isValidConnectorIdentifier("core.note")).toBe(false);
  });

  it("refuses a bare word carrying neither separator", () => {
    expect(isValidConnectorIdentifier("nodot")).toBe(false);
  });

  it("caps length and refuses non-strings", () => {
    expect(isValidConnectorIdentifier(`acme/${"a".repeat(200)}`)).toBe(false);
    expect(isValidConnectorIdentifier(undefined as unknown as string)).toBe(
      false,
    );
  });
});

describe("the two grammars stay apart", () => {
  it("a type identifier never admits a slash", () => {
    // The whole reason connector names got their own validator: a slash
    // reaching the type grammar would reach every scope literal and
    // permission-map key, where it can only ever name something that does
    // not exist.
    expect(isValidTypeIdentifier("readwise/reader")).toBe(false);
    expect(isValidTypeIdentifier("core/note")).toBe(false);
    expect(isValidTypePattern("core/note")).toBe(false);
    expect(isValidTypePattern("core/media.*")).toBe(false);
  });
});

describe("the reserved roots are derived rather than typed out", () => {
  // The set is what stops a registered type ever sharing a first segment with
  // an OAuth scope family. It was a hand list, and every family that arrived
  // needed a second edit to be protected: `capability` got one, `content` got
  // one, and `metadata` and `edge` never did. This pins the derivation so the
  // next family is protected by having been declared.
  it("is exactly the namespace tiers, every scope-family root, and the retired one", () => {
    expect([...RESERVED_ROOTS].sort()).toEqual(
      [...NAMESPACE_TIER_ROOTS, ...SCOPE_FAMILY_ROOTS, RETIRED_ROOT].sort(),
    );
  });

  it("keeps the retired root reserved although nothing is named for it", () => {
    // It heads no permission, no scope family and no tier, so every other
    // assertion in this file passes with it removed. What removing it would
    // do is let a publisher claim the one word `GLOSSARY.md` bans outright
    // and register types beneath it.
    expect(RESERVED_ROOTS.has(RETIRED_ROOT)).toBe(true);
    expect(isValidHandle(RETIRED_ROOT)).toBe(false);
    expect(isValidTypeIdentifier(`${RETIRED_ROOT}.anything`)).toBe(false);
  });

  it("holds every scope-family root, which is the property that was missing", () => {
    // Mutation check: drop a name from SCOPE_FAMILY_ROOTS and this reddens.
    for (const root of SCOPE_FAMILY_ROOTS) {
      expect(RESERVED_ROOTS.has(root), root).toBe(true);
    }
  });

  it("refuses `metadata` and `edge` as handles, which it used to admit", () => {
    // `parseScope` tries the metadata and edge matchers BEFORE the type
    // matcher, so a type registered under a claimed `metadata` handle could
    // never have its own scope literal read as a type grant:
    // `metadata.types:write` is taken by the metadata family first, and that
    // is the scope gating `POST /types`.
    for (const root of ["metadata", "edge"]) {
      expect(isReservedHandle(root), root).toBe(true);
      expect(isValidHandle(root), root).toBe(false);
      expect(isValidTypeIdentifier(`${root}.anything`), root).toBe(false);
    }
  });

  it("still admits a publisher handle the shipped registry occupies", () => {
    // Deliberate, and the reason is on `isReservedHandle`. A handle naming a
    // shipped publisher root is a namespace collision rather than a grammar
    // confusion, and reserving `google` while admitting `google-drive` is a
    // half-protection rather than a defense. `google.calendar.event` also has
    // to stay a valid identifier, which putting the root in this set would
    // prevent.
    expect(isValidHandle("google")).toBe(true);
    expect(isValidTypeIdentifier("google.calendar.event")).toBe(true);
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

  it("refuses what the hyphen escape hatch used to admit", () => {
    // `!isValidTypeIdentifier(id) && !id.includes("-")` skipped the check
    // entirely for anything hyphenated, so every one of these registered.
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
