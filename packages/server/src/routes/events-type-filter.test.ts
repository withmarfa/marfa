/**
 * `GET /events?type=` resolves the same subtree live and on replay.
 *
 * The filter names a type and covers that type's subtypes, exactly as
 * `/items`, `/search` and `/export` resolve the same parameter. Live
 * delivery goes through `eventMatchesTypeFilter`, which walks the
 * inheritance chain. The `Last-Event-ID` replay compared the stored
 * type string with `!==`, so a subscriber narrowing to a parent type
 * received a subtype's event while connected and lost the same event on
 * every reconnect.
 *
 * That is the worst shape a delivery gap can take, because the client
 * cannot see it: replay reports no error and closes no stream, so the
 * events simply are not there and nothing ever asks for them again.
 *
 * **Both delivery paths, because they are two different pieces of code.**
 * Live filtering happens inside the subscription; the replay re-reads
 * `event_log` and decides for itself. They agree only by calling one
 * function, which is what this pins.
 *
 * The live case is here for the wiring rather than the rule. A unit test
 * over the matcher proves the function answers correctly and says nothing
 * about who calls it, so an inline comparison reintroduced in the
 * subscription would pass every other test in the repository and mirror
 * this same defect onto the other path. Only a request through the route
 * observes that.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request, readSse, settle } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // Without this the replay path has nothing to replay: `publish` only
  // appends when an event-log store is installed, and the test context
  // does not install one.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  await ctx.cleanup();
});

/** The newest id in the event log, or 0 when it is empty. Taken from the
 *  log rather than guessed: a fixed cursor trips the retention check on a
 *  trimmed log, and the stream then closes with `catchup_too_old` having
 *  replayed nothing. */
async function latestEventId(): Promise<bigint> {
  const rows = await ctx.storage.eventLog.getAfter(0n, 1000);
  return rows.reduce((max, row) => (row.id > max ? row.id : max), 0n);
}

async function createItem(
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: { type, properties },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

describe("GET /events?type= on the live stream", () => {
  it("delivers a subtype of the filtered type, and nothing outside it", async () => {
    const stream = await request(ctx.app, "GET", "/events?type=core.media", {
      key: ctx.adminKey,
    });
    expect(stream.status).toBe(200);

    // Markers rather than item ids, because the read has to be told what
    // to stop on before anything is written.
    const reading = readSse(stream, { until: (t) => t.includes("ZZmediaZZ") });
    // The read is already running; this lets the subscription attach, so
    // nothing published below lands before there is a listener for it.
    await settle();

    // Same ordering as the replay case, for the same two reasons: the
    // unrelated type is decided before the read can stop, and the exact
    // match arrives whether or not the subtype does.
    await createItem("core.note", { body: "ZZnoteZZ" });
    await createItem("core.media.song", { title: "ZZsongZZ" });
    await createItem("core.media", { title: "ZZmediaZZ" });

    const { text } = await reading;
    expect(text).toContain("ZZmediaZZ");
    expect(text).toContain("ZZsongZZ");
    expect(text).not.toContain("ZZnoteZZ");
  });
});

describe("GET /events?type= on the Last-Event-ID replay", () => {
  it("delivers a subtype of the filtered type, and nothing outside it", async () => {
    // A row the cursor can point at. `Last-Event-ID: 0` against an empty
    // log is older than anything retained, so the stream would answer a
    // terminal `catchup_too_old` and replay nothing at all.
    await createItem("core.note", { body: "seed" });
    const cursor = await latestEventId();

    // Written in this order deliberately. The unrelated type goes first so
    // its frame would already have been decided by the time the read stops,
    // and the exact match goes last so the read has a terminator that
    // arrives whether or not the subtype does — otherwise proving the
    // subtype absent would mean waiting out a timeout and reporting a
    // delivery gap as an expired clock.
    const noteId = await createItem("core.note", {
      body: "outside the filter",
    });
    const songId = await createItem("core.media.song", { title: "a subtype" });
    const mediaId = await createItem("core.media", {
      title: "the filtered type",
    });

    const res = await request(ctx.app, "GET", "/events?type=core.media", {
      key: ctx.adminKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);

    const { text } = await readSse(res, {
      until: (t) => t.includes(mediaId),
    });

    // The filter admits the type it names. Asserted so a fix that simply
    // stopped filtering could not pass on the subtype alone.
    expect(text).toContain(mediaId);
    // The subtype the live stream would have delivered.
    expect(text).toContain(songId);
    // And the filter still filters.
    expect(text).not.toContain(noteId);
  });
});
