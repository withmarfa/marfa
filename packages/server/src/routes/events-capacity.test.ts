/**
 * The viewer ceiling on /events is a deliberate choice, not pool
 * arithmetic. Live viewers hold no database connection (the replay phase
 * briefly reserves one), so concurrent viewers must exceed the session
 * pool without refusals, a finished replay must leave the pool empty
 * while its stream stays open, and the only 503 a caught-up viewer can
 * meet is the explicitly configured cap.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { MarfaError } from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { emitWake, type ItemEventWithId } from "../pubsub.js";
import { eventRoutes, type EventRoutesOptions } from "./events.js";
import type { AppEnv } from "../middleware/auth.js";
import type { PgClient } from "../storage/pg/connection.js";
import { acquireStreamRls } from "../storage/pg/streaming-rls.js";

const isPg = process.env.DB_DIALECT === "pg";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const SPACE_ID = "events-capacity-space";

function spaceKey(): ApiKey {
  return {
    id: "key_events_capacity",
    name: "events capacity",
    key_hash: "unused",
    space_id: SPACE_ID,
    // The rank this fixture used to carry admitted it past its own maps, so
    // the map has to say what the rank granted silently.
    type_permissions: { "*": "read" },
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: new Date().toISOString(),
  } as unknown as ApiKey;
}

/** A bare app around eventRoutes with a synthesized space principal, so
 *  the route options are under the test's control rather than the app
 *  factory's. */
function makeApp(options: EventRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("apiKey", spaceKey());
    await next();
  });
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
    const app = makeApp({ rlsEnforce: false, pgClient: null, maxViewers: 1 });
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

describe.skipIf(!isPg)("GET /events — live viewers hold no pool slot", () => {
  it("admits more concurrent caught-up viewers than the session pool has connections", async () => {
    const pgClient = (ctx.storage.pgStreamClient ??
      ctx.storage.pgClient) as PgClient;
    const app = makeApp({
      rlsEnforce: true,
      pgClient,
      streamReserveTimeoutMs: 1_000,
    });
    // The test-context pool is capped at 3; under the old
    // held-for-lifetime shape the fourth viewer answered 503 here.
    const streams: OpenStream[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        streams.push(await openStream(app));
      }
      for (const s of streams) {
        expect(s.status).toBe(200);
        expect(s.firstChunk).toContain(": connected");
      }
    } finally {
      for (const s of streams) await s.close();
    }
  }, 30_000);

  it("runs the replay, releases its reservation, and keeps delivering live", async () => {
    const pgClient = (ctx.storage.pgStreamClient ??
      ctx.storage.pgClient) as PgClient;
    const app = makeApp({
      rlsEnforce: true,
      pgClient,
      streamReserveTimeoutMs: 1_000,
    });
    // Two rows, cursor at the first: a cursor below the space's oldest
    // retained id takes the terminal catchup_too_old exit instead, and
    // the replay — the code path under test — never runs.
    const firstId = await ctx.storage.eventLog.append({
      event_type: "created",
      item_id: "evt-cap-anchor",
      space_id: SPACE_ID,
      payload: JSON.stringify({
        type: "item.created",
        item: { id: "evt-cap-anchor", type: "core.note" },
      }),
    });
    await ctx.storage.eventLog.append({
      event_type: "created",
      item_id: "evt-cap-replayed",
      space_id: SPACE_ID,
      payload: JSON.stringify({
        type: "item.created",
        item: { id: "evt-cap-replayed", type: "core.note" },
      }),
    });

    const res = await app.request("/events", {
      headers: { "Last-Event-ID": String(firstId) },
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    try {
      // 1. The replay genuinely runs: the second row arrives as a frame.
      while (!received.includes("evt-cap-replayed")) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ value?: Uint8Array; done: boolean }>((r) =>
            setTimeout(() => {
              r({ done: false });
            }, 500),
          ),
        ]);
        if (chunk.value) received += decoder.decode(chunk.value);
        if (chunk.done) break;
      }
      expect(received).toContain("evt-cap-replayed");

      // 2. The reservation came back: the whole pool is reservable while
      // the stream is still open.
      let drained = false;
      while (!drained) {
        const held = [];
        try {
          for (let i = 0; i < 3; i++) {
            held.push(
              await acquireStreamRls(pgClient, SPACE_ID, {
                reserveTimeoutMs: 500,
              }),
            );
          }
          drained = true;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        } finally {
          for (const h of held) await h.release();
        }
      }
      expect(drained).toBe(true);

      // 3. The stream is still live after the release: a fresh event
      // reaches it through the emitter.
      emitWake({
        type: "created",
        item: {
          id: "evt-cap-live",
          type: "core.note",
          properties: {},
        } as unknown as ItemEventWithId["item"],
        spaceId: SPACE_ID,
      });
      while (!received.includes("evt-cap-live")) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ value?: Uint8Array; done: boolean }>((r) =>
            setTimeout(() => {
              r({ done: false });
            }, 500),
          ),
        ]);
        if (chunk.value) received += decoder.decode(chunk.value);
        if (chunk.done) break;
      }
      expect(received).toContain("evt-cap-live");
    } finally {
      await reader.cancel();
    }
  }, 60_000);
});
