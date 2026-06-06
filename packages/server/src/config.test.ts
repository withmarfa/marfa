import { describe, it, expect } from "vitest";
import { envNumber, parseOtelSampleRatio, parseOtelHeaders } from "./config.js";

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

describe("parseOtelSampleRatio", () => {
  it("defaults to 0.05 when unset or empty", () => {
    expect(parseOtelSampleRatio(undefined)).toBe(0.05);
    expect(parseOtelSampleRatio("")).toBe(0.05);
  });

  it("honors a valid in-range ratio", () => {
    expect(parseOtelSampleRatio("0.25")).toBe(0.25);
    expect(parseOtelSampleRatio("1")).toBe(1);
    expect(parseOtelSampleRatio("0")).toBe(0);
  });

  it("clamps out-of-range values into [0, 1]", () => {
    expect(parseOtelSampleRatio("5")).toBe(1);
    expect(parseOtelSampleRatio("-0.5")).toBe(0);
  });

  it("falls back to the default on unparseable input", () => {
    expect(parseOtelSampleRatio("nope")).toBe(0.05);
  });
});

describe("parseOtelHeaders", () => {
  it("returns an empty object when unset", () => {
    expect(parseOtelHeaders(undefined)).toEqual({});
    expect(parseOtelHeaders("")).toEqual({});
  });

  it("parses comma-separated key=value pairs and trims whitespace", () => {
    expect(parseOtelHeaders("X-A=1, X-B = 2")).toEqual({
      "X-A": "1",
      "X-B": "2",
    });
  });

  it("keeps '=' inside a value (splits on the first only)", () => {
    expect(parseOtelHeaders("Authorization=Bearer abc=def")).toEqual({
      Authorization: "Bearer abc=def",
    });
  });

  it("skips malformed entries", () => {
    expect(parseOtelHeaders("=novalue,good=ok,nokey")).toEqual({ good: "ok" });
  });
});
