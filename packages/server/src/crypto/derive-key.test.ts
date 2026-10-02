import { describe, it, expect } from "vitest";
import { deriveKey, SECRET_INFO } from "./derive-key.js";

describe("deriveKey", () => {
  const secret = "p".repeat(32);

  it("derives one key per purpose, the same each time", () => {
    const a = deriveKey(secret, SECRET_INFO.blobLink);
    expect(a).toHaveLength(32);
    expect(deriveKey(secret, SECRET_INFO.blobLink).equals(a)).toBe(true);
    expect(deriveKey(secret, "some-other-purpose").equals(a)).toBe(false);
  });

  it("derives from the master secret, which decides the key", () => {
    const first = deriveKey(secret, SECRET_INFO.blobLink);
    expect(deriveKey("q".repeat(32), SECRET_INFO.blobLink).equals(first)).toBe(
      false,
    );
  });
});
