/**
 * The viewer ceiling on /events is a deliberate choice. Live viewers hold
 * no database connection, so the only 503 a caught-up viewer can meet is
 * the explicitly configured cap.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { MarfaError } from "@withmarfa/shared";
import { createTestContext, storedViewerKey } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { eventRoutes, type EventRoutesOptions } from "./events.js";
import type { AppEnv } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A bare app around eventRoutes with a synthesized principal, so
 *  the route options are under the test's control rather than the app
 *  factory's. */
function makeApp(options: EventRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", storedViewerKey(ctx));
  app.route("/events", eventRoutes(ctx.storage, options));
  // The real app's error handler maps MarfaError onto its own status;
  // this bare harness needs the same mapping or every refusal reads 500.
  app.onError((err, c) => {
    if (err instanceof MarfaError) {
      return c.json({ error: { code: err.code } }, err.status as 503);
    }
    throw err;
  });
  return app;
}

interface OpenStream {
  status: number;
  firstChunk: string;
  close: () => Promise<void>;
}

/** Open one SSE stream and read up to its first chunk, keeping it open. */
async function openStream(
  app: Hono<AppEnv>,
  headers: Record<string, string> = {},
): Promise<OpenStream> {
  const res = await app.request("/events", { headers });
  if (res.status !== 200 || !res.body) {
    return {
      status: res.status,
      firstChunk: "",
      close: () => Promise.resolve(),
    };
  }
  const reader = res.body.getReader();
  const first = await reader.read();
  const firstChunk = first.value ? new TextDecoder().decode(first.value) : "";
  return {
    status: res.status,
    firstChunk,
    close: async () => {
      await reader.cancel();
    },
  };
}

describe("GET /events — viewer cap", () => {
  it("refuses the viewer past the configured cap and admits one again after a close", async () => {
    const app = makeApp({ maxViewers: 1 });
    const first = await openStream(app);
    expect(first.status).toBe(200);
    expect(first.firstChunk).toContain(": connected");

    const second = await app.request("/events");
    expect(second.status).toBe(503);
    const body = (await second.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("stream_capacity_exhausted");

    await first.close();
    // Cleanup runs from the pump's next tick after cancel; poll rather
    // than assume the decrement is synchronous with close().
    // Assigned on the only path out of the loop below, which exits only on
    // success — the runner's budget is what ends a run that never gets one.
    let reopened!: OpenStream;
    for (;;) {
      const attempt = await openStream(app);
      if (attempt.status === 200) {
        reopened = attempt;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(reopened.status).toBe(200);
    await reopened.close();
  }, 30_000);
});
