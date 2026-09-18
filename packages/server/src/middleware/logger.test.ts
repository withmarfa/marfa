import { afterEach, describe, expect, it } from "vitest";
import {
  formatErrorSummary,
  log,
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

/** A database error carrying an SQLSTATE: 55P03 is lock_not_available. */
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

  it("keeps the SQLSTATE code on a lock failure", () => {
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

  it("keeps the driver's diagnostic fields", () => {
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

// ---------------------------------------------------------------------------
// log() payload serialization
// ---------------------------------------------------------------------------

/**
 * `JSON.stringify` renders an `Error` as `{}` — its message, name, and
 * SQLSTATE all live on non-enumerable properties. The Better Auth logger
 * bridge hands `log()` a payload shaped `{ args: [Error] }`, so a database
 * permission failure reached the log line as `{"args":[{}]}` and the absence
 * of "permission denied" in the logs was then read as evidence that no
 * permission error was occurring. Anything Error-shaped in a logged payload
 * has to survive the trip.
 */
describe("the OpenTelemetry mirror", () => {
  // **The one line whose message is a credential must not be exported.** The
  // redaction processor rewrites attributes and deliberately leaves the body
  // alone, on the reasoning that a message string is Marfa-controlled and so
  // safe by construction. The bootstrap secret breaks that reasoning: it has
  // to be readable by whoever runs the instance and by nobody further, and
  // exporting it turns "can read the boot log" into "can read the
  // observability backend".
  //
  // Asserted through the real logs API rather than a spy on the private
  // helper, because the helper is what a refactor would move.
  it("skips a line marked localOnly and mirrors every other", async () => {
    const { logs } = await import("@opentelemetry/api-logs");
    const emitted: string[] = [];
    const previous = logs.getLogger.bind(logs);
    // @ts-expect-error — replacing the accessor for the duration of the case.
    logs.getLogger = () => ({
      emit: (record: { body?: unknown }) => {
        emitted.push(String(record.body));
      },
    });
    const stdout: string[] = [];
    const writer = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
      stdout.push(chunk);
      return true;
    };
    try {
      log("warn", "secret-bearing line", undefined, { localOnly: true });
      log("warn", "ordinary line");
    } finally {
      process.stdout.write = writer;
      logs.getLogger = previous;
    }

    // Both reach the operator's own log.
    expect(stdout.join("")).toContain("secret-bearing line");
    expect(stdout.join("")).toContain("ordinary line");
    // Only one leaves the machine.
    expect(emitted).toEqual(["ordinary line"]);
  });
});

describe("log payload serialization", () => {
  function captureLog(
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): Record<string, unknown> {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      log(level, message, data);
    } finally {
      process.stdout.write = original;
    }
    return JSON.parse(written.join("")) as Record<string, unknown>;
  }

  /** Shape of a database privilege error, SQLSTATE and all. */
  function permissionDenied(): Error {
    return Object.assign(
      new Error("permission denied for table auth_session"),
      { code: "42501", severity: "ERROR", routine: "aclcheck_error" },
    );
  }

  it("preserves an error nested inside an array, as Better Auth passes it", () => {
    const entry = captureLog("error", "Better Auth: INTERNAL_SERVER_ERROR", {
      args: [permissionDenied()],
    });
    const args = entry.args as Record<string, unknown>[];
    expect(args[0]?.message).toBe("permission denied for table auth_session");
    expect(args[0]?.code).toBe("42501");
  });

  it("adds a one-line error summary carrying the message and SQLSTATE", () => {
    const entry = captureLog("error", "Better Auth: INTERNAL_SERVER_ERROR", {
      args: [permissionDenied()],
    });
    expect(entry.error_summary).toContain(
      "permission denied for table auth_session",
    );
    expect(entry.error_summary).toContain("42501");
  });

  it("preserves an error passed directly and one nested in an object", () => {
    const direct = captureLog("error", "boom", { error: permissionDenied() });
    const error = direct.error as Record<string, unknown>;
    expect(error.message).toBe("permission denied for table auth_session");
    expect(error.code).toBe("42501");

    const nested = captureLog("error", "boom", {
      context: { cause: permissionDenied() },
    });
    const context = nested.context as Record<string, Record<string, unknown>>;
    expect(context.cause?.message).toBe(
      "permission denied for table auth_session",
    );
    expect(context.cause?.code).toBe("42501");
  });

  it("leaves ordinary payload values untouched", () => {
    const entry = captureLog("info", "Server version", {
      sha: "abc123",
      count: 3,
      enabled: true,
      list: ["a", "b"],
      nothing: null,
    });
    expect(entry.sha).toBe("abc123");
    expect(entry.count).toBe(3);
    expect(entry.enabled).toBe(true);
    expect(entry.list).toEqual(["a", "b"]);
    expect(entry.nothing).toBeNull();
    expect(entry).not.toHaveProperty("error_summary");
  });

  it("does not overwrite an error_summary the caller supplied itself", () => {
    const entry = captureLog("error", "boom", {
      error: permissionDenied(),
      error_summary: "caller's own summary",
    });
    expect(entry.error_summary).toBe("caller's own summary");
  });

  it("survives a circular payload rather than throwing inside the logger", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => captureLog("warn", "circular", circular)).not.toThrow();
    const entry = captureLog("warn", "circular", circular);
    expect((entry.self as Record<string, unknown>).self).toBe("[circular]");
  });

  // -------------------------------------------------------------------------
  // Repetition is not recursion
  // -------------------------------------------------------------------------

  /**
   * Cycle detection scoped to the whole traversal instead of the current path
   * renders the second and every later appearance of a shared object as
   * `"[circular]"`. Sharing is the normal case in a log payload — the same
   * space on every row, one config object referenced twice — so that failure
   * mode silently deletes evidence at the log layer, which is the exact way the
   * original root cause stayed hidden.
   */
  describe("repeated but acyclic values", () => {
    it("renders a shared object in full at every position", () => {
      const space = { id: "t_1", name: "Acme" };
      const entry = captureLog("info", "rows", {
        rows: [{ space }, { space }, { space }],
      });
      const rows = entry.rows as { space: Record<string, unknown> }[];
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.space).toEqual({ id: "t_1", name: "Acme" });
      }
    });

    it("renders a value repeated across sibling keys", () => {
      const shared = { region: "eu-west-2" };
      const entry = captureLog("info", "config", {
        primary: shared,
        replica: shared,
      });
      expect(entry.primary).toEqual({ region: "eu-west-2" });
      expect(entry.replica).toEqual({ region: "eu-west-2" });
    });

    it("still catches a value that contains itself indirectly", () => {
      const outer: Record<string, unknown> = { name: "outer" };
      const inner: Record<string, unknown> = { name: "inner", back: outer };
      outer.inner = inner;
      const entry = captureLog("warn", "indirect cycle", { outer });
      const rendered = entry.outer as Record<string, Record<string, unknown>>;
      expect(rendered.inner?.name).toBe("inner");
      expect(rendered.inner?.back).toBe("[circular]");
    });
  });

  // -------------------------------------------------------------------------
  // Totality — a logger that throws destroys more than one that logs badly
  // -------------------------------------------------------------------------

  describe("hostile payloads", () => {
    /** Reads the raw bytes written, so "emitted nothing" is distinguishable. */
    function captureRaw(data: Record<string, unknown>): string {
      const written: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: string | Uint8Array): boolean => {
        written.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      };
      try {
        log("error", "hostile", data);
      } finally {
        process.stdout.write = original;
      }
      return written.join("");
    }

    it("emits a line for a property whose getter throws, keeping its siblings", () => {
      // A lazily-resolved relation on a torn-down connection behaves this way,
      // and it reaches the logger precisely when the connection is what broke.
      const payload: Record<string, unknown> = { request_id: "req_1" };
      Object.defineProperty(payload, "detail", {
        enumerable: true,
        get() {
          throw new Error("getter exploded");
        },
      });
      const raw = captureRaw(payload);
      expect(raw).not.toBe("");
      const entry = JSON.parse(raw) as Record<string, unknown>;
      expect(entry.request_id).toBe("req_1");
      expect(String(entry.detail)).toContain("getter exploded");
    });

    it("emits a line for an Error whose message getter throws", () => {
      class LazyError extends Error {
        override get message(): string {
          throw new Error("message unavailable");
        }
      }
      const raw = captureRaw({ args: [new LazyError()] });
      expect(raw).not.toBe("");
      const entry = JSON.parse(raw) as Record<string, unknown>;
      expect(entry.error_summary).toBeDefined();
      const args = entry.args as Record<string, unknown>[];
      expect(String(args[0]?.message)).toContain("message unavailable");
    });

    it("emits a line for a value whose toJSON throws", () => {
      const raw = captureRaw({
        payload: {
          toJSON() {
            throw new Error("toJSON exploded");
          },
        },
      });
      expect(raw).not.toBe("");
      const entry = JSON.parse(raw) as Record<string, unknown>;
      expect(String(entry.payload)).toContain("toJSON exploded");
    });

    it("renders a BigInt rather than letting it take the line down", () => {
      // `JSON.stringify` throws outright on a BigInt — not a silent drop, a
      // TypeError that would propagate out of the logger.
      const raw = captureRaw({ rows_scanned: 9007199254740993n });
      expect(raw).not.toBe("");
      const entry = JSON.parse(raw) as Record<string, unknown>;
      expect(entry.rows_scanned).toBe("9007199254740993");
    });

    it("keeps values JSON.stringify would silently drop", () => {
      const raw = captureRaw({
        handler: function retryUpload() {
          return null;
        },
        marker: Symbol("boundary"),
      });
      const entry = JSON.parse(raw) as Record<string, unknown>;
      expect(entry.handler).toBe("[function retryUpload]");
      expect(String(entry.marker)).toContain("boundary");
    });

    it("keeps a Date readable instead of flattening it to an empty object", () => {
      // A Date has no own enumerable properties, so rebuilding it field by
      // field yields `{}` and the timestamp is gone.
      const raw = captureRaw({ started_at: new Date("2026-07-27T12:00:00Z") });
      const entry = JSON.parse(raw) as Record<string, unknown>;
      expect(entry.started_at).toBe("2026-07-27T12:00:00.000Z");
    });

    it("never throws, whatever it is handed", () => {
      const throwingGetter: Record<string, unknown> = {};
      Object.defineProperty(throwingGetter, "boom", {
        enumerable: true,
        get() {
          throw new Error("nope");
        },
      });
      class LazyError extends Error {
        override get message(): string {
          throw new Error("nope");
        }
      }
      const selfReferential: Record<string, unknown> = {};
      selfReferential.self = selfReferential;

      const payloads: Record<string, unknown>[] = [
        throwingGetter,
        { err: new LazyError() },
        {
          bad: {
            toJSON() {
              throw new Error("nope");
            },
          },
        },
        { big: 1n },
        selfReferential,
        {
          proxied: new Proxy(
            {},
            {
              ownKeys() {
                throw new Error("nope");
              },
            },
          ),
        },
        { deep: JSON.parse('{"a":{"b":{"c":{"d":{"e":{"f":{"g":1}}}}}}}') },
      ];
      for (const payload of payloads) {
        expect(() => captureRaw(payload)).not.toThrow();
        expect(captureRaw(payload)).not.toBe("");
      }
    });
  });
});
