import { describe, it, expect, afterEach, vi } from "vitest";
import {
  envNumber,
  parseOtelSampleRatio,
  parseOtelHeaders,
  loadConfig,
  parseGrantInactivityDays,
  parseConnectorHoldMs,
  DEFAULT_CONNECTOR_HOLD_MS,
} from "./config.js";

/**
 * `Number(env) || default` swallows zero, so every numeric env read
 * checks for undefined or empty explicitly, `envNumber(raw, default)`
 * among them. This file pins down its semantics so drift away from that
 * check is caught locally rather than only at downstream call sites.
 */
describe("envNumber (zero-safe env reader)", () => {
  it("returns the fallback when raw is undefined", () => {
    expect(envNumber(undefined, 100)).toBe(100);
  });

  it("returns the fallback when raw is the empty string", () => {
    expect(envNumber("", 100)).toBe(100);
  });

  it("honors an explicit zero", () => {
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

describe("loadConfig MARFA_BLOB_MIN_COPIES", () => {
  const saved = process.env.MARFA_BLOB_MIN_COPIES;

  afterEach(() => {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, "MARFA_BLOB_MIN_COPIES");
    } else {
      process.env.MARFA_BLOB_MIN_COPIES = saved;
    }
  });

  it("defaults to one copy and takes a positive integer", () => {
    delete process.env.MARFA_BLOB_MIN_COPIES;
    expect(loadConfig().blobMinCopies).toBe(1);
    process.env.MARFA_BLOB_MIN_COPIES = "2";
    expect(loadConfig().blobMinCopies).toBe(2);
  });

  it("refuses to boot on zero, a negative or a non-number, which would let the last copy go", () => {
    for (const raw of ["0", "-1", "two", "1.5"]) {
      process.env.MARFA_BLOB_MIN_COPIES = raw;
      expect(() => loadConfig(), raw).toThrow(/MARFA_BLOB_MIN_COPIES/);
    }
  });
});

describe("loadConfig MARFA_CONNECTOR_HOLD_MS", () => {
  const saved = process.env.MARFA_CONNECTOR_HOLD_MS;

  afterEach(() => {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, "MARFA_CONNECTOR_HOLD_MS");
    } else {
      process.env.MARFA_CONNECTOR_HOLD_MS = saved;
    }
  });

  it("defaults to three minutes and takes a window from a second to an hour", () => {
    delete process.env.MARFA_CONNECTOR_HOLD_MS;
    expect(loadConfig().connectorHoldMs).toBe(DEFAULT_CONNECTOR_HOLD_MS);
    expect(DEFAULT_CONNECTOR_HOLD_MS).toBe(180_000);
    for (const [raw, ms] of [
      ["1000", 1_000],
      [" 60000 ", 60_000],
      ["3600000", 3_600_000],
    ] as const) {
      process.env.MARFA_CONNECTOR_HOLD_MS = raw;
      expect(loadConfig().connectorHoldMs, raw).toBe(ms);
    }
  });

  it("refuses to boot on a window outside its bounds or one that is not a whole number", () => {
    for (const raw of ["999", "3600001", "0", "-1000", "1.5e3", "2s"]) {
      expect(() => parseConnectorHoldMs(raw), raw).toThrow(
        /MARFA_CONNECTOR_HOLD_MS/,
      );
      process.env.MARFA_CONNECTOR_HOLD_MS = raw;
      expect(() => loadConfig(), raw).toThrow(/MARFA_CONNECTOR_HOLD_MS/);
    }
  });
});
