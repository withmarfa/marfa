/**
 * What the stream does when it cannot deliver what it opened with.
 *
 * One answer, in two places that used to give different ones: it stops,
 * says so in a frame, and closes. It never carries on in a state the
 * client cannot observe, because every such state ends the same way — a
 * cursor sitting past events that were never delivered and will never be
 * asked for again.
 *
 * The frame carries no SSE `id:`, and that is the recovery rather than an
 * omission. Nothing after the gap is sent, so the last `id:` the client
 * received is still the last event it holds and everything past it is
 * still in the log: reconnecting with the cursor it already has replays
 * exactly the gap. That is a different thing from `catchup_too_old`,
 * which says the log can no longer serve the cursor at all.
 *
 * Both cases below are proved by reading until the server closes rather
 * than until a frame arrives. A terminal frame is only terminal if the
 * close follows it, and a read that stops at the frame never observes
 * whether it did — which is the difference between this fix and the
 * behavior it replaces, where the frame's absence and the connection's
 * survival were the same defect.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { ApiKey } from "@withmarfa/shared";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";
import { createTestContext, request, readSse, settle } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { emitWake, initEventLog, type ItemEventWithId } from "../pubsub.js";
import { eventRoutes } from "./events.js";
import type { AppEnv } from "../middleware/auth.js";
import type { PersistedEvent, Storage } from "../storage/interface.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  await ctx.cleanup();
});

async function latestEventId(): Promise<bigint> {
  const rows = await ctx.storage.eventLog.getAfter(0n, 1000);
  return rows.reduce((max, row) => (row.id > max ? row.id : max), 0n);
}

describe("a catch-up that throws partway through", () => {
  /**
   * A declared chain that closes on itself, which `isSubtypeOf` refuses
   * to walk rather than looping on. It is the reachable way into this
   * failure now that the replay resolves subtypes: on the live path the
   * same throw already ends the stream where the client can see it, and
   * the replay swallowed it.
   *
   * Registered into the null-space overlay, which is what a credential
   * carrying no space resolves against.
   */
  const CYCLE = ["cyc.alpha", "cyc.beta"] as const;

  beforeAll(() => {
    registerTypeSchema(
      { id: CYCLE[0], version: 1, parent: CYCLE[1], fields: {} },
      null,
    );
    registerTypeSchema(
      { id: CYCLE[1], version: 1, parent: CYCLE[0], fields: {} },
      null,
    );
  });

  afterAll(() => {
    for (const id of CYCLE) unregisterTypeSchema(id, null);
  });

  it("tells the client and closes, instead of ending quietly", async () => {
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "throw seed" } },
    });
    expect(seed.status).toBe(201);
    const cursor = await latestEventId();

    // Replayed before the row that throws, so `lastSentId` is a real
    // position when the failure happens and the frame below has
    // something to name. Without it the frame would truthfully carry
    // null and the test would prove nothing about where it stopped.
    const beforeId = await ctx.storage.eventLog.append({
      event_type: "created",
      item_id: "ZZbeforethrowZZ",
      payload: JSON.stringify({
        type: "item.created",
        item: { id: "ZZbeforethrowZZ", type: "core.note", properties: {} },
      }),
    });

    // Classifying this row against `core.note` walks the cycle and
    // throws. Written at the store because no write door would accept a
    // type whose chain does not resolve.
    await ctx.storage.eventLog.append({
      event_type: "created",
      item_id: "ZZcyclicZZ",
      payload: JSON.stringify({
        type: "item.created",
        item: { id: "ZZcyclicZZ", type: CYCLE[0], properties: {} },
      }),
    });
    // Sits after the row that throws, and is of the filtered type, so a
    // catch-up that carried on would deliver it. Its absence is what
    // separates "stopped and said so" from "stopped and said so after
    // sending the rest anyway".
    await ctx.storage.eventLog.append({
      event_type: "created",
      item_id: "ZZafterthrowZZ",
      payload: JSON.stringify({
        type: "item.created",
        item: { id: "ZZafterthrowZZ", type: "core.note", properties: {} },
      }),
    });

    const res = await request(ctx.app, "GET", "/events?type=core.note", {
      key: ctx.adminKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);

    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"replay_failed"');
    // Everything up to the failure was delivered, and the cursor the
    // client should reconnect with is the last of it — not where the
    // catch-up was going, and not the cursor it arrived with.
    expect(text).toContain("ZZbeforethrowZZ");
    expect(text).toContain(`"cursor":"${String(beforeId)}"`);
    expect(text).not.toContain("ZZafterthrowZZ");
  });
});

describe("live frames held past the limit while the catch-up runs", () => {
  /**
   * One more than the buffer holds. The cap is one replay batch, derived
   * from the dedupe window that bounds the same population from the other
   * side; raising either means raising this, and the test failing is the
   * intended way to be told so.
   */
  const OVER_THE_CAP = 501;

  /** A key with no space and no permission map, so nothing below is
   *  filtered and every emitted event reaches the hold. */
  function makeApp(storage: Storage): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("apiKey", {
        id: "key-events-overflow",
        name: "overflow viewer",
        key_hash: "unused",
        role: "instance_admin",
        type_permissions: {},
        extension_permissions: {},
        edge_permissions: {},
        metadata_permissions: {},
        created_at: new Date().toISOString(),
      } as unknown as ApiKey);
      await next();
    });
    app.route(
      "/events",
      eventRoutes(storage, { rlsEnforce: false, pgClient: null }),
    );
    return app;
  }

  it("tells the client and closes, instead of growing without a limit", async () => {
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "overflow seed" } },
    });
    expect(seed.status).toBe(201);
    const cursor = await latestEventId();

    // The catch-up is held open on this rather than on a clock, so the
    // window in which frames accumulate is decided by the test rather
    // than by how loaded the machine is.
    let openTheGate = (): void => undefined;
    const gate = new Promise<PersistedEvent[]>((resolve) => {
      openTheGate = () => {
        resolve([]);
      };
    });
    let firstRead = true;
    const storage: Storage = {
      ...ctx.storage,
      eventLog: {
        ...ctx.storage.eventLog,
        append: (entry) => ctx.storage.eventLog.append(entry),
        getMinRetainedId: (spaceId) =>
          ctx.storage.eventLog.getMinRetainedId(spaceId),
        getMaxId: (spaceId) => ctx.storage.eventLog.getMaxId(spaceId),
        cleanup: (hours, spaceId) =>
          ctx.storage.eventLog.cleanup(hours, spaceId),
        getAfter: (afterId, limit, spaceId) => {
          if (firstRead) {
            firstRead = false;
            return gate;
          }
          return ctx.storage.eventLog.getAfter(afterId, limit, spaceId);
        },
      },
    };

    const res = await makeApp(storage).request("/events", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    // Lets the prologue reach the gate, so everything emitted below is
    // held rather than delivered live.
    await settle();

    for (let n = 0; n < OVER_THE_CAP; n++) {
      emitWake({
        type: "created",
        item: {
          id: `ZZheld${String(n)}ZZ`,
          type: "core.note",
          properties: {},
        } as unknown as ItemEventWithId["item"],
        originatingConnectionId: null,
        hopCount: 0,
      });
    }
    await settle();
    openTheGate();

    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"backlog_overflow"');
    // Held frames go unsent rather than partly sent: they sit after the
    // gap, and delivering some of them is what presents a short
    // catch-up as a complete one.
    expect(text).not.toContain("ZZheld0ZZ");
  });
});
