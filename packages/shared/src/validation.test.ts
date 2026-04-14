import { describe, expect, it } from "vitest";
import {
  isValidTimestamp,
  isValidStrictTimestamp,
  isValidBlobHash,
  isValidUrl,
  isValidEmail,
  isValidLanguageCode,
  isValidTypeIdentifier,
  matchesTypePattern,
  resolveTypePermission,
} from "./validation.js";

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
    expect(isValidTypeIdentifier("core.media.tv_episode")).toBe(true);
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
    expect(matchesTypePattern("core.media", ["core.media.*"])).toBe(false);
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
});
