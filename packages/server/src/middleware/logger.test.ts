import { afterEach, describe, expect, it } from "vitest";
import {
  formatErrorSummary,
  resolveRequestId,
  serializeError,
} from "./logger.js";
import { isValidId } from "@withmarfa/shared";

// ---------------------------------------------------------------------------
// resolveRequestId — client passthrough with validation
// ---------------------------------------------------------------------------

describe("resolveRequestId", () => {
  it("generates a UUIDv7 when the client sends no header", () => {
    const id = resolveRequestId(undefined);
    expect(isValidId(id)).toBe(true);
  });

  it("generates a UUIDv7 when the client sends an empty string", () => {
    const id = resolveRequestId("");
    expect(isValidId(id)).toBe(true);
  });

  it("passes through a client-provided UUIDv7 verbatim", () => {
    // Matches the shape stamped by the Swift SDK's URLSessionTransport
    // (UUIDv7.generateString()).
    const clientId = "019d1234-5678-7abc-8def-1234567890ab";
    expect(resolveRequestId(clientId)).toBe(clientId);
  });

  it("passes through alphanumeric correlation IDs from third-party tooling", () => {
    // Datadog-style trace ID — pure digits, within the length cap.
    expect(resolveRequestId("1234567890123456")).toBe("1234567890123456");
    // GitHub-style action run ID with dashes.
    expect(resolveRequestId("run-abc123_xyz")).toBe("run-abc123_xyz");
  });

  it("rejects headers with unsafe characters (newlines, spaces, slashes)", () => {
    // Newlines would log-inject; spaces would break log grep patterns.
    for (const bad of [
      "abc\ndef",
      "abc def",
      "abc/def",
      "abc;def",
      'abc"def',
      "<script>alert(1)</script>",
    ]) {
      const resolved = resolveRequestId(bad);
      expect(resolved).not.toBe(bad);
      expect(isValidId(resolved)).toBe(true);
    }
  });

  it("rejects headers longer than 128 characters", () => {
    const longId = "a".repeat(129);
    const resolved = resolveRequestId(longId);
    expect(resolved).not.toBe(longId);
    expect(isValidId(resolved)).toBe(true);
  });

  it("accepts a header exactly at the 128-character cap", () => {
    const capId = "a".repeat(128);
    expect(resolveRequestId(capId)).toBe(capId);
  });
});

// ---------------------------------------------------------------------------
// Error serialization — a failed boot must be diagnosable from one log line
// ---------------------------------------------------------------------------

/**
 * The shape Node raises when every address a hostname resolves to refuses
 * the connection: an AggregateError with an empty own message, all the
 * detail hanging off `errors`.
 */
function connectionRefused(): AggregateError {
  const mk = (address: string): Error =>
    Object.assign(new Error(`connect ECONNREFUSED ${address}:5432`), {
      code: "ECONNREFUSED",
      errno: -61,
      syscall: "connect",
      address,
      port: 5432,
    });
  return new AggregateError([mk("::1"), mk("127.0.0.1")], "");
}

/** A `postgres.js` server-side error: SQLSTATE 55P03 is lock_not_available. */
function lockNotAvailable(): Error {
  return Object.assign(new Error("canceling statement due to lock timeout"), {
    code: "55P03",
    severity: "ERROR",
    routine: "ProcessInterrupts",
  });
}

describe("formatErrorSummary", () => {
  it("never returns an empty string for an error with no message", () => {
    expect(formatErrorSummary(new Error(""))).not.toBe("");
    expect(formatErrorSummary(new AggregateError([], ""))).not.toBe("");
    expect(formatErrorSummary(undefined)).toBe("unknown error");
  });

  it("surfaces the real failure behind an empty-message AggregateError", () => {
    const summary = formatErrorSummary(connectionRefused());
    // The regression: a naive `err.message` read produced "" for exactly this.
    expect(summary).toContain("ECONNREFUSED");
    expect(summary).toContain("5432");
  });

  it("keeps the SQLSTATE code on a Postgres lock failure", () => {
    const summary = formatErrorSummary(lockNotAvailable());
    expect(summary).toContain("lock timeout");
    expect(summary).toContain("55P03");
  });

  it("walks the cause chain", () => {
    const err = new Error("storage init failed", {
      cause: new Error("pool acquire failed", { cause: lockNotAvailable() }),
    });
    const summary = formatErrorSummary(err);
    expect(summary).toContain("storage init failed");
    expect(summary).toContain("pool acquire failed");
    expect(summary).toContain("55P03");
  });

  it("terminates on a self-referential cause chain", () => {
    const err: Error & { cause?: unknown } = new Error("looping");
    err.cause = err;
    expect(() => formatErrorSummary(err)).not.toThrow();
    expect(formatErrorSummary(err)).toContain("looping");
  });

  it("handles thrown non-Error values", () => {
    expect(formatErrorSummary("plain string throw")).toBe("plain string throw");
    expect(formatErrorSummary(42)).toBe("42");
  });
});

describe("serializeError", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("keeps every branch of an AggregateError with its socket detail", () => {
    const out = serializeError(connectionRefused()) as {
      name: string;
      message: string;
      errors: { code: string; address: string; port: number }[];
    };
    expect(out.name).toBe("AggregateError");
    expect(out.errors).toHaveLength(2);
    expect(out.errors[0]).toMatchObject({
      code: "ECONNREFUSED",
      address: "::1",
      port: 5432,
    });
  });

  it("keeps the Postgres diagnostic fields", () => {
    const out = serializeError(lockNotAvailable()) as Record<string, unknown>;
    expect(out.code).toBe("55P03");
    expect(out.severity).toBe("ERROR");
    expect(out.routine).toBe("ProcessInterrupts");
  });

  it("nests the cause chain", () => {
    const out = serializeError(
      new Error("outer", { cause: new Error("inner") }),
    ) as { cause: { message: string } };
    expect(out.cause.message).toBe("inner");
  });

  it("omits stacks in production and includes them otherwise", () => {
    process.env.NODE_ENV = "production";
    expect(serializeError(new Error("boom"))).not.toHaveProperty("stack");
    process.env.NODE_ENV = "development";
    expect(serializeError(new Error("boom"))).toHaveProperty("stack");
  });

  it("terminates on a self-referential cause chain", () => {
    const err: Error & { cause?: unknown } = new Error("looping");
    err.cause = err;
    expect(() => JSON.stringify(serializeError(err))).not.toThrow();
  });
});
