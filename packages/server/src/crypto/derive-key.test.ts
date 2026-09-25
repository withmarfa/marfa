import { describe, it, expect, afterEach } from "vitest";
import { deriveKey, SECRET_INFO } from "./derive-key.js";

describe("deriveKey", () => {
  it("derives one key per purpose, the same each time within a process", () => {
    const a = deriveKey(SECRET_INFO.blobLink);
    expect(a).toHaveLength(32);
    expect(deriveKey(SECRET_INFO.blobLink).equals(a)).toBe(true);
    expect(deriveKey("some-other-purpose").equals(a)).toBe(false);
  });
});

describe("deriveKey in production", () => {
  // Snapshot the two variables these cases mutate, so production mode and
  // an injected secret never leak into the rest of the suite, which relies
  // on the deterministic fallback.
  const savedNodeEnv = process.env.NODE_ENV;
  const savedSecret = process.env.MARFA_AUTH_SECRET;

  function restore(value: string | undefined, key: string): void {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }

  afterEach(() => {
    restore(savedNodeEnv, "NODE_ENV");
    restore(savedSecret, "MARFA_AUTH_SECRET");
  });

  it("throws with no secret set", () => {
    process.env.NODE_ENV = "production";
    delete process.env.MARFA_AUTH_SECRET;
    expect(() => deriveKey(SECRET_INFO.blobLink)).toThrow(/MARFA_AUTH_SECRET/);
  });

  it("derives from the configured secret, which decides the key", () => {
    process.env.NODE_ENV = "production";
    process.env.MARFA_AUTH_SECRET = "p".repeat(32);
    const first = deriveKey(SECRET_INFO.blobLink);
    process.env.MARFA_AUTH_SECRET = "q".repeat(32);
    expect(deriveKey(SECRET_INFO.blobLink).equals(first)).toBe(false);
  });
});
