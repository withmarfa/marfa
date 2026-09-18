import { describe, it, expect, afterEach, vi } from "vitest";
import {
  envNumber,
  parseOtelSampleRatio,
  parseOtelHeaders,
  loadConfig,
  parseGrantInactivityDays,
} from "./config.js";

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

  it("honors an explicit zero (the bug §3.16 fixes)", () => {
    expect(envNumber("0", 100)).toBe(0);
  });

  it("honors negative numbers", () => {
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

describe("parseGrantInactivityDays", () => {
  it("defaults to a year when unset or empty, and 0 disables", () => {
    expect(parseGrantInactivityDays(undefined)).toBe(365);
    expect(parseGrantInactivityDays("")).toBe(365);
    expect(parseGrantInactivityDays("0")).toBe(0);
    expect(parseGrantInactivityDays("30")).toBe(30);
  });

  it("refuses a value that is not a non-negative integer, with a warning, rather than silently disabling", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(parseGrantInactivityDays("thirty")).toBe(365);
      expect(parseGrantInactivityDays("-5")).toBe(365);
      expect(parseGrantInactivityDays("1.5")).toBe(365);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
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

describe("loadConfig MARFA_AUTH_SECRET production guard", () => {
  // A valid API_KEY_SALT so the earlier production guard never fires —
  // isolates the MARFA_AUTH_SECRET assertion under test.
  const VALID_SALT = "a".repeat(32);
  const VALID_SECRET = "b".repeat(32);

  // Snapshot the three env vars this block mutates so cases can't leak
  // production mode or stale secrets into the rest of the suite.
  const savedNodeEnv = process.env.NODE_ENV;
  const savedSalt = process.env.API_KEY_SALT;
  const savedSecret = process.env.MARFA_AUTH_SECRET;

  function restore(value: string | undefined, key: string): void {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }

  afterEach(() => {
    restore(savedNodeEnv, "NODE_ENV");
    restore(savedSalt, "API_KEY_SALT");
    restore(savedSecret, "MARFA_AUTH_SECRET");
  });

  it("throws when MARFA_AUTH_SECRET is unset in production", () => {
    process.env.NODE_ENV = "production";
    process.env.API_KEY_SALT = VALID_SALT;
    delete process.env.MARFA_AUTH_SECRET;
    expect(() => loadConfig()).toThrow(/MARFA_AUTH_SECRET/);
  });

  it("throws when MARFA_AUTH_SECRET is shorter than 32 chars in production", () => {
    process.env.NODE_ENV = "production";
    process.env.API_KEY_SALT = VALID_SALT;
    process.env.MARFA_AUTH_SECRET = "c".repeat(31);
    expect(() => loadConfig()).toThrow(/MARFA_AUTH_SECRET/);
  });

  it("succeeds with a valid >=32-char MARFA_AUTH_SECRET in production", () => {
    process.env.NODE_ENV = "production";
    process.env.API_KEY_SALT = VALID_SALT;
    process.env.MARFA_AUTH_SECRET = VALID_SECRET;
    const config = loadConfig();
    expect(config.authSecret).toBe(VALID_SECRET);
  });

  it("does not throw outside production even when the secret is absent", () => {
    process.env.NODE_ENV = "test";
    delete process.env.API_KEY_SALT;
    delete process.env.MARFA_AUTH_SECRET;
    expect(() => loadConfig()).not.toThrow();
  });
});
