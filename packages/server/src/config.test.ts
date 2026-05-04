import { describe, it, expect } from "vitest";
import { envNumber } from "./config.js";

/**
 * §3.16 — `Number(env) || default` swallows zero. The canonical pattern
 * is now `envNumber(raw, default)`. This file pins down its semantics so
 * future drift away from the explicit-undefined check is caught locally
 * rather than only at downstream call sites.
 */
describe("envNumber (§3.16 zero-safe env reader)", () => {
  it("returns the fallback when raw is undefined", () => {
    expect(envNumber(undefined, 100)).toBe(100);
  });

  it("returns the fallback when raw is the empty string", () => {
    expect(envNumber("", 100)).toBe(100);
  });

  it("honours an explicit zero (the bug §3.16 fixes)", () => {
    expect(envNumber("0", 100)).toBe(0);
  });

  it("honours negative numbers", () => {
    expect(envNumber("-1", 100)).toBe(-1);
  });

  it("returns NaN for unparseable input rather than the fallback", () => {
    // Caller's responsibility to handle range/validity. envNumber's job
    // is only the "explicit-vs-missing" distinction; downstream parsers
    // (see parseEventLogRetentionHours) layer validity checks on top.
    expect(envNumber("nope", 100)).toBeNaN();
  });

  it("parses well-formed integers and floats", () => {
    expect(envNumber("42", 0)).toBe(42);
    expect(envNumber("3.14", 0)).toBeCloseTo(3.14);
  });
});
