import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  formatErrorSummary,
  log,
  loggerMiddleware,
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
    // A UUIDv7, which is the shape this server mints when a client sends
    // none, so a client stamping its own is indistinguishable downstream.
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
 * detail hanging off `errors`. An outbound webhook to a host that is not
 * listening reaches it through the `cause` of a `fetch` failure, which is
 * why the summary has to walk both a cause and an `errors` array.
 */
function connectionRefused(): AggregateError {
  const mk = (address: string): Error =>
    Object.assign(new Error(`connect ECONNREFUSED ${address}:9099`), {
      code: "ECONNREFUSED",
      errno: -61,
      syscall: "connect",
      address,
      port: 9099,
    });
  return Object.assign(new AggregateError([mk("::1"), mk("127.0.0.1")], ""), {
    code: "ECONNREFUSED",
  });
}

/**
 * The other outbound failure, and the only one that reaches `hostname`: a
 * name that does not resolve. No `address` and no `port`, because nothing
 * was ever dialed.
 */
function nameNotResolved(): Error {
  return Object.assign(new Error("getaddrinfo ENOTFOUND webhook.invalid"), {
    errno: -3008,
    code: "ENOTFOUND",
    syscall: "getaddrinfo",
    hostname: "webhook.invalid",
  });
}

/**
 * What libsql raises when a second connection meets a held write lock.
 *
 * The field names and values are the driver's, taken from a real
 * `@libsql/client` failure rather than written from memory: the wrapper
 * carries `code`, `extendedCode` and `rawCode`, and the `SqliteError` it
 * wraps carries the bare message under `cause`.
 */
function databaseLocked(): Error {
  return Object.assign(new Error("SQLITE_BUSY: database is locked"), {
    name: "LibsqlError",
    code: "SQLITE_BUSY",
    extendedCode: "SQLITE_BUSY",
    rawCode: 5,
    cause: Object.assign(new Error("database is locked"), {
      name: "SqliteError",
      code: "SQLITE_BUSY",
      rawCode: 5,
    }),
  });
}

/**
 * A constraint failure, which is the case `extendedCode` exists for: every
 * one of them answers `SQLITE_CONSTRAINT` on `code`, and only the extended
 * code says which constraint.
 *
 * The wrapped `SqliteError` is the half that matters to the summary. libsql
 * prefixes the wrapper's own message with the code, so a summary that never
 * appended a code would still read `SQLITE_CONSTRAINT` off the message; the
 * `cause` carries the bare message and the extended code apart, which is the
 * only place the appending is visible.
 */
function uniqueViolation(): Error {
  return Object.assign(
    new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: items.id"),
    {
      name: "LibsqlError",
      code: "SQLITE_CONSTRAINT",
      extendedCode: "SQLITE_CONSTRAINT_PRIMARYKEY",
      rawCode: 1555,
      cause: Object.assign(new Error("UNIQUE constraint failed: items.id"), {
        name: "SqliteError",
        code: "SQLITE_CONSTRAINT_PRIMARYKEY",
        rawCode: 1555,
      }),
    },
  );
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
    expect(summary).toContain("9099");
  });

  it("carries the driver's message through on a lock failure", () => {
    const summary = formatErrorSummary(databaseLocked());
    expect(summary).toContain("database is locked");
    expect(summary).toContain("SQLITE_BUSY");
  });

  // The witness for the appending itself. Every assertion above would pass
  // on the message alone, because libsql writes the code into the wrapper's
  // message; the wrapped `SqliteError` does not, so the extended code only
  // reaches the summary if the code is read off the value and appended.
  it("appends a code the message does not already carry", () => {
    const summary = formatErrorSummary(uniqueViolation());
    expect(summary).toContain("UNIQUE constraint failed: items.id");
    expect(summary).toContain("SQLITE_CONSTRAINT_PRIMARYKEY");
    // And it is not there through the wrapper, whose message names only the
    // unextended code.
    expect(uniqueViolation().message).not.toContain(
      "SQLITE_CONSTRAINT_PRIMARYKEY",
    );
  });

  it("walks the cause chain", () => {
    const err = new Error("storage init failed", {
      cause: new Error("write transaction failed", { cause: databaseLocked() }),
    });
    const summary = formatErrorSummary(err);
    expect(summary).toContain("storage init failed");
    expect(summary).toContain("write transaction failed");
    expect(summary).toContain("SQLITE_BUSY");
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
      port: 9099,
    });
  });

  it("keeps the driver's diagnostic fields", () => {
    const out = serializeError(databaseLocked()) as Record<string, unknown>;
    expect(out.code).toBe("SQLITE_BUSY");
    expect(out.rawCode).toBe(5);
  });

  // The pair `code` alone cannot tell apart. Every constraint failure the
  // driver raises answers `SQLITE_CONSTRAINT`, so a log line carrying only
  // that says a write was refused and not what refused it.
  // `hostname` earns its place on a name that never resolved: there is no
  // socket, so `address` and `port` are absent and it is the only field
  // naming what the server failed to reach.
  it("keeps the hostname a DNS failure names", () => {
    const out = serializeError(nameNotResolved()) as Record<string, unknown>;
    expect(out.hostname).toBe("webhook.invalid");
    expect(out.code).toBe("ENOTFOUND");
    expect(out).not.toHaveProperty("address");
  });

  it("keeps the extended code that separates one constraint from another", () => {
    const out = serializeError(uniqueViolation()) as Record<string, unknown>;
    expect(out.code).toBe("SQLITE_CONSTRAINT");
    expect(out.extendedCode).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    expect(out.rawCode).toBe(1555);
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

describe("the OpenTelemetry mirror", () => {
  // **The one line whose message is a credential must not be exported.** The
  // redaction processor rewrites attributes and deliberately leaves the body
  // alone, on the reasoning that a message string is Marfa-controlled and so
  // safe by construction. The bootstrap secret breaks that reasoning: it has
  // to be readable by whoever runs the instance and by nobody further, and
  // exporting it turns "can read the boot log" into "can read the
  // observability stack".
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

/**
 * The request line names the operation that answered, not only the concrete
 * path, because `check:statuses` in the conformance suite holds the statuses
 * observed on an operation to the ones its document declares. With the
 * concrete path alone every id is its own door and there is nothing to hold.
 */
describe("the matched route on a request line", () => {
  async function lineFor(
    build: (app: Hono) => void,
    path: string,
    method = "GET",
  ): Promise<Record<string, unknown>> {
    const app = new Hono();
    app.use("*", loggerMiddleware());
    // A second universal middleware, as the real chain has several: none of
    // them is the route that answered.
    app.use("*", async (_c, next) => next());
    build(app);

    const stdout: string[] = [];
    const writer = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
      stdout.push(chunk);
      return true;
    };
    try {
      await app.request(path, { method });
    } finally {
      process.stdout.write = writer;
    }
    const lines = stdout.join("").trim().split("\n");
    return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<
      string,
      unknown
    >;
  }

  it("names the template in the document's spelling, not the concrete path", async () => {
    const entry = await lineFor((app) => {
      app.get("/items/:id/purge", (c) => c.text("ok"));
    }, "/items/019537a0-7b80-7000-8000-000000000000/purge");

    expect(entry.route).toBe("/items/{id}/purge");
    expect(entry.path).toBe(
      "/items/019537a0-7b80-7000-8000-000000000000/purge",
    );
  });

  // The regression the `routePath(c, -1)` spelling would carry. Better Auth
  // mounts `/auth/*` after the explicit auth routes, so the last matching
  // pattern is the catch-all on every one of them.
  it("names the handler that answered, not a catch-all registered after it", async () => {
    const entry = await lineFor((app) => {
      app.get("/auth/sign-in", (c) => c.text("explicit"));
      app.all("/auth/*", (c) => c.text("catch-all"));
    }, "/auth/sign-in");

    expect(entry.route).toBe("/auth/sign-in");
  });

  it("carries no route when nothing but the universal middleware matched", async () => {
    const entry = await lineFor((app) => {
      app.get("/items", (c) => c.text("ok"));
    }, "/nothing-here");

    expect(entry.status).toBe(404);
    expect(entry).not.toHaveProperty("route");
  });

  // The witness for the case above: the field is absent because no route
  // answered, not because nothing ever writes it.
  it("carries the route when one did answer the same app", async () => {
    const entry = await lineFor((app) => {
      app.get("/items", (c) => c.text("ok"));
    }, "/items");

    expect(entry.route).toBe("/items");
  });

  // The 413 the body-size cap answers, and the 429 the limiter answers,
  // both come from a universal middleware that never calls `next()`. The
  // router matched the door all the same, and a status recorded against no
  // operation is one no declaration can be held to.
  it("names the door a universal middleware refused before the handler ran", async () => {
    const entry = await lineFor(
      (app) => {
        app.use("*", async (c) =>
          Promise.resolve(
            c.json({ error: { code: "request_too_large" } }, 413),
          ),
        );
        app.post("/items", (c) => c.text("never reached"));
      },
      "/items",
      "POST",
    );

    expect(entry.status).toBe(413);
    expect(entry.route).toBe("/items");
  });

  it("names the route a refused request reached", async () => {
    const entry = await lineFor((app) => {
      app.get("/items/:id", () => {
        throw new Error("boom");
      });
    }, "/items/019537a0-7b80-7000-8000-000000000000");

    expect(entry.status).toBe(500);
    expect(entry.route).toBe("/items/{id}");
  });
});

/**
 * `JSON.stringify` renders a plain `Error` as `{}`: its message, stack and
 * cause are all non-enumerable. The Better Auth logger bridge hands `log()`
 * a payload shaped `{ args: [Error] }`, so without the rendering below a
 * failed query reaches the log line as `{"args":[{}]}` and the absence reads
 * as evidence that nothing is failing. A `LibsqlError` keeps its enumerable
 * `code` and loses the message that says what the code was raised over,
 * which is the same defect wearing a complete-looking record. Anything
 * Error-shaped in a logged payload has to survive the trip.
 */
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

  /**
   * What Better Auth's queries meet when the schema behind them has not
   * landed: libsql's `SQLITE_ERROR`, naming the table it could not find.
   */
  function noSuchTable(): Error {
    return Object.assign(
      new Error("SQLITE_ERROR: no such table: auth_session"),
      {
        name: "LibsqlError",
        code: "SQLITE_ERROR",
        extendedCode: "SQLITE_ERROR",
        rawCode: 1,
        cause: Object.assign(new Error("no such table: auth_session"), {
          name: "SqliteError",
          code: "SQLITE_ERROR",
          rawCode: 1,
        }),
      },
    );
  }

  it("preserves an error nested inside an array, as Better Auth passes it", () => {
    const entry = captureLog("error", "Better Auth: INTERNAL_SERVER_ERROR", {
      args: [noSuchTable()],
    });
    const args = entry.args as Record<string, unknown>[];
    expect(args[0]?.message).toBe("SQLITE_ERROR: no such table: auth_session");
    expect(args[0]?.code).toBe("SQLITE_ERROR");
  });

  it("adds a one-line error summary carrying the failing message", () => {
    const entry = captureLog("error", "Better Auth: INTERNAL_SERVER_ERROR", {
      args: [noSuchTable()],
    });
    expect(entry.error_summary).toContain("no such table: auth_session");
    expect(entry.error_summary).toContain("SQLITE_ERROR");
  });

  it("preserves an error passed directly and one nested in an object", () => {
    const direct = captureLog("error", "boom", { error: noSuchTable() });
    const error = direct.error as Record<string, unknown>;
    expect(error.message).toBe("SQLITE_ERROR: no such table: auth_session");
    expect(error.code).toBe("SQLITE_ERROR");

    const nested = captureLog("error", "boom", {
      context: { cause: noSuchTable() },
    });
    const context = nested.context as Record<string, Record<string, unknown>>;
    expect(context.cause?.message).toBe(
      "SQLITE_ERROR: no such table: auth_session",
    );
    expect(context.cause?.code).toBe("SQLITE_ERROR");
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
      error: noSuchTable(),
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
   * client on every row, one config object referenced twice — so that failure
   * mode silently deletes evidence at the log layer, which is the exact way the
   * original root cause stayed hidden.
   */
  describe("repeated but acyclic values", () => {
    it("renders a shared object in full at every position", () => {
      const client = { id: "c_1", name: "Acme" };
      const entry = captureLog("info", "rows", {
        rows: [{ client }, { client }, { client }],
      });
      const rows = entry.rows as { client: Record<string, unknown> }[];
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.client).toEqual({ id: "c_1", name: "Acme" });
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
