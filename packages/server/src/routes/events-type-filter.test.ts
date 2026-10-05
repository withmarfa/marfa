/**
 * `GET /events?type=` resolves the same subtree live and on replay.
 *
 * The filter names a type and covers that type's declared-parent
 * subtree: a type whose `parent` chain reaches the named one answers for
 * it. Live delivery goes through `eventMatchesTypeFilter`, which walks
 * that chain, and the `Last-Event-ID` replay has to walk the same one: a
 * replay that compared the stored type string alone would hand a
 * subscriber narrowing to a parent type a subtype's event while connected
 * and lose the same event on every reconnect.
 *
 * The same parameter as the list surfaces take, resolved by the same rule:
 * the global wildcard, the named type and everything under its name, and
 * the types that declare their way there. A stream resolving the declared
 * clause alone would match nothing for `*` and `core.*` while the same
 * spellings on `/items` matched everything and a subtree — a 200 carrying
 * no events, which is the one filter failure a client cannot tell from a
 * quiet instance. Agreement with the list surface is pinned below by
 * asking both and comparing, rather than by restating what either should
 * return.
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
import {
  createTestContext,
  mintWorkingKey,
  readSse,
  request,
  settle,
} from "../test-utils.js";
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
    key: ctx.workingKey,
    body: { type, properties },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

/** What `GET /items?type=<spelling>` answers with: the status, and the
 *  ids when it answered with any. Compared against what the stream does
 *  with the same spelling. */
async function listed(
  spelling: string,
): Promise<{ status: number; ids: Set<string> }> {
  const res = await request(
    ctx.app,
    "GET",
    `/items?type=${encodeURIComponent(spelling)}&limit=100`,
    { key: ctx.workingKey },
  );
  if (res.status !== 200) return { status: res.status, ids: new Set() };
  const body = (await res.json()) as { data: { id: string }[] };
  return { status: 200, ids: new Set(body.data.map((i) => i.id)) };
}

describe("GET /events?type= on the live stream", () => {
  it("delivers a subtype of the filtered type, and nothing outside it", async () => {
    const stream = await request(ctx.app, "GET", "/events?type=core.media", {
      key: ctx.workingKey,
    });
    expect(stream.status).toBe(200);

    // Markers rather than item ids, because the read has to be told what
    // to stop on before anything is written.
    //
    // No explicit budget. The three writes below land inside this read's
    // window, and one `POST /items` has been recorded taking four seconds
    // on this machine when it is busy, so any number tight enough to be
    // worth setting would report on the runner rather than on delivery.
    // `readSse` names the condition it gave up on either way.
    const reading = readSse(stream, {
      until: (t) => t.includes("ZZmediaZZ"),
    });
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
    // A row for the cursor to name, so the replay begins after it rather
    // than at the log's beginning and the frames read are this case's alone.
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
      key: ctx.workingKey,
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

  it("withholds a stored row naming no item type, from every subscriber", async () => {
    // The one behavior in the replay condition that is not the shared
    // matcher. `publish` always attaches the item, so nothing in the tree
    // writes this row: it stands for an older stored shape or a
    // hand-written one, and the filter has to decide about it rather than
    // throw.
    //
    // Asked of a filtering subscriber and of one carrying no `?type=`,
    // because the replay decodes the payload for both and reaches the same
    // answer. There is no subscriber it decodes nothing for: every
    // credential is held to its permission maps, so `typeFilter.allowed` is
    // never absent and the row is classified for all of them.
    //
    // The anchor is what makes "withheld" mean something. Both reads run
    // until they see a row written after this one, so the replay is known to
    // have walked past it and decided rather than merely not reached it.
    await createItem("core.note", { body: "seed-typeless" });
    const cursor = await latestEventId();

    await ctx.storage.eventLog.append({
      event_type: "item.created",
      payload: JSON.stringify({
        event_type: "item.created",
        note: "ZZtypelessZZ",
      }),
    });
    // The witness: the row is in the log after the cursor, so a replay
    // from that cursor walks over it and the absence below is a decision
    // rather than a row that was never there to withhold.
    expect(
      (await ctx.storage.eventLog.getAfter(cursor, 100)).map((e) => e.payload),
    ).toContainEqual(expect.stringContaining("ZZtypelessZZ"));
    // Written after, so reaching it means the row above was already decided.
    const anchorId = await createItem("core.media", { title: "ZZanchorZZ" });

    const filtered = await request(ctx.app, "GET", "/events?type=core.media", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(filtered.status).toBe(200);
    const filteredText = (
      await readSse(filtered, {
        until: (t) => t.includes(anchorId),
      })
    ).text;
    // A row the filter cannot classify is not handed to a filtering
    // subscriber.
    expect(filteredText).not.toContain("ZZtypelessZZ");

    const unfiltered = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(unfiltered.status).toBe(200);
    const unfilteredText = (
      await readSse(unfiltered, {
        until: (t) => t.includes(anchorId),
      })
    ).text;
    // The permission narrowing still applies with no `?type=` on the
    // request, and a row it cannot classify cannot be proved readable.
    expect(unfilteredText).not.toContain("ZZtypelessZZ");
  });
});

/**
 * The spellings the parameter takes, answered the way the list surface
 * answers them.
 *
 * Written as a comparison rather than as a list of expected ids: the
 * defect is one parameter resolving differently across surfaces, and an
 * assertion that restates what the stream should return can agree with
 * itself while still disagreeing with `/items`. Asking both and comparing
 * is the only form that fails when they drift.
 *
 * Refusal counts as an answer, and for two of the spellings here it is
 * the answer. `/items` rejects the global wildcard deliberately —
 * "everything" is the request with no `type` at all, and a filter
 * matching every type would slip past the per-type levers keyed off this
 * parameter — and rejects anything outside the pattern grammar. A stream
 * that accepted either and then matched nothing would answer a 200
 * carrying no events: the one filter failure a client cannot tell from a
 * quiet instance.
 */
describe("GET /events?type= answers the spellings /items answers", () => {
  /** Registered outside every `core.` namespace and declaring no core
   *  parent, so it is what `core.*` must exclude. */
  const OUTSIDE_TYPE = "user.stream_filter_probe";

  let outsideId: string;
  let songId: string;
  let anchorId: string;
  let cursor: bigint;

  beforeAll(async () => {
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: OUTSIDE_TYPE,
        version: 1,
        fields: { title: { type: "string" } },
      },
    });
    expect([201, 409]).toContain(registered.status);

    // A row for the cursor to point at, taken before the three under
    // test so the replay walks exactly them.
    await createItem("core.note", { body: "spelling seed" });
    cursor = await latestEventId();

    // The anchor goes last and is of a type every accepted spelling
    // admits, so each read below has a terminator that arrives whether
    // or not the rows before it did.
    outsideId = await createItem(OUTSIDE_TYPE, { title: "outside core" });
    songId = await createItem("core.media.song", { title: "under core" });
    anchorId = await createItem("core.note", { body: "spelling anchor" });
  });

  it("delivers what the list returns for a subtree wildcard, replaying", async () => {
    const res = await request(ctx.app, "GET", "/events?type=core.*", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, {
      until: (t) => t.includes(anchorId),
    });

    const { status, ids } = await listed("core.*");
    expect(status).toBe(200);
    for (const id of [outsideId, songId, anchorId]) {
      expect({ id, streamed: text.includes(id) }).toEqual({
        id,
        streamed: ids.has(id),
      });
    }
  });

  it("delivers what the list returns for a subtree wildcard, live", async () => {
    const res = await request(ctx.app, "GET", "/events?type=core.*", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);

    const reading = readSse(res, { until: (t) => t.includes("ZZliveendZZ") });
    await settle();

    const liveOutside = await createItem(OUTSIDE_TYPE, {
      title: "ZZliveoutZZ",
    });
    const liveSong = await createItem("core.media.song", {
      title: "ZZlivesongZZ",
    });
    const liveAnchor = await createItem("core.note", { body: "ZZliveendZZ" });

    const { text } = await reading;
    const { status, ids } = await listed("core.*");
    expect(status).toBe(200);
    for (const id of [liveOutside, liveSong, liveAnchor]) {
      expect({ id, streamed: text.includes(id) }).toEqual({
        id,
        streamed: ids.has(id),
      });
    }
  });

  for (const spelling of ["*", "core", "core.note/private"] as const) {
    it(`refuses ${spelling}, as the list does, rather than opening an empty stream`, async () => {
      const { status } = await listed(spelling);
      // Stated rather than assumed: this pins the stream to whatever the
      // list surface does with the spelling, so a change there that made
      // it acceptable would fail here instead of leaving the two apart.
      expect(status).toBe(400);

      const res = await request(
        ctx.app,
        "GET",
        `/events?type=${encodeURIComponent(spelling)}`,
        { key: ctx.workingKey },
      );
      expect(res.status).toBe(400);
    });
  }
});

/**
 * A stored row the replay cannot classify is withheld by both checks that
 * look at it, not by one of them.
 *
 * The type filter and the permission narrowing sit one after the other and
 * read the same value, so they can disagree about a row that names no item
 * type: the filter reads it as "does not match" and skips the row, while
 * the narrowing, guarding on the value being present, skips ITSELF and
 * sends the row out unfiltered. The check that fails open that way is the
 * permission check, which is the wrong one of the two to be wrong.
 *
 * Pinned on a narrow credential and a request carrying no `?type=`, so the
 * permission narrowing is the only check with anything to say about the row.
 *
 * Nothing in the tree writes this payload — the publisher always attaches
 * the item — so it is constructed at the store. Unreachable today is a
 * property of the current writers rather than of this code, and a
 * permission check should not be resting on it.
 */
describe("the replay's two checks on a row that names no item type", () => {
  it("does not hand it to a credential the permission maps apply to", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const raw = await mintWorkingKey(ctx, {
      label: "type-filter member",
      source: `type-filter-member-${suffix}`,
      type_permissions: { "core.*": "read" },
      edge_permissions: {},
      metadata_permissions: {},
      extension_permissions: {},
      profile_permissions: {},
      permissions: [],
    });

    await createItem("core.note", { body: "narrowing seed" });
    const cursor = await latestEventId();

    await ctx.storage.eventLog.append({
      event_type: "item.created",
      payload: JSON.stringify({
        event_type: "item.created",
        note: "ZZunclassifiableZZ",
      }),
    });
    // The witness: the row is in the log after the cursor, so the replay
    // below walks over it and decides, and the absence is not a row that
    // was never appended.
    expect(
      (await ctx.storage.eventLog.getAfter(cursor, 100)).map((e) => e.payload),
    ).toContainEqual(expect.stringContaining("ZZunclassifiableZZ"));
    // Written after, so reaching it proves the row above was already
    // decided rather than merely not yet replayed.
    const anchorId = await createItem("core.note", {
      body: "narrowing anchor",
    });

    const res = await request(ctx.app, "GET", "/events", {
      key: raw,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, {
      until: (t) => t.includes(anchorId),
    });

    // The narrowing applies, so it applies to the row it cannot classify
    // too.
    expect(text).not.toContain("ZZunclassifiableZZ");
  });
});
