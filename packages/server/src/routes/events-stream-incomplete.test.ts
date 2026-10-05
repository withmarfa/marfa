/**
 * What the stream does when it cannot deliver what it opened with.
 *
 * One answer, whichever path meets it: it stops, says so in a frame, and
 * closes. It never carries on in a state the
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
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";
import {
  createTestContext,
  eventsAppWithKey,
  gatedEventLog,
  request,
  readSse,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  emitWake,
  initEventLog,
  type EdgeEventWithId,
  type ItemEventWithId,
} from "../pubsub.js";

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

function emitNotes(count: number, tag: string): void {
  for (let n = 0; n < count; n++) {
    emitWake({
      type: "created",
      item: {
        id: `ZZ${tag}${String(n)}ZZ`,
        type: "core.note",
        properties: {},
      } as unknown as ItemEventWithId["item"],
    });
  }
}

function emitEdges(count: number, tag: string): void {
  for (let n = 0; n < count; n++) {
    emitWake({
      type: "edge_created",
      edge: {
        id: `ZZ${tag}${String(n)}ZZ`,
        edge_type: "references",
        source_id: "src",
        target_id: "tgt",
      } as unknown as EdgeEventWithId["edge"],
    });
  }
}

describe("a catch-up that throws partway through", () => {
  /**
   * A declared chain that closes on itself, which `isSubtypeOf` refuses
   * to walk rather than looping on. It is the reachable way into this
   * failure, because the replay resolves subtypes: the same throw on the
   * live path ends the stream where the client can see it, and the
   * replay has to end it the same way.
   *
   * Registered into the runtime overlay, which is what the
   * credential opening the stream below resolves against.
   */
  const CYCLE = ["cyc.alpha", "cyc.beta"] as const;

  beforeAll(() => {
    registerTypeSchema({
      id: CYCLE[0],
      version: 1,
      parent: CYCLE[1],
      fields: {},
    });
    registerTypeSchema({
      id: CYCLE[1],
      version: 1,
      parent: CYCLE[0],
      fields: {},
    });
  });

  afterAll(() => {
    for (const id of CYCLE) unregisterTypeSchema(id);
  });

  it("tells the client and closes, instead of ending quietly", async () => {
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "throw seed" } },
    });
    expect(seed.status).toBe(201);
    const cursor = await latestEventId();

    // Replayed before the row that throws, so `lastSentId` is a real
    // position when the failure happens and the frame below has
    // something to name. Without it the frame would truthfully carry
    // null and the test would prove nothing about where it stopped.
    //
    const beforeId = await ctx.storage.eventLog.append({
      event_type: "created",
      item_id: "ZZbeforethrowZZ",
      payload: JSON.stringify({
        event_type: "item.created",
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
        event_type: "item.created",
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
        event_type: "item.created",
        item: { id: "ZZafterthrowZZ", type: "core.note", properties: {} },
      }),
    });

    const res = await request(ctx.app, "GET", "/events?type=core.note", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);

    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"replay_failed"');
    // A stream that ended short never became live: the marker would tell
    // the client to resume past the gap.
    expect(text).not.toContain("event: stream_live");
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
   * One more than the buffer holds. The cap is the replay's dedupe window,
   * and the constant's comment in `routes/events.ts` says why it can be no
   * larger; moving either number moves this, and a red here is the
   * intended way to be told so.
   */
  const OVER_THE_CAP = 501;

  it("tells the client and closes, instead of growing without a limit", async () => {
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "overflow seed" } },
    });
    expect(seed.status).toBe(201);
    const cursor = await latestEventId();

    const { storage, open } = gatedEventLog(ctx.storage);
    const res = await eventsAppWithKey(storage).request("/events", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    // Lets the prologue reach the gate, so everything emitted below is
    // held rather than delivered live.
    await settle();

    emitNotes(OVER_THE_CAP, "held");
    await settle();
    open();

    const { text, closed } = await readSse(res, { untilClosed: true });
    expect(closed).toBe(true);
    expect(text).toContain("event: stream_incomplete");
    expect(text).toContain('"reason":"backlog_overflow"');
    // A stream that ended short never became live.
    expect(text).not.toContain("event: stream_live");
    // Held frames go unsent rather than partly sent: they sit after the
    // gap, and delivering some of them is what presents a short
    // catch-up as a complete one.
    expect(text).not.toContain("ZZheld0ZZ");
  });
});

/**
 * The cap counts what the subscriber would receive, not what arrived.
 *
 * A held frame passes through the same two questions the release path
 * asks — does this stream take edges at all, and does this credential's
 * type projection admit this item — before it occupies a slot. Without
 * that, the buffer could be filled entirely by frames guaranteed to be
 * discarded on release, so **traffic a subscriber explicitly excluded
 * could terminate its stream**, and narrowing a subscription made it
 * more fragile rather than less.
 *
 * Both probes below are the shapes a real client takes. `edges: "none"`
 * is what a subscriber that holds items asks for, because it would
 * discard every edge frame anyway; a credential scoped to a single type
 * is the ordinary shape of a narrow connector credential. Neither
 * should be reachable by the traffic it opted out of.
 *
 * Asserted by completion rather than by absence: the catch-up finishes,
 * the stream stays open, and the anchor published afterwards arrives.
 * "No `stream_incomplete` appeared" alone would be equally true of a
 * stream that delivered nothing at all.
 */
describe("frames the subscriber would never receive", () => {
  const OVER_THE_CAP = 501;

  it("do not fill the hold when the stream opted out of edges", async () => {
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "edges-none seed" } },
    });
    expect(seed.status).toBe(201);
    const cursor = await latestEventId();

    const { storage, open } = gatedEventLog(ctx.storage);
    const res = await eventsAppWithKey(storage).request("/events?edges=none", {
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    await settle();

    emitEdges(OVER_THE_CAP, "excludededge");
    await settle();
    open();
    // Published after the gate opens, so it travels the live path and
    // proves the stream is still delivering rather than merely open.
    await settle();
    emitNotes(1, "edgesnoneanchor");

    const { text } = await readSse(res, {
      until: (t) => t.includes("ZZedgesnoneanchor0ZZ"),
    });
    expect(text).not.toContain("stream_incomplete");
    // The frames it opted out of stayed out, which is why they cost it
    // nothing.
    expect(text).not.toContain("ZZexcludededge0ZZ");
  });

  it("do not fill the hold when the credential cannot read their type", async () => {
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "scoped seed" } },
    });
    expect(seed.status).toBe(201);
    const cursor = await latestEventId();

    const { storage, open } = gatedEventLog(ctx.storage);
    // The permission map is what this probe is about, so it names one
    // narrower than the default rather than inheriting it.
    const res = await eventsAppWithKey(storage, {
      type_permissions: { "core.task": "read" },
    }).request("/events", { headers: { "Last-Event-ID": String(cursor) } });
    expect(res.status).toBe(200);
    await settle();

    emitNotes(OVER_THE_CAP, "unreadable");
    await settle();
    open();
    await settle();
    emitWake({
      type: "created",
      item: {
        id: "ZZscopedanchorZZ",
        type: "core.task",
        properties: {},
      } as unknown as ItemEventWithId["item"],
    });

    const { text } = await readSse(res, {
      until: (t) => t.includes("ZZscopedanchorZZ"),
    });
    expect(text).not.toContain("stream_incomplete");
    expect(text).not.toContain("ZZunreadable0ZZ");
  });
});
