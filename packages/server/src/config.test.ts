import { describe, it, expect, afterEach } from "vitest";
import {
  envNumber,
  parseDbPoolMode,
  parseIntegrationWorkerThreads,
  parseOtelSampleRatio,
  parseOtelHeaders,
  loadConfig,
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

// ---------------------------------------------------------------------------
// MARFA_DB_POOL_MODE — the fail-closed boot guard for streaming RLS
// ---------------------------------------------------------------------------

describe("parseDbPoolMode", () => {
  it("defaults to session when unset or empty", () => {
    // Self-hosts talk to Postgres directly, so the session-mode default keeps
    // them out of the guard entirely.
    expect(parseDbPoolMode(undefined)).toBe("session");
    expect(parseDbPoolMode("")).toBe("session");
  });

  it("honors both legal values", () => {
    expect(parseDbPoolMode("session")).toBe("session");
    expect(parseDbPoolMode("transaction")).toBe("transaction");
  });

  it("throws on an unrecognized value rather than picking a default", () => {
    // Warn-and-default (the pattern the other parsers in this file use) would
    // resolve a typo to the permissive mode, which is precisely the silent
    // downgrade this knob exists to prevent.
    expect(() => parseDbPoolMode("transacton")).toThrow(/MARFA_DB_POOL_MODE/);
  });
});

describe("parseIntegrationWorkerThreads", () => {
  it("returns undefined when unset or empty, keeping the executor default", () => {
    expect(parseIntegrationWorkerThreads(undefined)).toBeUndefined();
    expect(parseIntegrationWorkerThreads("")).toBeUndefined();
  });

  it("honors a positive integer", () => {
    expect(parseIntegrationWorkerThreads("1")).toBe(1);
    expect(parseIntegrationWorkerThreads("4")).toBe(4);
  });

  it("throws on zero, negatives, and non-numbers rather than starving the pool", () => {
    // A NaN or zero pool size would pre-warm no worker threads and leave
    // every dispatch waiting forever; the boot refusal names the variable.
    for (const raw of ["0", "-2", "two", "2.5"]) {
      expect(() => parseIntegrationWorkerThreads(raw)).toThrow(
        /MARFA_INTEGRATION_WORKER_THREADS/,
      );
    }
  });

  it("refuses Number()'s wider grammar, not just non-numbers", () => {
    // "1e2" is a valid Number (100) and a plausible typo; accepting it
    // silently pre-warms a hundred threads per integration. Hex and
    // signed forms are refused for the same reason: an env value that is
    // not plain digits is a mistake, not an encoding choice.
    for (const raw of ["1e2", "0x4", "+4"]) {
      expect(() => parseIntegrationWorkerThreads(raw)).toThrow(
        /MARFA_INTEGRATION_WORKER_THREADS/,
      );
    }
    // Surrounding whitespace is the one tolerated deviation, matching how
    // env files commonly render.
    expect(parseIntegrationWorkerThreads(" 4 ")).toBe(4);
  });
});

describe("loadConfig streaming-RLS endpoint guard", () => {
  const saved = {
    DB_DIALECT: process.env.DB_DIALECT,
    DATABASE_URL: process.env.DATABASE_URL,
    MARFA_DB_POOL_MODE: process.env.MARFA_DB_POOL_MODE,
    MARFA_DATABASE_URL_DIRECT: process.env.MARFA_DATABASE_URL_DIRECT,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  it("throws naming MARFA_DATABASE_URL_DIRECT on a transaction-mode pool with no direct endpoint", () => {
    process.env.DB_DIALECT = "pg";
    process.env.DATABASE_URL = "postgres://user:pw@pooler.example/marfa";
    process.env.MARFA_DB_POOL_MODE = "transaction";
    delete process.env.MARFA_DATABASE_URL_DIRECT;
    expect(() => loadConfig()).toThrow(/MARFA_DATABASE_URL_DIRECT/);
  });

  it("treats an empty direct URL the same as an unset one", () => {
    process.env.DB_DIALECT = "pg";
    process.env.DATABASE_URL = "postgres://user:pw@pooler.example/marfa";
    process.env.MARFA_DB_POOL_MODE = "transaction";
    process.env.MARFA_DATABASE_URL_DIRECT = "";
    expect(() => loadConfig()).toThrow(/MARFA_DATABASE_URL_DIRECT/);
  });

  it("throws when the direct endpoint is the pooled one again", () => {
    // The realistic misconfiguration, not the hypothetical one: the deploy
    // resolves the two URLs from adjacent variable names, and on Neon the
    // hostnames differ by the six characters of the `-pooler` suffix. A
    // presence check passes this, and so does every other signal downstream.
    process.env.DB_DIALECT = "pg";
    process.env.DATABASE_URL = "postgres://user:pw@pooler.example:5432/marfa";
    process.env.MARFA_DATABASE_URL_DIRECT =
      "postgres://user:pw@pooler.example:5432/marfa";
    process.env.MARFA_DB_POOL_MODE = "transaction";
    expect(() => loadConfig()).toThrow(/same endpoint as DATABASE_URL/);
  });

  it("names only the host and port when it refuses, never the credentials", () => {
    // Boot failures land in logs an operator pastes around, so the message has
    // to be actionable without carrying the password.
    process.env.DB_DIALECT = "pg";
    process.env.DATABASE_URL = "postgres://user:hunter2@pooler.example/marfa";
    process.env.MARFA_DATABASE_URL_DIRECT =
      "postgres://user:hunter2@pooler.example/marfa";
    process.env.MARFA_DB_POOL_MODE = "transaction";
    let message = "";
    try {
      loadConfig();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("pooler.example:5432");
    expect(message).not.toContain("hunter2");
  });

  it("succeeds on a transaction-mode pool once the direct endpoint is configured", () => {
    process.env.DB_DIALECT = "pg";
    process.env.DATABASE_URL = "postgres://user:pw@pooler.example/marfa";
    process.env.MARFA_DB_POOL_MODE = "transaction";
    process.env.MARFA_DATABASE_URL_DIRECT =
      "postgres://user:pw@direct.example/marfa";
    const config = loadConfig();
    expect(config.dbPoolMode).toBe("transaction");
    expect(config.databaseUrlDirect).toBe(
      "postgres://user:pw@direct.example/marfa",
    );
  });

  it("leaves session-mode deployments alone when no direct endpoint is set", () => {
    process.env.DB_DIALECT = "pg";
    process.env.DATABASE_URL = "postgres://user:pw@direct.example/marfa";
    delete process.env.MARFA_DB_POOL_MODE;
    delete process.env.MARFA_DATABASE_URL_DIRECT;
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().dbPoolMode).toBe("session");
  });

  it("does not fire on SQLite, which has no pooler to strand a role on", () => {
    process.env.DB_DIALECT = "sqlite";
    process.env.MARFA_DB_POOL_MODE = "transaction";
    delete process.env.MARFA_DATABASE_URL_DIRECT;
    expect(() => loadConfig()).not.toThrow();
  });
});
