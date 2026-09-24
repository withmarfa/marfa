import { describe, it, expect, afterEach, vi } from "vitest";
import {
  startHarness,
  scriptHydration,
  scriptWrites,
  type Harness,
} from "./harness.js";
import {
  answers,
  catchupTooOld,
  connected,
  edgeEvent,
  headRead,
  heldLog,
  itemEvent,
  itemsPage,
  refusal,
  replay,
  streamCursor,
  typeCatalog,
  wireItem,
  wireType,
} from "../../device/marfa-answers.js";
import type { Answer } from "../../device/scripted-server.js";
import type { FollowReport } from "../../device/protocol.js";

/**
 * "Events apply in log order, gated by version", and "a stale cursor means
 * re-import, not reconnect".
 *
 * Catch-up is the only thing between a copy and the truth once the snapshot
 * is taken, and every failure here is silent. A cursor that moves too far
 * skips rows nothing will fetch again; a cursor that does not move replays
 * forever; an aged-out cursor answered by reconnecting leaves a copy missing
 * exactly the writes that aged out.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function lastEventIds(harnessUnderTest: Harness): string[] {
  return harnessUnderTest.server.requests
    .filter((request) => request.pathname === "/events")
    .map((request) => request.headers["last-event-id"] ?? "(none)");
}

describe("catch-up replays from the cursor", () => {
  it("resumes at the stored cursor and applies what the stream carries", async () => {
    harness = await startHarness("replay-resume");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "n1" } }] },
    });
    server.answer(
      "GET",
      "/events",
      replay("12", [
        itemEvent("11", "item.created", wireItem({ id: "n2" })),
        itemEvent("12", "item.created", wireItem({ id: "n3" })),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(
      caught.ok,
      `the catch-up was refused: ${JSON.stringify(caught)}`,
    ).toBe(true);

    expect(
      lastEventIds(harness),
      "the replay did not resume from the cursor the store held, so it either re-read what the snapshot already had or skipped what it did not",
    ).toEqual(["(none)", "10"]);
    expect(
      caught.ok ? caught.value.applied : undefined,
      "the device counted fewer events than the stream carried, so something arrived and was not applied without being reported as skipped",
    ).toBe(2);

    const held = await device.list();
    expect(held.ok).toBe(true);
    expect(
      held.ok ? held.value.map((item) => item.id).sort() : [],
      "an event the stream carried never reached the copy, and the catch-up reported a clean pass over it",
    ).toEqual(["n1", "n2", "n3"]);
  });

  it("keeps the last id applied rather than the highest, so a late lower id is not stepped over", async () => {
    harness = await startHarness("late-lower-id");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    // A server assigns an event its id before it commits, so a lower id can
    // reach a subscriber after a higher one. A cursor kept as a high-water
    // mark steps over the lower one, and nothing ever fetches it again.
    server.answer(
      "GET",
      "/events",
      replay("20", [
        itemEvent("12", "item.created", wireItem({ id: "committed-second" })),
        itemEvent("11", "item.created", wireItem({ id: "committed-first" })),
      ]),
      replay("20", []),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);
    await device.catchUp();

    expect(
      lastEventIds(harness),
      "the second replay resumed from the highest id seen rather than the last one applied, so every event between the two is skipped with nothing left to fetch it",
    ).toEqual(["(none)", "10", "11"]);
  });

  it("resumes from zero after hydrating an empty instance, and applies the first event", async () => {
    // An instance nothing has written to yet: the log's head is 0, and the
    // first event it ever writes is 1 (`device.md` 35).
    harness = await startHarness("catch-up-from-zero");
    const { server, device } = harness;
    scriptHydration(server, { head: "0" });
    server.answer(
      "GET",
      "/events",
      replay("1", [
        itemEvent(
          "1",
          "item.created",
          wireItem({ id: "first", properties: { title: "first", body: "" } }),
        ),
      ]),
    );

    const hydrated = await device.hydrate(["core.note"], "library");
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    expect(hydrated.ok ? hydrated.value.cursor : null).toBe("0");

    const caught = await device.catchUp();
    expect(
      caught.ok,
      `a cursor of zero was refused, so every device that hydrated an empty instance is refused its first catch-up: ${JSON.stringify(caught)}`,
    ).toBe(true);
    if (!caught.ok) return;
    expect(caught.value.applied).toBe(1);
    expect(caught.value.cursor).toBe("1");
    expect(lastEventIds(harness)).toEqual(["(none)", "0"]);
    const status = await device.status();
    expect(status.ok ? status.value.hydration : null).toBe("complete");
    const held = await device.get("first");
    expect(held.ok, "the first event was applied and the row is not held").toBe(
      true,
    );
  });

  it("skips an event older than the row it holds and still advances the cursor", async () => {
    harness = await startHarness("stale-event");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      replay("13", [
        // Version 3 lands, then version 2 arrives behind it. Ids are
        // assigned before commit, so this is the ordinary shape of two
        // writes to one row rather than a contrived one.
        itemEvent(
          "11",
          "item.created",
          wireItem({
            id: "row",
            version: 3,
            properties: { title: "row", body: "the newer body" },
          }),
        ),
        itemEvent(
          "12",
          "item.updated",
          wireItem({
            id: "row",
            version: 2,
            properties: { title: "row", body: "the older body" },
          }),
        ),
        // A third row, so the count assertions below are about the skip
        // rather than about a stream that carried one event.
        itemEvent("13", "item.created", wireItem({ id: "other", version: 1 })),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(
      caught.ok,
      `the catch-up failed, so nothing below is a statement about a skip: ${JSON.stringify(caught)}`,
    ).toBe(true);
    if (!caught.ok) return;

    const held = await device.get("row");
    expect(
      held.ok,
      `the row is not readable at all after two events about it, so the version assertions below never run: ${JSON.stringify(held)}`,
    ).toBe(true);
    if (held.ok) {
      expect(
        held.value.version,
        "the older event was applied over the newer one, so a copy holds a row the server replaced and nothing says so",
      ).toBe(3);
      expect(
        held.value.properties.body,
        "the fields moved back with the version, so a device shows a caller a body the server no longer holds",
      ).toBe("the newer body");
    }

    // Skipping is a success, not a failure: the cursor moves past the event
    // so the next catch-up resumes after it. A cursor left behind would
    // fetch the same stale event forever.
    expect(
      caught.value.cursor,
      "the cursor stopped at the stale event, so every later catch-up replays it and never reaches the head",
    ).toBe("13");
    expect(
      caught.value.skipped,
      "the stale event was counted as applied, so a report cannot tell a caller what their copy actually took",
    ).toBeGreaterThanOrEqual(1);
    // The control: the events either side of the stale one did land.
    expect(
      caught.value.applied,
      "nothing was applied at all, so the skip above is a catch-up that did nothing rather than one that judged an event",
    ).toBeGreaterThanOrEqual(2);
  });

  it("applies a transition, a delete and a restore, none of which move the version", async () => {
    harness = await startHarness("lifecycle-events");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      // Every one of these carries version 1, because the server moves the
      // modification time on a lifecycle write and leaves the version
      // alone. A rule that skipped a version "no newer than" the one held
      // would drop all three and report the catch-up as clean.
      replay("14", [
        itemEvent("11", "item.created", wireItem({ id: "row", version: 1 })),
        itemEvent(
          "12",
          "item.state_changed",
          wireItem({ id: "row", version: 1, state: "archived" }),
        ),
        itemEvent(
          "13",
          "item.deleted",
          wireItem({ id: "row", version: 1, state: "trashed" }),
        ),
        itemEvent(
          "14",
          "item.restored",
          wireItem({ id: "row", version: 1, state: "active" }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(
      caught.ok,
      `the catch-up failed, so nothing below is a statement about lifecycle events: ${JSON.stringify(caught)}`,
    ).toBe(true);
    if (!caught.ok) return;

    // The last one wins, and it is the state the row ends in that says all
    // four landed: a device that skipped the three same-version events
    // would hold the row exactly as the create left it.
    const held = await device.get("row");
    expect(
      held.ok,
      `the row is not readable at all after four events about it: ${JSON.stringify(held)}`,
    ).toBe(true);
    if (held.ok) {
      expect(
        held.value.state,
        "a lifecycle event that did not move the version was skipped, so a device never learns a row was archived, deleted or restored and goes on answering the state it first saw",
      ).toBe("active");
    }

    expect(
      caught.value.skipped,
      "an event was skipped, and the only candidates here are the three that share a version with the row they change",
    ).toBe(0);
    expect(
      caught.value.applied,
      "fewer than four events landed, so at least one lifecycle change was dropped",
    ).toBe(4);
  });

  it("applies a tag write that leaves the version where it was", async () => {
    harness = await startHarness("metadata-event");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      replay("12", [
        itemEvent("11", "item.created", wireItem({ id: "row", version: 1 })),
        // A tag write moves `updated_at` and not the version, so this frame
        // carries the version the device already holds.
        itemEvent(
          "12",
          "metadata.changed",
          wireItem({ id: "row", version: 1 }),
          {
            tags: ["filed"],
          },
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(
      caught.ok,
      `the catch-up failed, so nothing below is a statement about a tag write: ${JSON.stringify(caught)}`,
    ).toBe(true);

    const held = await device.get("row");
    expect(held.ok).toBe(true);
    if (held.ok) {
      expect(
        held.value.tags,
        "a tag write that did not move the version was skipped, so a device's tags drift from the server's with nothing to say so",
      ).toContain("filed");
    }
  });

  it("applies an event beneath a write it has not had answered", async () => {
    harness = await startHarness("event-beneath-write");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "row",
              version: 1,
              properties: { title: "as hydrated", body: "as hydrated" },
            },
          },
        ],
      },
    });
    server.answer(
      "GET",
      "/events",
      replay("11", [
        // Another device changed the body. This one has a title edit queued
        // and unanswered.
        itemEvent(
          "11",
          "item.updated",
          wireItem({
            id: "row",
            version: 2,
            properties: { title: "as hydrated", body: "changed elsewhere" },
          }),
          { tags: ["from elsewhere"] },
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect(
      (
        await device.update("row", {
          properties: { title: "edited here, not yet sent" },
          version: 1,
        })
      ).ok,
    ).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);

    const held = await device.get("row");
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    // The witness: the event was applied, so the title below is the edit
    // surviving an applied event rather than an event that never landed.
    expect(
      held.value.properties.body,
      "the event was not applied at all, so nothing here is about applying one beneath a waiting write",
    ).toBe("changed elsewhere");
    expect(held.value.version).toBe(2);
    expect(
      held.value.properties.title,
      "the event erased an edit the device has not had answered, so the copy shows the write as undone while the queue still sends it",
    ).toBe("edited here, not yet sent");
  });

  it("applies an edge event beneath an edge edit it has not had answered", async () => {
    harness = await startHarness("edge-event-beneath-write");
    const { server, device } = harness;
    const edge = {
      id: "link",
      source_id: "from",
      target_id: "to",
      edge_type: "references",
      properties: { weight: 1 },
      version: 1,
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
    };
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "from",
              edges: {
                references: { data: [edge], next_cursor: null },
              },
            },
          },
          { item: { id: "to" } },
        ],
      },
    });
    server.answer(
      "GET",
      "/events",
      replay("11", [
        edgeEvent("11", "edge.updated", {
          ...edge,
          version: 2,
          properties: { weight: 1, note: "changed elsewhere" },
        }),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect(
      (
        await device.updateEdge("link", {
          properties: { weight: 2 },
          version: 1,
        })
      ).ok,
    ).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);

    const edges = await device.edgesFrom("from");
    expect(edges.ok).toBe(true);
    const held = edges.ok
      ? edges.value.find((row) => row.id === "link")
      : undefined;
    // The witness: the event was applied.
    expect(
      held?.properties.note,
      "the edge event was not applied at all, so nothing here is about applying one beneath a waiting edit",
    ).toBe("changed elsewhere");
    expect(held?.version).toBe(2);
    expect(
      held?.properties.weight,
      "the edge event erased an edit the device has not had answered",
    ).toBe(2);
  });

  it("applies an event beneath a blocked write, which a release sends again", async () => {
    harness = await startHarness("event-beneath-blocked-write");
    const { server, device } = harness;
    const hydrated = {
      id: "row",
      version: 1,
      properties: { title: "as hydrated", body: "as hydrated" },
    };
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: hydrated }] },
    });
    // The server holds a later version and will not resolve this edit
    // itself, so the edit is blocked `conflict_unresolved` and stays in the
    // queue for a release.
    const snapshot = {
      id: "row",
      version: 2,
      properties: { title: "as hydrated", body: "changed elsewhere" },
      tier: "library" as const,
      occurred_at: "2026-01-01T00:00:00.000Z",
      source_id: null,
    };
    scriptWrites(server, {
      update: [
        answers.versionConflict(
          snapshot,
          { ...snapshot, version: 1 },
          ["title"],
          { fields: {}, default: "last_writer_wins" },
        ),
      ],
    });
    server.answer(
      "GET",
      "/events",
      replay("11", [
        itemEvent(
          "11",
          "item.updated",
          wireItem({
            id: "row",
            version: 2,
            properties: { title: "as hydrated", body: "changed elsewhere" },
          }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect(
      (
        await device.update("row", {
          properties: { title: "edited here" },
          version: 1,
        })
      ).ok,
    ).toBe(true);
    const drained = await device.drain();
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(
      drained.value.verdicts[0]?.verdict,
      "the edit was not blocked, so nothing here is about a blocked write",
    ).toBe("blocked");
    expect((await device.catchUp()).ok).toBe(true);

    const held = await device.get("row");
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(
      held.value.properties.body,
      "the event was not applied at all, so nothing here is about applying one beneath a blocked write",
    ).toBe("changed elsewhere");
    expect(
      held.value.properties.title,
      "the event erased a blocked edit, which is still in the queue for a release to send again, so the copy shows it undone while the queue holds it",
    ).toBe("edited here");
  });

  it("applies each event on a held stream as it arrives, and resumes from its cursor when the stream drops", async () => {
    harness = await startHarness("follow-held");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "row",
              version: 1,
              properties: { title: "as hydrated", body: "the body" },
            },
          },
        ],
      },
    });
    const resumedFrom: Array<string | undefined> = [];
    server.answer(
      "GET",
      "/events",
      // Two events and then the stream ends: the connection a laptop loses
      // when it sleeps. The second is older than the row it names, so it
      // changes nothing and is not reported.
      (request) => {
        resumedFrom.push(request.headers["last-event-id"]);
        return {
          kind: "sse",
          frames: [
            connected,
            itemEvent(
              "11",
              "item.updated",
              wireItem({
                id: "row",
                version: 2,
                properties: { title: "changed while held", body: "the body" },
              }),
            ),
            itemEvent(
              "12",
              "item.updated",
              wireItem({
                id: "row",
                version: 1,
                properties: { title: "as hydrated", body: "the body" },
              }),
            ),
          ],
        };
      },
      // A connection dropped before it answered.
      (request) => {
        resumedFrom.push(request.headers["last-event-id"]);
        return { kind: "drop" };
      },
      (request) => {
        resumedFrom.push(request.headers["last-event-id"]);
        return {
          kind: "sse",
          hold: true,
          frames: [
            connected,
            itemEvent(
              "13",
              "item.created",
              wireItem({
                id: "arrived",
                version: 1,
                properties: { title: "arrived live", body: "new" },
              }),
            ),
          ],
        };
      },
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const follow = device.holdFollow(10);
    try {
      // As it arrives: the change is told while the stream is still held,
      // not when the follow ends.
      await vi.waitFor(
        () => {
          expect(
            follow.stdout,
            `the event on the held stream was not told: ${follow.stderr}`,
          ).toContain('"cursor":"13"');
        },
        { timeout: 9_000, interval: 50 },
      );
      expect(
        follow.running(),
        "the change was told only once the follow ended",
      ).toBe(true);
    } finally {
      await follow.stop();
    }
    const lines = follow.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      lines.map((change) => [change.event, change.item_id, change.cursor]),
      "the device did not report each event that changed the copy, and only those, in the order they arrived",
    ).toEqual([
      ["item.updated", "row", "11"],
      ["item.created", "arrived", "13"],
    ]);
    expect(
      resumedFrom,
      "the stream was opened again from somewhere other than the last event applied, so an event in between is lost or applied twice",
    ).toEqual(["10", "12", "12"]);

    const held = await device.get("row");
    expect(held.ok && held.value.properties.title).toBe("changed while held");
    expect(
      (await device.get("arrived")).ok,
      "the event that arrived on the held stream was reported and not applied",
    ).toBe(true);
  });

  it("asks again at a falling rate when every stream ends at once, and ends on an answer no retry changes", async () => {
    harness = await startHarness("follow-backoff");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    // A server that ends every stream the moment it opens, and later one
    // that fails and then refuses.
    let next: Answer[] = [];
    server.answer("GET", "/events", () =>
      next.length > 1
        ? next.shift()!
        : (next[0] ?? { kind: "sse", frames: [connected] }),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const streams = () =>
      server.requests.filter((request) => request.pathname === "/events")
        .length;
    const before = streams();
    const followed = await device.follow(4);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    const asked = streams() - before;
    // The witness: it does ask again.
    expect(asked, "the follow never asked for a stream again").toBeGreaterThan(
      1,
    );
    expect(
      asked,
      "the follow asked for a new stream the moment each one ended, which hammers a server that ends them and never lets a laptop sleep",
    ).toBeLessThanOrEqual(4);
    if (followed.ok) {
      expect(
        followed.value.report,
        "the report does not count the streams asked for after the first, or counts a failure that did not happen",
      ).toMatchObject({
        reconnects: asked - 1,
        failed_opens: 0,
        last_failure: null,
      });
    }

    // A server failing is asked again, and the report says so.
    next = [
      refusal(503, "unavailable", "busy"),
      { kind: "sse", frames: [connected] },
    ];
    const failedFrom = streams();
    const failing = await device.follow(3);
    expect(failing.ok, JSON.stringify(failing)).toBe(true);
    expect(
      streams() - failedFrom,
      "the 503 was not asked again",
    ).toBeGreaterThan(1);
    if (failing.ok) {
      expect(failing.value.report.failed_opens).toBe(1);
      expect(
        failing.value.report.last_failure,
        "the report does not say why a stream could not be opened",
      ).toContain("503");
    }

    // An answer that no retry changes ends the follow and says so.
    next = [
      refusal(503, "unavailable", "busy"),
      refusal(405, "method_not_allowed", "not here"),
    ];
    const refusedFrom = streams();
    const refused = await device.follow(10);
    expect(
      refused.ok,
      "a follow went on asking for a stream the server will never serve, and said nothing",
    ).toBe(false);
    if (!refused.ok) expect(refused.refusal.raw).toContain("405");
    expect(
      streams() - refusedFrom,
      "the 503 was not asked again, so a server busy for a moment ends every follow",
    ).toBe(2);
  });

  it("ends a follow whose reader has gone, rather than going on untold", async () => {
    harness = await startHarness("follow-unprinted");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      // The first stream ends at once, so the change arrives on the next,
      // after the reader of what the follow prints has gone.
      { kind: "sse", frames: [connected] },
      {
        kind: "sse",
        hold: true,
        frames: [
          connected,
          itemEvent("11", "item.created", wireItem({ id: "arrived" })),
        ],
      },
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const follow = device.holdFollow(60);
    follow.closeStdout();
    const ended = await Promise.race([
      follow.exited().then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          resolve(false);
        }, 20_000),
      ),
    ]);
    await follow.stop();
    expect(
      ended,
      "a follow that could not print a change went on following, applying changes nobody is told of",
    ).toBe(true);
    // A reader that went away is not a failure, as it is not for any
    // command whose output is cut off.
    expect(follow.exitCode(), follow.stderr).toBe(0);
    // The witness: the change it could not print had arrived and been
    // applied, so the follow did meet a line it could not write.
    expect((await device.get("arrived")).ok).toBe(true);
  });

  it("prints its report when interrupted, as it does when its time is up", async () => {
    harness = await startHarness("follow-interrupted");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer("GET", "/events", {
      kind: "sse",
      hold: true,
      frames: [
        connected,
        itemEvent("11", "item.created", wireItem({ id: "arrived" })),
      ],
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const follow = device.holdFollow();
    try {
      await vi.waitFor(
        () => {
          expect(
            follow.stdout,
            `the follow never told the change: ${follow.stderr}`,
          ).toContain('"cursor":"11"');
        },
        { timeout: 10_000, interval: 25 },
      );
      follow.interrupt();
      const ended = await Promise.race([
        follow.exited().then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => {
            resolve(false);
          }, 5_000),
        ),
      ]);
      expect(ended, "an interrupted follow went on following").toBe(true);
    } finally {
      await follow.stop();
    }
    expect(
      follow.exitCode(),
      `an interrupted follow did not end on its own: ${follow.stderr}`,
    ).toBe(0);
    const report = JSON.parse(
      follow.stdout.trim().split("\n").at(-1) ?? "null",
    ) as FollowReport | null;
    expect(
      report,
      "an interrupted follow ended without saying what it did",
    ).toMatchObject({ applied: 1, cursor: "11" });
  });

  it("ends a follow at once when stopped while its stream is still being asked for", async () => {
    harness = await startHarness("follow-stall");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer("GET", "/events", { kind: "stall" });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const started = Date.now();
    const followed = await device.follow(1);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    // The witness: the stream was asked for and never answered.
    expect(
      server.requests.filter((request) => request.pathname === "/events")
        .length,
    ).toBe(2);
    expect(
      Date.now() - started,
      "the follow waited out a request nobody answered after it was told to stop, holding the store the whole time",
    ).toBeLessThan(5_000);
    if (followed.ok) expect(followed.value.report.cursor).toBe("10");
  });

  it("holds an item whose type was registered after the stream opened, in the slice through its parent", async () => {
    harness = await startHarness("follow-late-type");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    // Registered after the device read the catalog: the hydration and the
    // first stream read it without the type, every read after with it.
    let reads = 0;
    server.answer("GET", "/types", () => {
      reads += 1;
      return {
        kind: "json",
        status: 200,
        body: {
          data: [
            wireType("core.note"),
            wireType("core.file"),
            ...(reads > 1
              ? [wireType("acme.late-note", { parent: "core.note" })]
              : []),
          ],
          next_cursor: null,
        },
      };
    });
    server.answer(
      "GET",
      "/events",
      heldLog([
        itemEvent(
          "11",
          "item.created",
          wireItem({ id: "late", type: "acme.late-note" }),
        ),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const followed = await device.follow(3);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    if (!followed.ok) return;
    expect(
      (await device.get("late")).ok,
      "an item of a type registered after the stream opened was dropped, though its parent is a type the slice declares",
    ).toBe(true);
    expect(
      followed.value.changes.map((change) => [change.item_id, change.cursor]),
    ).toEqual([["late", "11"]]);
    expect(followed.value.report.cursor).toBe("11");
    expect(
      followed.value.report.reconnects,
      "the stream was not opened again to read the catalog the event needed",
    ).toBe(1);
  });

  it("reads the catalog once for a type the server will not describe, not once for each event naming it", async () => {
    harness = await startHarness("follow-undescribed-type");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    const ids = Array.from({ length: 20 }, (_, n) => String(11 + n));
    server.answer(
      "GET",
      "/events",
      heldLog(
        ids.map((id) =>
          itemEvent(
            id,
            "item.created",
            wireItem({ id: `gone-${id}`, type: "acme.gone" }),
          ),
        ),
      ),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const asked = (pathname: string) =>
      server.requests.filter((request) => request.pathname === pathname).length;
    const before = { types: asked("/types"), events: asked("/events") };
    const followed = await device.follow(3);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    if (!followed.ok) return;
    // The witness: the first event naming the type did send the device to
    // the catalog again.
    expect(asked("/types") - before.types).toBe(2);
    expect(
      asked("/events") - before.events,
      "each event naming a type the catalog never learns opened the stream again",
    ).toBe(2);
    expect(followed.value.report.skipped).toBe(20);
    expect(followed.value.report.cursor).toBe("30");
  });

  it("reads the catalog once a stream for an image under a property declared as text, and holds it as text", async () => {
    harness = await startHarness("follow-image-as-text");
    const { server, device } = harness;
    // `icon` is declared as text and holds an image. The catalog it has
    // cannot tell that from a property the type has since made its
    // thumbnail, so the stream opens again once to read it; read again, it
    // is still text, and every event after is taken as it is.
    scriptHydration(server, {
      head: "10",
      catalog: {
        kind: "json",
        status: 200,
        body: {
          data: [
            wireType("core.note"),
            wireType("core.file"),
            wireType("user.photo", {
              fields: {
                title: { type: "string" },
                body: { type: "string" },
                icon: { type: "string" },
              },
            }),
          ],
          next_cursor: null,
        },
      },
    });
    const ids = ["11", "12", "13", "14", "15"];
    server.answer(
      "GET",
      "/events",
      heldLog(
        ids.map((id) =>
          itemEvent(
            id,
            "item.created",
            wireItem({
              id: `photo-${id}`,
              type: "user.photo",
              properties: {
                title: `Photo ${id}`,
                body: "as sent",
                icon: "data:image/png;base64,iVBORw0KGgoA/iconwordXYZ",
              },
            }),
          ),
        ),
      ),
    );
    expect((await device.hydrate(["user.photo"], "library")).ok).toBe(true);
    const asked = (pathname: string) =>
      server.requests.filter((request) => request.pathname === pathname).length;
    const before = { types: asked("/types"), events: asked("/events") };
    const followed = await device.follow(3);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    if (!followed.ok) return;
    // The witness: the image did send the device to the catalog again.
    expect(asked("/types") - before.types).toBe(2);
    expect(
      asked("/events") - before.events,
      "each event carrying an image under a property declared as text opened the stream again",
    ).toBe(2);
    expect(followed.value.report.reconnects).toBe(1);
    expect(followed.value.report.applied).toBe(5);
    const hits = await device.search("iconwordXYZ");
    expect(
      hits.ok ? hits.value.map((hit) => hit.item.id).sort() : [],
      "an image under a property declared as text was not held and indexed as the text it is",
    ).toEqual(ids.map((id) => `photo-${id}`));
  });

  it("ends a follow whose cursor the log has aged past, and forgets the cursor", async () => {
    harness = await startHarness("follow-aged-out");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer("GET", "/events", {
      kind: "sse",
      frames: [connected, streamCursor("900"), catchupTooOld("500", "10")],
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const before = server.requests.filter(
      (request) => request.pathname === "/events",
    ).length;
    const aged = await device.follow(5);
    expect(
      aged.ok,
      "a held stream told its cursor had aged out went on as if current",
    ).toBe(false);
    if (!aged.ok) expect(aged.refusal.code).toBe("catch_up_too_old");
    expect(
      server.requests.filter((request) => request.pathname === "/events")
        .length - before,
      "the follow asked again from a cursor the log cannot serve",
    ).toBe(1);
    const status = await device.status();
    expect(
      status.ok && status.value.event_cursor,
      "the aged-out cursor is still held, so the next follow asks from it again",
    ).toBeFalsy();
  });

  it("leaves the cursor at the last applied event when the stream ends early", async () => {
    harness = await startHarness("short-stream");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      // The head is 20 and the stream carries two events and then ends, which
      // is what a dropped connection looks like from the reading end.
      replay("20", [
        itemEvent("11", "item.created", wireItem({ id: "a" })),
        itemEvent("12", "item.created", wireItem({ id: "b" })),
      ]),
      replay("20", []),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok).toBe(true);
    expect(
      caught.ok ? caught.value.cursor : undefined,
      "the cursor moved past the events the device actually applied, so everything between is skipped with nothing left to fetch it",
    ).toBe("12");

    await device.catchUp();
    expect(
      lastEventIds(harness),
      "the next catch-up resumed from somewhere other than the last event applied, so a stream that ends early loses everything between",
    ).toEqual(["(none)", "10", "12"]);
  });

  it("reports reaching the head, and reports stopping short of it", async () => {
    harness = await startHarness("head-report");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      replay("20", [
        itemEvent("11", "item.created", wireItem({ id: "short" })),
      ]),
      replay("12", [
        itemEvent("12", "item.created", wireItem({ id: "complete" })),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const short = await device.catchUp();
    expect(short.ok).toBe(true);
    expect(
      short.ok ? short.value.reached_head : undefined,
      "a catch-up that stopped eight events short of the head reported a clean pass, so a caller believes the copy is current when it is not",
    ).toBe(false);
    expect(
      short.ok
        ? [short.value.applied, short.value.skipped, short.value.cursor]
        : undefined,
      "the report did not count what it applied and skipped or name where it reached, so nothing can tell a catch-up that did work from one that did none",
    ).toEqual([1, 0, "11"]);

    const complete = await device.catchUp();
    expect(complete.ok).toBe(true);
    expect(
      complete.ok ? complete.value.reached_head : undefined,
      "a catch-up that reached the log's head did not say so, so nothing can tell a current copy from a lagging one",
    ).toBe(true);
  });
});

describe("catch-up keeps the copy to its slice", () => {
  it("evicts a row that leaves the slice", async () => {
    harness = await startHarness("eviction");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [{ item: { id: "stays" } }, { item: { id: "leaves" } }],
      },
    });
    server.answer(
      "GET",
      "/events",
      replay("11", [
        itemEvent(
          "11",
          "item.updated",
          wireItem({ id: "leaves", tier: "feed", version: 2 }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);

    const held = await device.list();
    expect(held.ok).toBe(true);
    const ids = held.ok ? held.value.map((item) => item.id) : [];
    // The control: the row that did not move is still there, so an eviction
    // is being read rather than a copy that was cleared.
    expect(
      ids,
      "the copy lost a row the event said nothing about, so this reads an eviction where the whole slice was cleared",
    ).toContain("stays");
    expect(
      ids,
      "a row that left the slice stayed in the copy, so a device keeps answering for rows it no longer hears about and cannot say how stale they are",
    ).not.toContain("leaves");
  });

  it("does not add a row that was never in the slice", async () => {
    harness = await startHarness("no-add");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      replay("12", [
        itemEvent("11", "item.created", wireItem({ id: "declared" })),
        itemEvent(
          "12",
          "item.created",
          wireItem({ id: "undeclared", type: "core.bookmark" }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);

    const held = await device.list();
    const ids = held.ok ? held.value.map((item) => item.id) : [];
    expect(
      ids,
      "the declared type's event did not land, so the assertion below passes against a device that applied nothing at all",
    ).toContain("declared");
    expect(
      ids,
      "an event for a type outside the slice added a row, so the copy grows with every type anybody writes on the server",
    ).not.toContain("undeclared");
  });

  it("refreshes the type catalog before applying", async () => {
    harness = await startHarness("catalog");
    const { server, device } = harness;
    server.answer("GET", "/events", headRead("10"));
    server.answer(
      "GET",
      "/types",
      typeCatalog(),
      // A type registered while the device was away, whose parent is a type
      // the device declared. Read against the old catalog it belongs to no
      // subtree and the row is thrown away.
      {
        kind: "json",
        status: 200,
        body: {
          data: [
            wireType("core.note"),
            wireType("core.file"),
            wireType("acme.field-note", { parent: "core.note" }),
          ],
          next_cursor: null,
        },
      },
    );
    server.answer("GET", "/items", itemsPage([]));
    server.answer(
      "GET",
      "/events",
      replay("11", [
        itemEvent(
          "11",
          "item.created",
          wireItem({ id: "registered-while-away", type: "acme.field-note" }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);

    expect(
      server.requests.filter((request) => request.pathname === "/types").length,
      "the catch-up did not read the type registry, so its idea of the type graph is whatever the last hydration saw",
    ).toBeGreaterThanOrEqual(2);
    const held = await device.list();
    expect(
      held.ok ? held.value.map((item) => item.id) : [],
      "a row of a subtype registered while the device was away was discarded, so declaring a type stops covering its subtree the moment anybody adds one",
    ).toContain("registered-while-away");
  });

  it("reads the catalog again, once for each, for a type an event names that it does not hold", async () => {
    harness = await startHarness("catalog-behind");
    const { server, device } = harness;
    server.answer("GET", "/events", headRead("10"));
    // The hydration and the catch-up's first read know neither type; the
    // one registered after the catch-up began is there from the next read,
    // and the other is never described.
    server.answer("GET", "/types", typeCatalog(), typeCatalog(), {
      kind: "json",
      status: 200,
      body: {
        data: [
          wireType("core.note"),
          wireType("core.file"),
          wireType("acme.late-note", { parent: "core.note" }),
        ],
        next_cursor: null,
      },
    });
    server.answer("GET", "/items", itemsPage([]));
    server.answer(
      "GET",
      "/events",
      replay("14", [
        itemEvent(
          "11",
          "item.created",
          wireItem({ id: "late", type: "acme.late-note" }),
        ),
        ...["12", "13", "14"].map((id) =>
          itemEvent(
            id,
            "item.created",
            wireItem({ id: `gone-${id}`, type: "acme.gone" }),
          ),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const reads = () =>
      server.requests.filter((request) => request.pathname === "/types").length;
    const before = reads();
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    if (!caught.ok) return;
    expect(caught.value.cursor).toBe("14");
    const held = await device.list();
    expect(
      held.ok ? held.value.map((item) => item.id) : [],
      "a row of a type registered after the catch-up read the catalog was discarded, though its parent is a type the slice declares",
    ).toEqual(["late"]);
    expect(
      reads() - before,
      "the catalog was not read once for the catch-up and once for each type an event named that it did not hold",
    ).toBe(3);
  });

  it("reads the catalog once for an image under a property no type declares, not once for each event carrying it", async () => {
    harness = await startHarness("catalog-undeclared-image");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    const ids = ["11", "12", "13"];
    server.answer(
      "GET",
      "/events",
      replay(
        "13",
        ids.map((id) =>
          itemEvent(
            id,
            "item.created",
            wireItem({
              id: `note-${id}`,
              properties: {
                title: `Note ${id}`,
                body: "as sent",
                preview: "data:image/png;base64,iVBORw0KGgoA/previewXYZ",
              },
            }),
          ),
        ),
      ),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const reads = () =>
      server.requests.filter((request) => request.pathname === "/types").length;
    const before = reads();
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    if (!caught.ok) return;
    expect(caught.value.cursor).toBe("13");
    // The witness: the image did send the catch-up to the catalog again,
    // once more than the read it starts with.
    expect(
      reads() - before,
      "an image under a property no type declares was read again for with each event carrying it, or never",
    ).toBe(2);
    const held = await device.list();
    expect(held.ok ? held.value.map((item) => item.id).sort() : []).toEqual(
      ids.map((id) => `note-${id}`),
    );
  });
});

describe("a cursor the log no longer holds", () => {
  it("ends on an aged-out cursor and hydrates again rather than reconnecting", async () => {
    harness = await startHarness("aged-out");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "first" } }] },
    });
    server.answer("GET", "/events", {
      kind: "sse",
      frames: [connected, streamCursor("900"), catchupTooOld("500", "10")],
    });

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const before = server.requests.filter(
      (request) => request.pathname === "/events",
    ).length;

    const aged = await device.catchUp();
    expect(
      aged.ok,
      "a cursor the log no longer holds was answered as a clean catch-up, so the copy is missing every write that aged out and reports itself current",
    ).toBe(false);
    if (!aged.ok) {
      expect(
        aged.refusal.code,
        `the refusal did not name the aged-out cursor: ${aged.refusal.raw}`,
      ).toBe("catch_up_too_old");
      expect(
        aged.refusal.raw,
        "the refusal did not carry the oldest id the log still holds, so nothing can say how far behind the copy is",
      ).toContain("500");
    }
    expect(
      server.requests.filter((request) => request.pathname === "/events")
        .length - before,
      "the device subscribed again after being told its cursor had aged out, which replays from a point the log cannot serve and quietly returns nothing",
    ).toBe(1);

    // And the remedy is a hydration, which the device can still perform.
    server.answer("GET", "/events", headRead("900"));
    const again = await device.hydrate(["core.note"], "library");
    expect(
      again.ok,
      `the device could not hydrate after an aged-out cursor: ${JSON.stringify(again)}`,
    ).toBe(true);
    expect(
      again.ok ? again.value.cursor : undefined,
      "the hydration after an aged-out cursor stored some other resume point, so the next catch-up ages out again",
    ).toBe("900");
  });
  it("refuses reads after the cursor ages out, until a hydration", async () => {
    harness = await startHarness("aged-out-reads");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "first" } }] },
    });
    server.answer("GET", "/events", {
      kind: "sse",
      frames: [connected, streamCursor("900"), catchupTooOld("500", "10")],
    });

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    // The control, and the reason this case is not the sibling above: the
    // copy answers before the cursor ages out. What follows is the aging,
    // not a device that was refusing all along.
    const before = await device.list();
    expect(
      before.ok,
      `a hydrated copy would not answer a listing at all, so the refusal below says nothing about the cursor: ${JSON.stringify(before)}`,
    ).toBe(true);
    expect(
      before.ok ? before.value.map((item) => item.id) : [],
      "the hydration landed no rows, so the refusal below is about an empty copy rather than an aged-out one",
    ).toContain("first");

    expect((await device.catchUp()).ok).toBe(false);

    // The copy is complete as of the moment it stopped, and it refuses
    // anyway: it can no longer be kept current, and a copy that has quietly
    // stopped tracking is worse than one that says it cannot answer.
    const after = await device.list();
    expect(
      after.ok,
      "a copy whose cursor has aged out still answers reads, so it goes on serving a snapshot that has silently stopped tracking the server",
    ).toBe(false);
    if (!after.ok) {
      expect(
        after.refusal.code,
        `the refusal did not say a hydration is owed: ${after.refusal.raw}`,
      ).toBe("hydration_incomplete");
    }

    // What the report says about a store in this state. `expired` and not
    // `never`, which is a copy that holds nothing, nor `complete`, which is
    // a copy that can still be kept current: this one holds its slice and
    // its rows and can no longer follow the server. The advice a caller
    // acts on is the same either way — hydrate — but `never` would have
    // said the copy is empty, and a caller deciding whether to keep
    // answering from it reads that and is wrong.
    const reported = await device.status();
    expect(
      reported.ok,
      `the status door was refused, so nothing below says what an aged-out store reports: ${JSON.stringify(reported)}`,
    ).toBe(true);
    if (reported.ok) {
      expect(
        reported.value.hydration,
        "an aged-out store did not report itself as expired, so a caller weighing whether the copy in hand is worth anything is told the wrong thing about it",
      ).toBe("expired");
      // The witness for the word. `expired` is only worth having on a
      // store that has something in it: with the slice and the rows gone,
      // the two words would describe the same store and either would do.
      // The rows, not only the declaration — the declaration survives a
      // store with nothing in it, and what the word promises a caller is
      // that the copy in hand is still worth something.
      expect(
        reported.value.slice_types,
        "the report says the slice is empty as well, so `expired` is a guess rather than a reading of what the store holds",
      ).toContain("core.note");
      expect(
        reported.value.items,
        "the aging took the rows with it, so `expired` describes an empty store and promises a caller a copy that is not there",
      ).toBe(1);
      expect(
        reported.value.event_cursor ?? null,
        "the store still holds a cursor, so `expired` is not about the aging at all",
      ).toBeNull();
    }

    // And a hydration clears it, which is what makes the refusal a state to
    // leave rather than a store to discard.
    server.answer("GET", "/events", headRead("900"));
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const recovered = await device.list();
    expect(
      recovered.ok,
      `a hydration did not clear the refusal, so an aged-out cursor bricks the store: ${JSON.stringify(recovered)}`,
    ).toBe(true);
  });
});
