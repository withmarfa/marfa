import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { createTestContext, type TestContext } from "../test-utils.js";
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
        Authorization: `Bearer ${ctx.spaceKey}`,
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
      headers: { Authorization: `Bearer ${ctx.spaceKey}` },
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
