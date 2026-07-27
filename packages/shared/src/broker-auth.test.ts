/**
 * The rule both ends of the broker hop agree on. Pinned here rather
 * than in either caller so a change to the comparison has to be a
 * deliberate edit to a test that names what it protects.
 */
import { describe, it, expect } from "vitest";
import { isBrokerAuthorized } from "./broker-auth.js";

const KEY = "broker_key_value";

describe("isBrokerAuthorized", () => {
  it("admits the exact Bearer form", () => {
    expect(isBrokerAuthorized(`Bearer ${KEY}`, KEY)).toBe(true);
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
  ])("refuses %s", (_label, header) => {
    expect(isBrokerAuthorized(header, KEY)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
  ])("fails closed when the configured key is %s", (_label, key) => {
    // The interpolation trap: a caller as misconfigured as the callee
    // would send exactly what a naive compare accepts.
    expect(isBrokerAuthorized("Bearer undefined", key)).toBe(false);
    expect(isBrokerAuthorized("Bearer ", key)).toBe(false);
    expect(isBrokerAuthorized("Bearer null", key)).toBe(false);
    expect(isBrokerAuthorized(undefined, key)).toBe(false);
  });
});
