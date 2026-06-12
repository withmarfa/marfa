import { describe, expect, it } from "vitest";
import { constantTimeEqual, sha256Hex } from "./crypto.js";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual("a", "")).toBe(false);
  });

  it("handles unicode without throwing on length mismatch", () => {
    // 'é' encodes to two UTF-8 bytes; 'e' to one. The plain `timingSafeEqual`
    // would throw on the byte-length mismatch — our wrapper must not.
    expect(constantTimeEqual("café", "cafe")).toBe(false);
    expect(constantTimeEqual("café", "café")).toBe(true);
  });

  it("distinguishes equal-length secret-shaped values", () => {
    // The digest path must not collapse same-length-but-different inputs to
    // equal. Exercises the realistic caller shape (prefixed sha256 hex hashes).
    const a = `sha256:${"a".repeat(64)}`;
    const b = `sha256:${"b".repeat(64)}`;
    expect(constantTimeEqual(a, a)).toBe(true);
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("produces the expected hex digest for a known input", () => {
    // echo -n "hello" | openssl dgst -sha256
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
