import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { createTestContext, type TestContext } from "../test-utils.js";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { createErrorHandler } from "./error-handler.js";
import * as logger from "./logger.js";
import type { AppEnv } from "./auth.js";

describe("error handler — malformed and empty bodies", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function postRaw(body: string): Promise<Response> {
    return ctx.app.request("/items", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/json",
      },
      body,
    });
  }

  it("malformed JSON body returns 400 validation_error", async () => {
    const response = await postRaw("{not valid json");
    expect(response.status).toBe(400);
    expect(response.headers.get("X-Error-Code")).toBe("validation_error");
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("validation_error");
  });

  it("empty body on POST /items returns 400 validation_error", async () => {
    const response = await postRaw("");
    expect(response.status).toBe(400);
    expect(response.headers.get("X-Error-Code")).toBe("validation_error");
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("validation_error");
  });

  it("array instead of object on POST /items returns 400 (not 500)", async () => {
    const response = await postRaw(JSON.stringify([{ type: "core.note" }]));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe("error handler — the unmatched-route 404", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("carries X-Error-Code like every other refusal, for JSON and for a browser", async () => {
    // `app.notFound` builds its response without the handler that stamps
    // the header on every other error, so it has to stamp it itself: a
    // client keying on the header read this one 404 as headerless.
    const res = await ctx.app.request("/no-such-route", {
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Error-Code")).toBe("not_found");
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("not_found");

    const page = await ctx.app.request("/no-such-route", {
      headers: { Accept: "text/html" },
    });
    expect(page.status).toBe(404);
    expect(page.headers.get("X-Error-Code")).toBe("not_found");
    expect(page.headers.get("Content-Type")).toContain("text/html");
  });
});

describe("error handler — the unhandled-error log line", () => {
  it("carries the request id and the path, the join key to the access-log line", async () => {
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
    try {
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("requestId", "req-join-key");
        await next();
      });
      app.get("/boom", () => {
        throw new Error("boom");
      });
      app.onError(
        createErrorHandler({
          errorWebhookUrl: "",
          errorWebhookTimeoutMs: 1_000,
        }),
      );

      const res = await app.request("/boom");
      expect(res.status).toBe(500);

      const line = logSpy.mock.calls.find(
        ([level, message]) =>
          level === "error" && message === "Unhandled error",
      );
      expect(line).toBeDefined();
      const data = line?.[2];
      expect(data?.request_id).toBe("req-join-key");
      expect(data?.path).toBe("/boom");
      expect(data?.method).toBe("GET");
      expect(data?.error).toBe("boom");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("error handler — an error the server threw, re-wrapped on the way out", () => {
  /** A Hono app whose one route throws `thrown`. */
  function appThrowing(thrown: unknown): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.get("/boom", () => {
      throw thrown;
    });
    app.onError(createErrorHandler({ errorWebhookUrl: "" }));
    return app;
  }

  it("answers the server's own code from inside a wrapper's cause", async () => {
    // Drizzle catches what a statement threw and re-throws an error of
    // its own carrying the original as `cause`. Without the walk the
    // handler sees an error with no code and answers `500` — the
    // instance reporting itself broken about a refusal it chose.
    const wrapped = Object.assign(new Error("Failed query: insert into ..."), {
      cause: new MarfaError(
        ErrorCode.WRITE_CONTENTION,
        "the lock did not free in time",
        { budget_ms: 0 },
      ),
    });

    const res = await appThrowing(wrapped).request("/boom");
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("write_contention");
    expect(body.error.details).toMatchObject({ budget_ms: 0 });
  });

  it("does not answer a foreign error's own code and status", async () => {
    // The walk asks for the server's own class inside a chain, and this
    // is why: a library error carrying a `code` and a `status` of its
    // own would otherwise have its internals answered to a caller as
    // though the server had chosen them. At the top level the
    // structural test still stands, because that is what every throw
    // site in this repository arrives as.
    const foreign = Object.assign(new Error("upstream said no"), {
      cause: Object.assign(new Error("the library's own failure"), {
        code: "SOME_LIBRARY_CODE",
        status: 418,
        details: { connection_string: "a thing a caller must not read" },
      }),
    });

    const res = await appThrowing(foreign).request("/boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
  });

  it("stops rather than following a cause chain back to itself", async () => {
    // A `cause` chain is data, and a cycle in one must not hang the
    // handler. The bound is what makes that true.
    const a = new Error("a");
    const b = new Error("b");
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });

    const res = await appThrowing(a).request("/boom");
    expect(res.status).toBe(500);
  });
});

describe("error handler — a volume with no room left", () => {
  function appThrowing(error: unknown): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.get("/boom", () => {
      throw error;
    });
    app.onError(createErrorHandler({ errorWebhookUrl: "" }));
    return app;
  }

  /** What the query layer makes of a driver refusal: its own error, the
   *  driver's under `cause`. */
  function wrapped(code: string): Error {
    return new Error("Failed query: insert into t", {
      cause: Object.assign(new Error(`${code}: database or disk is full`), {
        code,
      }),
    });
  }

  it.each(["SQLITE_FULL", "ENOSPC", "EDQUOT"])(
    "answers 507 insufficient_storage for %s, whether wrapped or bare",
    async (code) => {
      for (const error of [wrapped(code), wrapped(code).cause]) {
        const res = await appThrowing(error).request("/boom");
        expect(res.status).toBe(507);
        expect(res.headers.get("X-Error-Code")).toBe("insufficient_storage");
        const body = (await res.json()) as {
          error: { code: string; message: string };
        };
        expect(body.error.code).toBe("insufficient_storage");
        expect(body.error.message).not.toMatch(/SQLITE|ENOSPC|insert into/);
      }
    },
  );

  it("still answers a fault with another code 500 internal_error", async () => {
    const res = await appThrowing(wrapped("SQLITE_CORRUPT")).request("/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Error-Code")).toBe("internal_error");
  });
});
