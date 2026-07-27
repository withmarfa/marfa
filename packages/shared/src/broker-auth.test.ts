/**
 * The rule both ends of the broker hop agree on. Pinned here rather
 * than in either caller so a change to the comparison has to be a
 * deliberate edit to a test that names what it protects.
 */
import { describe, it, expect } from "vitest";
import { isBrokerAuthorized } from "./broker-auth.js";

const KEY = "broker_key_value";

describe("isBrokerAuthorized", () => {
  it("admits the exact Bearer form", async () => {
    await expect(isBrokerAuthorized(`Bearer ${KEY}`, KEY)).resolves.toBe(true);
  });

  it.each([
    ["absent header", undefined],
    ["null header", null],
    ["empty header", ""],
    ["bare key without the scheme", KEY],
    ["wrong key", "Bearer nope"],
    ["prefix of the key", `Bearer ${KEY.slice(0, -1)}`],
    ["key with trailing whitespace", `Bearer ${KEY} `],
    ["lowercased scheme", `bearer ${KEY}`],
    ["a different scheme", `Basic ${KEY}`],
    ["double scheme", `Bearer Bearer ${KEY}`],
  ])("refuses %s", async (_label, header) => {
    await expect(isBrokerAuthorized(header, KEY)).resolves.toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
  ])("fails closed when the configured key is %s", async (_label, key) => {
    // The interpolation trap: a caller as misconfigured as the callee
    // would send exactly what a naive compare accepts.
    await expect(isBrokerAuthorized("Bearer undefined", key)).resolves.toBe(
      false,
    );
    await expect(isBrokerAuthorized("Bearer ", key)).resolves.toBe(false);
    await expect(isBrokerAuthorized("Bearer null", key)).resolves.toBe(false);
    await expect(isBrokerAuthorized(undefined, key)).resolves.toBe(false);
  });

  it("admits a key longer than one hash block", async () => {
    // The comparison MACs both sides before comparing them, so a key
    // that spans several SHA-256 blocks exercises a different path
    // through Web Crypto than the short keys above.
    const long = "k".repeat(4096);
    await expect(isBrokerAuthorized(`Bearer ${long}`, long)).resolves.toBe(
      true,
    );
    await expect(isBrokerAuthorized(`Bearer ${long}x`, long)).resolves.toBe(
      false,
    );
  });

  it("compares bytes, not glyphs", async () => {
    // Two strings that render identically but differ byte for byte are
    // not interchangeable: the key is an opaque secret, not text to be
    // matched leniently. Precomposed U+00E9 against e + U+0301.
    await expect(isBrokerAuthorized("Bearer é", "é")).resolves.toBe(false);
    await expect(isBrokerAuthorized("Bearer é", "é")).resolves.toBe(true);
  });
});
