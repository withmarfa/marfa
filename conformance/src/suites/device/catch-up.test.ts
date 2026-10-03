import { describe, it, expect, afterEach, vi } from "vitest";
import {
  startHarness,
  scriptHydration,
  scriptKey,
  scriptWrites,
  type Harness,
} from "./harness.js";
import {
  answers,
  catchupTooOld,
  connected,
  cursorAhead,
  edgeEvent,
  copyHeadRead,
  copyHeldLog,
  copyItemEvent,
  itemsPage,
  copyLiveReplay,
  refusal,
  copyReplay,
  copyIncompleteReplay,
  copyStreamCursor,
  copyStreamLive,
  SCRIPTED_INSTANCE,
  edgeTypeCatalog,
  typeCatalog,
  wireEdge,
  wireItem,
  wireType,
} from "../../device/marfa-answers.js";
import { BUILT_FOR, type Answer } from "../../device/scripted-server.js";
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
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("12", [
        copyItemEvent("11", "item.created", wireItem({ id: "n2" })),
        copyItemEvent("12", "item.created", wireItem({ id: "n3" })),
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
    ).toEqual(["(none)", "10", "10"]);
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
    // The real server delivers ids in order (`events.md` 3); this one hands
    // a lower id after a higher one, which a cursor kept as a high-water
    // mark would step over for good. The rule is that the cursor is what
    // was applied, whatever arrived.
    server.copyAnswer(
      "GET",
      "/events",
      copyIncompleteReplay("20", [
        copyItemEvent(
          "12",
          "item.created",
          wireItem({ id: "committed-second" }),
        ),
        copyItemEvent(
          "11",
          "item.created",
          wireItem({ id: "committed-first" }),
        ),
      ]),
      copyIncompleteReplay("20", []),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const incomplete = await device.catchUp();
    expect(incomplete.ok ? null : incomplete.refusal.code).toBe(
      "stream_incomplete",
    );
    await device.catchUp();

    expect(
      lastEventIds(harness),
      "the second replay resumed from the highest id seen rather than the last one applied, so every event between the two is skipped with nothing left to fetch it",
    ).toEqual(["(none)", "10", "10", "11"]);
  });

  it("resumes from zero after hydrating an empty instance, and applies the first event", async () => {
    // An instance nothing has written to yet: the log's head is 0, and the
    // first event it ever writes is 1 (`device.md` 35).
    harness = await startHarness("catch-up-from-zero");
    const { server, device } = harness;
    scriptHydration(server, { head: "0" });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("1", [
        copyItemEvent(
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
    expect(lastEventIds(harness)).toEqual(["(none)", "0", "0"]);
    const status = await device.status();
    expect(status.ok ? status.value.hydration : null).toBe("complete");
    const held = await device.get("first");
    expect(held.ok, "the first event was applied and the row is not held").toBe(
      true,
    );
  });

  it("skips an event at the version it holds that was stamped before the row it holds", async () => {
    harness = await startHarness("stale-stamp");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("12", [
        // Archived at version 3, then an event from before the transition
        // arrives behind it: the version cannot tell them apart, since a
        // transition leaves it where it was, and the time each was written
        // can. A follow and a drain on one core meet this shape when the
        // drain writes a row it read ahead of the stream.
        copyItemEvent(
          "11",
          "item.created",
          wireItem({
            id: "row",
            version: 3,
            state: "archived",
            updated_at: "2026-03-02T00:00:00.000Z",
          }),
        ),
        copyItemEvent(
          "12",
          "item.updated",
          wireItem({
            id: "row",
            version: 3,
            state: "active",
            updated_at: "2026-03-01T00:00:00.000Z",
          }),
        ),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok).toBe(true);
    if (!caught.ok) return;
    expect(caught.value.skipped).toBe(1);
    expect(caught.value.cursor).toBe("12");
    const listed = await device.list({ state: "archived" });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(
      listed.value.map((row) => row.id),
      "an event stamped before the row the copy holds took it back to active, so an archive another device made is undone on this one",
    ).toEqual(["row"]);
  });

  it("skips an event older than the row it holds and still advances the cursor", async () => {
    harness = await startHarness("stale-event");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("13", [
        // Version 3 lands, then version 2 arrives behind it: a shape the
        // real server does not produce, since it delivers ids in order,
        // and one the device still takes by the version, not by arrival.
        copyItemEvent(
          "11",
          "item.created",
          wireItem({
            id: "row",
            version: 3,
            properties: { title: "row", body: "the newer body" },
          }),
        ),
        copyItemEvent(
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
        copyItemEvent(
          "13",
          "item.created",
          wireItem({ id: "other", version: 1 }),
        ),
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
    server.copyAnswer(
      "GET",
      "/events",
      // Every one of these carries version 1, because the server moves the
      // modification time on a lifecycle write and leaves the version
      // alone. A rule that skipped a version "no newer than" the one held
      // would drop all three and report the catch-up as clean.
      copyReplay("14", [
        copyItemEvent(
          "11",
          "item.created",
          wireItem({ id: "row", version: 1 }),
        ),
        copyItemEvent(
          "12",
          "item.state_changed",
          wireItem({ id: "row", version: 1, state: "archived" }),
        ),
        copyItemEvent(
          "13",
          "item.deleted",
          wireItem({ id: "row", version: 1, state: "trashed" }),
        ),
        copyItemEvent(
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
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("12", [
        copyItemEvent(
          "11",
          "item.created",
          wireItem({ id: "row", version: 1 }),
        ),
        // A tag write moves `updated_at` and not the version, so this frame
        // carries the version the device already holds.
        copyItemEvent(
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
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        // Another device changed the body. This one has a title edit queued
        // and unanswered.
        copyItemEvent(
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
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
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
      type: "core.note",
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
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent(
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
    server.copyAnswer(
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
            copyStreamCursor("12"),
            copyItemEvent(
              "11",
              "item.updated",
              wireItem({
                id: "row",
                version: 2,
                properties: { title: "changed while held", body: "the body" },
              }),
            ),
            copyItemEvent(
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
            copyStreamCursor("13"),
            copyItemEvent(
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
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      // The dropped connection is also told as the server lost and back,
      // which has its own fixture.
      .filter((change) => !String(change.event).startsWith("server."));
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

  it("applies an event on a held stream beneath a write it has not had answered", async () => {
    harness = await startHarness("follow-beneath-write");
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
    // The same event the catch-up fixture applies beneath a waiting write,
    // here on the path a held stream takes.
    server.copyAnswer(
      "GET",
      "/events",
      copyHeldLog([
        copyItemEvent(
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
    const edit = await device.update("row", {
      properties: { title: "edited here, not yet sent" },
      version: 1,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    const followed = await device.follow(3);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    if (!followed.ok) return;
    expect(
      followed.value.changes.map((change) => [change.item_id, change.cursor]),
      "the held stream did not apply the event, so nothing here is about applying one beneath a waiting write",
    ).toEqual([["row", "11"]]);

    const held = await device.get("row");
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(held.value.properties.body).toBe("changed elsewhere");
    expect(held.value.version).toBe(2);
    expect(
      held.value.tags,
      "the held stream applied the row and not the tags its event carried",
    ).toEqual(["from elsewhere"]);
    expect(
      held.value.properties.title,
      "an event on the held stream erased an edit the device has not had answered, so a screen following the copy shows the write as undone while the queue still sends it",
    ).toBe("edited here, not yet sent");
  });

  it("applies an edge event on a held stream beneath an edge edit it has not had answered", async () => {
    harness = await startHarness("follow-edge-beneath-write");
    const { server, device } = harness;
    const edge = {
      id: "link",
      source_id: "from",
      type: "core.note",
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
    server.copyAnswer(
      "GET",
      "/events",
      copyHeldLog([
        edgeEvent("11", "edge.updated", {
          ...edge,
          version: 2,
          properties: { weight: 1, note: "changed elsewhere" },
        }),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const edit = await device.updateEdge("link", {
      properties: { weight: 2 },
      version: 1,
    });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    const followed = await device.follow(3);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);

    const edges = await device.edgesFrom("from");
    expect(edges.ok).toBe(true);
    const held = edges.ok
      ? edges.value.find((row) => row.id === "link")
      : undefined;
    // The witness: the event was applied.
    expect(
      held?.properties.note,
      "the held stream did not apply the edge event, so nothing here is about applying one beneath a waiting edit",
    ).toBe("changed elsewhere");
    expect(held?.version).toBe(2);
    expect(
      held?.properties.weight,
      "an edge event on the held stream erased an edit the device has not had answered",
    ).toBe(2);
  });

  it("applies nothing on a held stream from outside its slice", async () => {
    harness = await startHarness("follow-outside-slice");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "leaving", version: 1 } }] },
    });
    server.copyAnswer(
      "GET",
      "/events",
      copyHeldLog([
        copyItemEvent("11", "item.created", wireItem({ id: "declared" })),
        copyItemEvent(
          "12",
          "item.created",
          wireItem({ id: "undeclared", type: "core.bookmark" }),
        ),
        copyItemEvent(
          "13",
          "item.created",
          wireItem({ id: "other-tier", tier: "feed" }),
        ),
        // A row the copy holds, moved out of the slice's tier.
        copyItemEvent(
          "14",
          "item.updated",
          wireItem({ id: "leaving", version: 2, tier: "feed" }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    // The witness for the eviction below: the row was held.
    expect((await device.get("leaving")).ok).toBe(true);
    const followed = await device.follow(3);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    if (!followed.ok) return;
    expect(
      followed.value.report.cursor,
      "the held stream did not reach the last event, so the rows below were never offered to it",
    ).toBe("14");
    const held = await device.list({ allStates: true });
    const ids = held.ok ? held.value.map((item) => item.id) : [];
    expect(
      ids,
      "the declared type's event did not land on the held stream, so the assertion below passes against a follow that applied nothing",
    ).toContain("declared");
    expect(
      ids,
      "an event from outside the slice was applied on the held stream, so a copy left following grows with every type and tier anybody writes",
    ).not.toContain("undeclared");
    expect(ids).not.toContain("other-tier");
    expect(
      ids,
      "a held row that left the slice stayed in the copy on the held stream, where a catch-up drops it",
    ).not.toContain("leaving");
    expect(
      followed.value.changes.map((change) => change.item_id),
      "a row outside the slice was told as a change, or the row that left was not",
    ).toEqual(["declared", "leaving"]);
  });

  it("tells a held stream's caller once that the server cannot be reached, and once that it can again", async () => {
    harness = await startHarness("follow-reach");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    // Had at once, then a failing server and a dropped connection, then a
    // stream held open.
    server.copyAnswer(
      "GET",
      "/events",
      refusal(503, "unavailable", "busy"),
      { kind: "drop" },
      { kind: "sse", frames: [connected], hold: true },
    );
    const followed = await device.follow(10);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    if (!followed.ok) return;
    expect(
      followed.value.report.failed_opens,
      "the stream was never refused, so the changes below are about nothing",
    ).toBe(2);
    const told = followed.value.changes.map((change) => change.event);
    expect(
      told,
      "the caller was not told once that the server was lost and once that it was back, so an app shows offline and online alike",
    ).toEqual(["server.unreachable", "server.reachable"]);
    const lost = followed.value.changes[0];
    expect(
      [lost?.item_id, lost?.edge_id],
      "a change about the server named a row",
    ).toEqual([null, null]);
    expect(lost?.reason, "the caller was not told why").toContain("503");
  });

  it("refuses an event id that is not a number, keeping the cursor it had", async () => {
    harness = await startHarness("catch-up-event-id");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const { edges: _edges, ...row } = wireItem({ id: "n11" });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [copyItemEvent("eleven", "item.created", row)]),
      copyReplay("11", [copyItemEvent("11", "item.created", row)]),
    );
    // The hydration's own head read answers once more first.
    expect((await device.catchUp()).ok).toBe(true);
    const refused = await device.catchUp();
    expect(
      refused.ok,
      "a catch-up took an event id that is not one as its cursor",
    ).toBe(false);
    const status = await device.status();
    expect(
      status.ok && status.value.event_cursor,
      "the cursor moved to an id no start can resume from",
    ).toBe("10");

    // The witness: the same event under an id that is one is taken.
    const taken = await device.catchUp();
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    expect((await device.get("n11")).ok).toBe(true);
  });

  it("asks again at a falling rate when every stream ends at once, and ends on an answer no retry changes", async () => {
    harness = await startHarness("follow-backoff");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    // A server that ends every stream the moment it opens, and later one
    // that fails and then refuses.
    let next: Answer[] = [];
    server.copyAnswer("GET", "/events", () =>
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
    server.copyAnswer(
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
          copyStreamCursor("11"),
          copyItemEvent("11", "item.created", wireItem({ id: "arrived" })),
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
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      hold: true,
      frames: [
        connected,
        copyStreamCursor("11"),
        copyItemEvent("11", "item.created", wireItem({ id: "arrived" })),
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
    server.copyAnswer("GET", "/events", { kind: "stall" });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const started = Date.now();
    const followed = await device.follow(1);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    // The witness: the stream was asked for and never answered.
    expect(
      server.requests.filter((request) => request.pathname === "/events")
        .length,
    ).toBe(3);
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
    server.copyAnswer("GET", "/types", () => {
      reads += 1;
      return typeCatalog(
        reads > 2 ? [wireType("acme.late-note", { parent: "core.note" })] : [],
      );
    });
    scriptKey(server);
    server.copyAnswer(
      "GET",
      "/events",
      copyHeldLog([
        copyItemEvent(
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
      followed.value.changes.map((change) => [
        change.event,
        change.item_id,
        change.cursor,
      ]),
      "the reopened stream read a catalog holding the new type and did not say so before the row it let in (49)",
    ).toEqual([
      ["catalog.changed", null, "10"],
      ["item.created", "late", "11"],
    ]);
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
    server.copyAnswer(
      "GET",
      "/events",
      copyHeldLog(
        ids.map((id) =>
          copyItemEvent(
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
    server.copyAnswer(
      "GET",
      "/events",
      copyHeldLog(
        ids.map((id) =>
          copyItemEvent(
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
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      frames: [connected, copyStreamCursor("900"), catchupTooOld("500", "10")],
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    // The witness: the hydration left a cursor for the follow to lose.
    const held = await device.status();
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) return;
    expect(held.value.event_cursor).toBe("10");

    const before = server.requests.filter(
      (request) => request.pathname === "/events",
    ).length;
    // Given far longer than it needs, so ending is the follow's own doing and
    // not the bound running out.
    const started = Date.now();
    const aged = await device.follow(30);
    expect(
      Date.now() - started,
      "the follow stayed open after its cursor aged out and ended only when its time ran out",
    ).toBeLessThan(10_000);
    expect(
      aged.ok,
      "a held stream told its cursor had aged out went on as if current",
    ).toBe(false);
    if (!aged.ok) expect(aged.refusal.code).toBe("copy_expired");
    expect(
      server.requests.filter((request) => request.pathname === "/events")
        .length - before,
      "the follow asked again from a cursor the log cannot serve",
    ).toBe(1);
    const status = await device.status();
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    expect(
      status.value.event_cursor ?? null,
      "the aged-out cursor is still held, so the next follow asks from it again",
    ).toBeNull();
  });

  it("leaves the cursor at the last applied event when the stream ends early", async () => {
    harness = await startHarness("short-stream");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer(
      "GET",
      "/events",
      // The head is 20 and the stream carries two events and then ends, which
      // is what a dropped connection looks like from the reading end.
      copyIncompleteReplay("20", [
        copyItemEvent("11", "item.created", wireItem({ id: "a" })),
        copyItemEvent("12", "item.created", wireItem({ id: "b" })),
      ]),
      copyIncompleteReplay("20", []),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok ? null : caught.refusal.code).toBe("stream_incomplete");
    const status = await device.status();
    expect(status.ok ? status.value.event_cursor : null).toBe("12");

    await device.catchUp();
    expect(
      lastEventIds(harness),
      "the next catch-up resumed from somewhere other than the last event applied, so a stream that ends early loses everything between",
    ).toEqual(["(none)", "10", "10", "12"]);
  });

  it("reports reaching the head, and reports stopping short of it", async () => {
    harness = await startHarness("head-report");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer(
      "GET",
      "/events",
      copyIncompleteReplay("20", [
        copyItemEvent("11", "item.created", wireItem({ id: "short" })),
      ]),
      copyReplay("12", [
        copyItemEvent("12", "item.created", wireItem({ id: "complete" })),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const short = await device.catchUp();
    expect(short.ok ? null : short.refusal.code).toBe("stream_incomplete");
    const partial = await device.status();
    expect(partial.ok ? partial.value.event_cursor : null).toBe("11");

    const complete = await device.catchUp();
    expect(complete.ok).toBe(true);
    expect(
      complete.ok ? complete.value.reached_head : undefined,
      "a catch-up that reached the log's head did not say so, so nothing can tell a current copy from a lagging one",
    ).toBe(true);
  });
});

describe("catch-up ends on the replay's marker", () => {
  it("moves the cursor past the rows the stream withheld, and resumes from there", async () => {
    harness = await startHarness("replay-marker");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer(
      "GET",
      "/events",
      // The head is 14 and the device is sent only 11: 12 to 14 are rows its
      // credential may not read, so no frame it is sent reaches the head.
      copyLiveReplay("14", [
        copyItemEvent("11", "item.created", wireItem({ id: "seen" })),
      ]),
      copyLiveReplay("14", []),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok).toBe(true);
    expect(
      caught.ok
        ? [caught.value.applied, caught.value.cursor, caught.value.reached_head]
        : undefined,
      "the catch-up did not end on the marker at its cursor, so a device whose head rows are withheld waits out the silence, reports itself behind, and keeps a cursor that ages out",
    ).toEqual([1, "14", true]);

    await device.catchUp();
    expect(
      lastEventIds(harness),
      "the next catch-up did not resume from the marker's cursor",
    ).toEqual(["(none)", "10", "10", "14"]);
  });

  it("moves a held stream's cursor past the rows it withheld", async () => {
    harness = await startHarness("follow-marker");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer(
      "GET",
      "/events",
      copyLiveReplay("14", [
        copyItemEvent("11", "item.created", wireItem({ id: "seen" })),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const followed = await device.follow(2);
    expect(followed.ok).toBe(true);
    expect(
      followed.ok
        ? [
            followed.value.changes.map((change) => change.cursor),
            followed.value.report.cursor,
          ]
        : undefined,
      "the held stream kept its cursor at the last row it was sent, so a stream opened again replays the withheld rows and a quiet one lets its cursor age out",
    ).toEqual([["11"], "14"]);
    const status = await device.status();
    expect(status.ok && status.value.event_cursor).toBe("14");
  });

  it("expires the copy when a live marker names no position", async () => {
    harness = await startHarness("replay-marker-null");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer("GET", "/events", {
      // A malformed marker cannot certify completion or keep a readable copy.
      kind: "sse",
      hold: true,
      frames: [connected, copyStreamLive(null)],
    });

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok ? null : caught.refusal.code).toBe("copy_expired");
    const status = await device.status();
    expect(status.ok ? status.value.hydration : null).toBe("expired");
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
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent(
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

  it("adds a row entering the slice by retype, with its tags and its edges", async () => {
    harness = await startHarness("entering-by-retype");
    const { server, device } = harness;
    scriptHydration(server, { head: "10", rows: { "core.note": [] } });
    // A row the copy never held, now of a type the slice declares: a retype
    // into the slice. Its frame carries its tags; its edges are its own and
    // no frame carries them.
    const entered = wireItem({ id: "entered", version: 3 });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent("11", "item.updated", entered, { tags: ["kept"] }),
      ]),
    );
    server.copyAnswer(
      "GET",
      "/items/entered",
      answers.updated({
        ...entered,
        edges: {
          references: {
            data: [
              wireEdge({
                id: "its-own",
                source_id: "entered",
                target_id: "elsewhere",
              }),
            ],
            next_cursor: null,
          },
        },
      }),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);

    const held = await device.get("entered");
    expect(held.ok && held.value.tags).toEqual(["kept"]);
    const edges = await device.edgesFrom("entered");
    expect(
      edges.ok ? edges.value.map((edge) => edge.id) : [],
      "a row that came into the slice by retype arrived without the edges it draws, and nothing brings them until a hydration",
    ).toEqual(["its-own"]);
  });

  it("adds a row entering the slice by a move of tier, with its edges", async () => {
    harness = await startHarness("entering-by-tier");
    const { server, device } = harness;
    scriptHydration(server, { head: "10", rows: { "core.note": [] } });
    // A note the copy never held because it was in the feed, now moved to
    // the library the slice holds.
    const moved = wireItem({ id: "moved", tier: "library", version: 2 });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [copyItemEvent("11", "item.updated", moved)]),
    );
    server.copyAnswer(
      "GET",
      "/items/moved",
      answers.updated({
        ...moved,
        edges: {
          references: {
            data: [
              wireEdge({
                id: "its-own",
                source_id: "moved",
                target_id: "elsewhere",
              }),
            ],
            next_cursor: null,
          },
        },
      }),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect((await device.get("moved")).ok).toBe(true);
    const edges = await device.edgesFrom("moved");
    expect(
      edges.ok ? edges.value.map((edge) => edge.id) : [],
      "a row that came into the slice by a move of tier arrived without the edges it draws",
    ).toEqual(["its-own"]);
  });

  it("adds a row entering the slice with every page of its edges", async () => {
    harness = await startHarness("entering-paged-edges");
    const { server, device } = harness;
    scriptHydration(server, { head: "10", rows: { "core.note": [] } });
    const entered = wireItem({ id: "entered", version: 3 });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [copyItemEvent("11", "item.updated", entered)]),
    );
    const edge = (id: string): Record<string, unknown> =>
      wireEdge({ id, source_id: "entered", target_id: "elsewhere" });
    server.copyAnswer(
      "GET",
      "/items/entered",
      answers.updated({
        ...entered,
        edges: {
          references: { data: [edge("first-page")], next_cursor: "page-2" },
        },
      }),
    );
    server.copyAnswer("GET", "/items/entered/edges", {
      kind: "json",
      status: 200,
      body: { data: [edge("second-page")], next_cursor: null },
    });

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    const edges = await device.edgesFrom("entered");
    expect(
      edges.ok ? edges.value.map((edge) => edge.id).sort() : [],
      "a row entering the slice kept only the edges its first page carried",
    ).toEqual(["first-page", "second-page"]);
    const paged = server.requests.find(
      (request) => request.pathname === "/items/entered/edges",
    );
    expect(paged?.query.get("cursor")).toBe("page-2");
    expect(paged?.query.get("edge_type")).toBe("references");
  });

  it("leaves the cursor before a row entering the slice whose edges it could not read", async () => {
    harness = await startHarness("entering-read-fails");
    const { server, device } = harness;
    scriptHydration(server, { head: "10", rows: { "core.note": [] } });
    const entered = wireItem({ id: "entered", version: 3 });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [copyItemEvent("11", "item.updated", entered)]),
    );
    server.copyAnswer(
      "GET",
      "/items/entered",
      refusal(503, "service_unavailable", "busy"),
      answers.updated({
        ...entered,
        edges: {
          references: {
            data: [
              wireEdge({
                id: "its-own",
                source_id: "entered",
                target_id: "elsewhere",
              }),
            ],
            next_cursor: null,
          },
        },
      }),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const failed = await device.catchUp();
    expect(failed.ok, JSON.stringify(failed)).toBe(false);
    const status = await device.status();
    expect(
      status.ok && status.value.event_cursor,
      "the cursor moved past an event whose row went in without its edges",
    ).toBe("10");
    // The witness: the next catch-up takes the event, edges and all.
    const caught = await device.catchUp();
    expect(caught.ok && caught.value.applied, JSON.stringify(caught)).toBe(1);
    const edges = await device.edgesFrom("entered");
    expect(edges.ok ? edges.value.map((edge) => edge.id) : []).toEqual([
      "its-own",
    ]);
  });

  it("keeps a held stream going over a row entering the slice whose edges it could not read at first", async () => {
    harness = await startHarness("entering-read-fails-held");
    const { server, device } = harness;
    scriptHydration(server, { head: "10", rows: { "core.note": [] } });
    const entered = wireItem({ id: "entered", version: 3 });
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      hold: true,
      frames: [
        connected,
        copyStreamCursor("11"),
        copyItemEvent("11", "item.updated", entered),
      ],
    });
    server.copyAnswer(
      "GET",
      "/items/entered",
      refusal(503, "service_unavailable", "busy"),
      answers.updated({ ...entered, edges: {} }),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const follow = device.holdFollow(20);
    try {
      await vi.waitFor(
        () => {
          expect(
            follow.stdout,
            `the entering row was never taken: ${follow.stderr}`,
          ).toContain('"cursor":"11"');
        },
        { timeout: 18_000, interval: 50 },
      );
      expect(
        follow.running(),
        "the follow ended over a read a retry would have answered",
      ).toBe(true);
    } finally {
      await follow.stop();
    }
  });

  it("learns a row retyped out of its slice, asking the stream for every type", async () => {
    harness = await startHarness("retyped-out");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [{ item: { id: "stays" } }, { item: { id: "moves" } }],
      },
    });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent(
          "11",
          "item.updated",
          wireItem({ id: "moves", type: "core.bookmark", version: 2 }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);
    const held = await device.list();
    const ids = held.ok ? held.value.map((item) => item.id) : [];
    expect(ids).toContain("stays");
    expect(ids).not.toContain("moves");
    // What makes the eviction possible against the real server: a stream
    // narrowed to the slice's types withholds the frame of a row that left
    // them, since the server narrows by the type a row has now.
    const opened = server.requests.filter(
      (request) =>
        request.method === "GET" &&
        request.pathname === "/events" &&
        request.headers["last-event-id"] !== undefined,
    );
    expect(opened.length).toBeGreaterThan(0);
    expect(
      opened.map((request) => request.query.get("type")),
      "the catch-up asked for its slice's types alone, so a row retyped out of them is never heard of again",
    ).toEqual(opened.map(() => null));
  });

  it("keeps the edges a held row draws to a row that leaves the slice", async () => {
    harness = await startHarness("eviction-edges");
    const { server, device } = harness;
    const inline = (edge: Record<string, unknown>) => ({
      references: { data: [edge], next_cursor: null },
    });
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "stays",
              edges: inline(
                wireEdge({
                  id: "toward",
                  source_id: "stays",
                  target_id: "leaves",
                }),
              ),
            },
          },
          {
            item: {
              id: "leaves",
              edges: inline(
                wireEdge({
                  id: "away",
                  source_id: "leaves",
                  target_id: "stays",
                }),
              ),
            },
          },
        ],
      },
    });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent(
          "11",
          "item.updated",
          wireItem({ id: "leaves", tier: "feed", version: 2 }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const ids = async (read: Promise<{ ok: boolean; value?: unknown }>) => {
      const outcome = await read;
      expect(outcome.ok).toBe(true);
      return outcome.ok
        ? (outcome.value as { id: string }[]).map((edge) => edge.id)
        : [];
    };
    // The witnesses: hydration held both edges, so what the catch-up leaves
    // is read against a copy that had them.
    expect(await ids(device.edgesFrom("stays"))).toEqual(["toward"]);
    expect(await ids(device.edgesTo("stays"))).toEqual(["away"]);

    expect((await device.catchUp()).ok).toBe(true);

    expect(
      await ids(device.edgesFrom("stays")),
      "the edge a held row draws to the row that left went with it, so a copy's edges differ by whether it arrived by catch-up or by hydration, which keeps an edge whose source it holds",
    ).toEqual(["toward"]);
    expect(
      await ids(device.edgesTo("stays")),
      "the edge drawn from the row that left stayed, so the copy holds an edge from an item outside its slice",
    ).toEqual([]);
  });

  it("applies an edge of a type held whole whatever its source", async () => {
    harness = await startHarness("whole-edge-events");
    const { server, device } = harness;
    const beneath = {
      id: "kept-beneath",
      source_id: "leaves",
      target_id: "below",
      edge_type: "parent-of",
    };
    const drawn = { id: "drawn", source_id: "leaves", target_id: "below" };
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "leaves",
              edges: {
                "parent-of": { data: [wireEdge(beneath)], next_cursor: null },
                references: { data: [wireEdge(drawn)], next_cursor: null },
              },
            },
          },
        ],
      },
      edges: { "parent-of": [beneath] },
    });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("13", [
        edgeEvent(
          "11",
          "edge.created",
          wireEdge({
            id: "between-outsiders",
            source_id: "outer",
            target_id: "inner",
            edge_type: "parent-of",
          }),
        ),
        edgeEvent(
          "12",
          "edge.created",
          wireEdge({ id: "not-whole", source_id: "outer", target_id: "inner" }),
        ),
        copyItemEvent(
          "13",
          "item.updated",
          wireItem({ id: "leaves", tier: "feed", version: 2 }),
        ),
      ]),
    );
    const ids = async (read: Promise<{ ok: boolean; value?: unknown }>) => {
      const outcome = await read;
      expect(outcome.ok).toBe(true);
      return outcome.ok
        ? (outcome.value as { id: string }[]).map((edge) => edge.id).sort()
        : [];
    };

    const hydrated = await device.hydrate(["core.note"], "library", {
      edgeTypes: ["parent-of"],
    });
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    // The witness: before the catch-up the row held both of its edges.
    expect(await ids(device.edgesFrom("leaves"))).toEqual(
      ["drawn", "kept-beneath"].sort(),
    );

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);

    expect(
      await ids(device.edgesFrom("outer")),
      "an edge of a type held whole was dropped for starting outside the slice, so a search for what lies beneath a project the copy does not hold cannot be answered",
    ).toEqual(["between-outsiders"]);
    expect(
      (await device.get("leaves")).ok,
      "the row that left the slice stayed, so the edges below are read against a copy that evicted nothing",
    ).toBe(false);
    expect(
      await ids(device.edgesFrom("leaves")),
      "a row that left the slice took an edge of a type held whole with it, or kept one of a type that is not",
    ).toEqual(["kept-beneath"]);
  });

  it("moves an edge whose source moved within the slice, and drops one whose source moved outside it", async () => {
    harness = await startHarness("moved-edge-events");
    const { server, device } = harness;
    const within = {
      id: "within",
      source_id: "first",
      target_id: "older",
      edge_type: "supersedes",
    };
    const outside = {
      id: "outside",
      source_id: "first",
      target_id: "oldest",
      edge_type: "in-thread",
    };
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "first",
              edges: {
                supersedes: { data: [wireEdge(within)], next_cursor: null },
                "in-thread": { data: [wireEdge(outside)], next_cursor: null },
              },
            },
          },
          { item: { id: "second" } },
        ],
      },
    });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("12", [
        edgeEvent(
          "11",
          "edge.updated",
          wireEdge({ ...within, source_id: "second", version: 2 }),
        ),
        edgeEvent(
          "12",
          "edge.updated",
          wireEdge({ ...outside, source_id: "outer", version: 2 }),
        ),
      ]),
    );
    const ids = async (read: Promise<{ ok: boolean; value?: unknown }>) => {
      const outcome = await read;
      expect(outcome.ok).toBe(true);
      return outcome.ok
        ? (outcome.value as { id: string }[]).map((edge) => edge.id).sort()
        : [];
    };

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    // The witness: before the catch-up the first row held both edges.
    expect(await ids(device.edgesFrom("first"))).toEqual(["outside", "within"]);

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);

    expect(
      await ids(device.edgesFrom("second")),
      "an edge moved to a source the copy holds was not moved there",
    ).toEqual(["within"]);
    expect(
      await ids(device.edgesFrom("first")),
      "an edge moved to a source outside the slice stayed at the source it left",
    ).toEqual([]);
  });

  it("keeps an edge whose source moved outside the slice while a move of its own waits", async () => {
    harness = await startHarness("moved-edge-waiting");
    const { server, device } = harness;
    const moving = {
      id: "moving",
      source_id: "first",
      target_id: "older",
      edge_type: "supersedes",
    };
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "first",
              edges: {
                supersedes: { data: [wireEdge(moving)], next_cursor: null },
              },
            },
          },
          { item: { id: "second" } },
        ],
      },
    });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        edgeEvent(
          "11",
          "edge.updated",
          wireEdge({ ...moving, source_id: "outer", version: 2 }),
        ),
      ]),
    );
    const ids = async (read: Promise<{ ok: boolean; value?: unknown }>) => {
      const outcome = await read;
      expect(outcome.ok).toBe(true);
      return outcome.ok
        ? (outcome.value as { id: string }[]).map((edge) => edge.id).sort()
        : [];
    };

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const queued = await device.updateEdge("moving", {
      properties: {},
      version: 1,
      source_id: "second",
    });
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    // The witness: the move is laid over the copy before the catch-up.
    expect(await ids(device.edgesFrom("second"))).toEqual(["moving"]);

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect(
      await ids(device.edgesFrom("second")),
      "an edge whose move still waits was dropped for a source the copy does not hold",
    ).toEqual(["moving"]);
  });

  it("lays its own waiting move of an edge's target over the server's change to the edge", async () => {
    harness = await startHarness("moved-edge-waiting-target");
    const { server, device } = harness;
    const moving = {
      id: "moving",
      source_id: "first",
      target_id: "older",
      edge_type: "supersedes",
    };
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "first",
              edges: {
                supersedes: { data: [wireEdge(moving)], next_cursor: null },
              },
            },
          },
          { item: { id: "second" } },
        ],
      },
    });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        edgeEvent(
          "11",
          "edge.updated",
          wireEdge({
            ...moving,
            properties: { note: "elsewhere" },
            version: 2,
          }),
        ),
      ]),
    );
    const edgeTargets = async (
      read: Promise<{ ok: boolean; value?: unknown }>,
    ) => {
      const outcome = await read;
      expect(outcome.ok).toBe(true);
      return outcome.ok
        ? (outcome.value as { target_id: string }[]).map(
            (edge) => edge.target_id,
          )
        : [];
    };

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const queued = await device.updateEdge("moving", {
      properties: {},
      version: 1,
      target_id: "oldest",
    });
    expect(queued.ok, JSON.stringify(queued)).toBe(true);
    // The witness: the move is laid over the copy before the catch-up.
    expect(await edgeTargets(device.edgesFrom("first"))).toEqual(["oldest"]);

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect(
      await edgeTargets(device.edgesFrom("first")),
      "the target this device moved the edge to was not laid over the server's edge",
    ).toEqual(["oldest"]);
  });

  it("keeps a pinned row outside the slice current", async () => {
    harness = await startHarness("pinned-outside");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
    });
    const settings = (version: number, title: string) =>
      wireItem({
        id: "settings",
        type: "core.bookmark",
        version,
        properties: { title },
      });
    server.copyAnswer(
      "GET",
      "/items/settings",
      answers.updated(settings(1, "pinned")),
      answers.updated(settings(3, "read again")),
    );
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("12", [
        copyItemEvent("11", "item.updated", settings(2, "changed")),
        copyItemEvent(
          "12",
          "item.updated",
          wireItem({ id: "stranger", type: "core.bookmark", version: 2 }),
        ),
      ]),
      copyHeadRead("12"),
    );
    const title = async (): Promise<unknown> => {
      const held = await device.get("settings");
      return held.ok ? held.value.properties.title : "not held";
    };

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    // The witness: the slice does not take the row.
    expect(await title()).toBe("not held");

    const pinned = await device.pin("settings");
    expect(pinned.ok, JSON.stringify(pinned)).toBe(true);
    expect(await title(), "a pin did not read the row it names").toBe("pinned");

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect(
      await title(),
      "a catch-up left a pinned row outside the slice as it was pinned, so a folder's settings go stale",
    ).toBe("changed");
    expect(
      (await device.get("stranger")).ok,
      "a row outside the slice that nobody pinned was added, so the copy holds whatever the stream carries",
    ).toBe(false);

    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(
      await title(),
      "a hydration dropped the pinned row, or kept it without reading it again",
    ).toBe("read again");
    const status = await device.status();
    expect(status.ok && status.value.pinned).toEqual(["settings"]);
  });

  it("keeps a pinned row that leaves the slice", async () => {
    harness = await startHarness("pinned-leaves");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [{ item: { id: "bound" } }, { item: { id: "free" } }],
      },
    });
    server.copyAnswer(
      "GET",
      "/items/bound",
      answers.updated(wireItem({ id: "bound" })),
    );
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("12", [
        copyItemEvent(
          "11",
          "item.updated",
          wireItem({ id: "bound", tier: "feed", version: 2 }),
        ),
        copyItemEvent(
          "12",
          "item.updated",
          wireItem({ id: "free", tier: "feed", version: 2 }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const pinned = await device.pin("bound");
    expect(pinned.ok, JSON.stringify(pinned)).toBe(true);
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);

    // The witness: a row that nobody pinned leaves as it always has.
    expect((await device.get("free")).ok).toBe(false);
    const bound = await device.get("bound");
    expect(
      bound.ok ? [bound.value.tier, bound.value.version] : "not held",
      "a pinned row was evicted for leaving the slice, so a file bound to it loses its item",
    ).toEqual(["feed", 2]);
  });

  it("lets an unpinned row outside the slice go", async () => {
    harness = await startHarness("unpinned");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "stays" } }] },
    });
    const settings = (version: number) =>
      wireItem({ id: "settings", type: "core.bookmark", version });
    server.copyAnswer("GET", "/items/settings", answers.updated(settings(1)));
    server.copyAnswer(
      "GET",
      "/items/stays",
      answers.updated(wireItem({ id: "stays" })),
    );
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [copyItemEvent("11", "item.updated", settings(2))]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.pin("settings")).ok).toBe(true);
    expect((await device.pin("stays")).ok).toBe(true);
    // The witness: the pin held the row.
    expect((await device.get("settings")).ok).toBe(true);

    expect((await device.unpin("settings")).ok).toBe(true);
    expect((await device.unpin("stays")).ok).toBe(true);
    expect(
      (await device.get("settings")).ok,
      "a row outside the slice stayed after its pin was taken off, so nothing a caller does lets it go",
    ).toBe(false);
    expect(
      (await device.get("stays")).ok,
      "unpinning a row the slice holds took it away",
    ).toBe(true);
    const status = await device.status();
    expect(status.ok && status.value.pinned).toEqual([]);

    expect((await device.catchUp()).ok).toBe(true);
    expect(
      (await device.get("settings")).ok,
      "an event brought back a row outside the slice whose pin was taken off",
    ).toBe(false);
  });

  it("takes the pin off a purged row", async () => {
    harness = await startHarness("pinned-purged");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
    });
    const settings = wireItem({ id: "settings", type: "core.bookmark" });
    server.copyAnswer("GET", "/items/settings", answers.updated(settings));
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [copyItemEvent("11", "item.purged", settings)]),
    );
    const pinned = async () => {
      const status = await device.status();
      expect(status.ok, JSON.stringify(status)).toBe(true);
      return status.ok ? status.value.pinned : [];
    };
    const reads = () =>
      server.requests.filter(
        (request) => request.pathname === "/items/settings",
      ).length;

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.pin("settings")).ok).toBe(true);
    // The witness: the pin is listed, and was read, before the purge.
    expect(await pinned()).toEqual(["settings"]);
    expect(reads()).toBe(1);

    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect((await device.get("settings")).ok).toBe(false);
    expect(
      await pinned(),
      "a purged row stayed pinned, so the report lists a row nothing holds",
    ).toEqual([]);
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect(
      reads(),
      "a hydration asked the server for a row it purged, because its pin outlived it",
    ).toBe(1);
  });

  it("refuses to pin a row the server does not hold", async () => {
    harness = await startHarness("pin-absent");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
    });
    server.copyAnswer(
      "GET",
      "/items/held",
      answers.updated(wireItem({ id: "held", type: "core.bookmark" })),
    );
    server.copyAnswer(
      "GET",
      "/items/absent",
      refusal(404, "not_found", "no item absent"),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    // The witness: an id the server holds is pinned.
    const held = await device.pin("held");
    expect(held.ok, JSON.stringify(held)).toBe(true);

    const absent = await device.pin("absent");
    expect(
      absent.ok,
      "a pin on an id the server does not hold was taken, so the copy promises a row it cannot keep",
    ).toBe(false);
    if (!absent.ok) expect(absent.refusal.code).toBe("not_found");
    const status = await device.status();
    expect(
      status.ok && status.value.pinned,
      "a refused pin was left in the store, so every hydration asks for a row the server does not hold",
    ).toEqual(["held"]);
  });

  it("reads a row pinned already again, and says it was", async () => {
    harness = await startHarness("pinned-twice");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
    });
    const settings = (version: number, title: string) =>
      wireItem({
        id: "settings",
        type: "core.bookmark",
        version,
        properties: { title },
      });
    server.copyAnswer(
      "GET",
      "/items/settings",
      answers.updated(settings(1, "first")),
      answers.updated(settings(2, "second")),
    );
    const title = async (): Promise<unknown> => {
      const held = await device.get("settings");
      return held.ok ? held.value.properties.title : "not held";
    };

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const first = await device.pin("settings");
    // The witness: a first pin says the row was not pinned before.
    expect(first.ok && first.value.was_pinned, JSON.stringify(first)).toBe(
      false,
    );
    expect(await title()).toBe("first");

    const second = await device.pin("settings");
    expect(
      second.ok && second.value.was_pinned,
      "pinning a row pinned already did not say so",
    ).toBe(true);
    expect(
      await title(),
      "pinning a row pinned already did not read it again",
    ).toBe("second");
    const status = await device.status();
    expect(status.ok && status.value.pinned).toEqual(["settings"]);
  });

  it("keeps a pin across the hydration that follows an aged-out cursor", async () => {
    harness = await startHarness("pinned-aged-out");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
    });
    const settings = (version: number, title: string) =>
      wireItem({
        id: "settings",
        type: "core.bookmark",
        version,
        properties: { title },
      });
    server.copyAnswer(
      "GET",
      "/items/settings",
      answers.updated(settings(1, "pinned")),
      answers.updated(settings(2, "read again")),
    );
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      frames: [connected, copyStreamCursor("900"), catchupTooOld("500", "10")],
    });
    const title = async (): Promise<unknown> => {
      const held = await device.get("settings");
      return held.ok ? held.value.properties.title : "not held";
    };

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.pin("settings")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(false);
    // The witness: the cursor aged out with the pin in place.
    const expired = await device.status();
    expect(
      expired.ok && [expired.value.hydration, expired.value.pinned],
    ).toEqual(["expired", ["settings"]]);

    server.copyAnswer("GET", "/events", copyHeadRead("900"));
    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    const status = await device.status();
    expect(
      status.ok && status.value.pinned,
      "the hydration that follows an aged-out cursor dropped the pins, so a folder loses the rows its files are bound to",
    ).toEqual(["settings"]);
    expect(
      await title(),
      "the hydration that follows an aged-out cursor did not read the pinned row again",
    ).toBe("read again");
  });

  it("keeps a pin the key can no longer read, and completes the hydration", async () => {
    harness = await startHarness("pinned-unreadable");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
    });
    server.copyAnswer(
      "GET",
      "/items/settings",
      answers.updated(wireItem({ id: "settings", type: "core.bookmark" })),
      answers.itemNotFound("settings"),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.pin("settings")).ok).toBe(true);
    // The witness: the pin held the row while the key could read it.
    expect((await device.get("settings")).ok).toBe(true);

    const again = await device.hydrate(["core.note"], "library");
    expect(
      again.ok,
      `a pinned row the key can no longer read failed the hydration, so the copy refuses every read until the pin is taken off: ${JSON.stringify(again)}`,
    ).toBe(true);
    const status = await device.status();
    expect(status.ok && [status.value.hydration, status.value.pinned]).toEqual([
      "complete",
      ["settings"],
    ]);
    expect(
      (await device.get("settings")).ok,
      "the copy kept a row the key can no longer read",
    ).toBe(false);
    expect((await device.get("note")).ok).toBe(true);
  });

  it("pins a row of its own create the server does not hold yet, and moves the pin to the id the create is answered with", async () => {
    harness = await startHarness("pinned-own-create");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await device.create({
      type: "core.note",
      properties: { title: "mine", body: "mine" },
      source: "notes",
      sourceId: "mine.md",
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const local = created.value.item_id ?? "";
    server.copyAnswer(
      "GET",
      `/items/${local}`,
      refusal(404, "not_found", "no such item"),
    );

    const pinned = await device.pin(local);
    expect(
      pinned.ok,
      `a pin of a row the copy holds and the server does not hold yet was refused, so a folder cannot pin its own new file: ${JSON.stringify(pinned)}`,
    ).toBe(true);
    const before = await device.status();
    expect(before.ok && before.value.pinned).toEqual([local]);

    const answered = "01a00000-0000-7000-8000-0000000000e1";
    scriptWrites(server, {
      read: [
        answers.updated(
          wireItem({
            id: answered,
            properties: { title: "mine", body: "mine" },
            source: "notes",
            source_id: "mine.md",
          }),
        ),
      ],
      create: [
        answers.created(
          wireItem({
            id: answered,
            properties: { title: "mine", body: "mine" },
            source: "notes",
            source_id: "mine.md",
          }),
        ),
      ],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    const after = await device.status();
    expect(
      after.ok && after.value.pinned,
      "the pin stayed on the id minted here, which names nothing once the create is answered",
    ).toEqual([answered]);
    expect((await device.get(answered)).ok).toBe(true);
  });

  it("takes the pin off a row whose create was refused", async () => {
    harness = await startHarness("pinned-create-refused");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await device.create({
      type: "core.note",
      properties: { title: "refused", body: "refused" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const local = created.value.item_id ?? "";
    server.copyAnswer(
      "GET",
      `/items/${local}`,
      refusal(404, "not_found", "no such item"),
    );
    expect((await device.pin(local)).ok).toBe(true);
    // The witness: the pin is listed before the refusal.
    const before = await device.status();
    expect(before.ok && before.value.pinned).toEqual([local]);

    scriptWrites(server, {
      create: [refusal(400, "invalid_properties", "not a note")],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    expect((await device.get(local)).ok).toBe(false);
    const after = await device.status();
    expect(
      after.ok && after.value.pinned,
      "a refused create left its pin, so the report lists a row that exists nowhere and every hydration asks the server for it",
    ).toEqual([]);
  });

  it("keeps the pin until a fresh read confirms absence after a create refusal", async () => {
    harness = await startHarness("pinned-create-refused-unread");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const created = await device.create({
      type: "core.note",
      properties: { title: "refused", body: "refused" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const local = created.value.item_id ?? "";
    // The pin's read, then the read back after the refusal.
    server.copyAnswer(
      "GET",
      `/items/${local}`,
      refusal(404, "not_found", "no such item"),
      refusal(503, "service_unavailable", "later"),
      refusal(404, "not_found", "no such item"),
    );
    expect((await device.pin(local)).ok).toBe(true);
    const before = await device.status();
    expect(before.ok && before.value.pinned).toEqual([local]);

    scriptWrites(server, {
      create: [refusal(400, "invalid_properties", "not a note")],
    });
    const drained = await device.drain();
    expect(drained.ok, JSON.stringify(drained)).toBe(true);
    // The witness: the read back was asked, and failed.
    expect(
      server.requests.filter(
        (request) =>
          request.method === "GET" && request.pathname === `/items/${local}`,
      ).length,
    ).toBe(2);
    const after = await device.status();
    expect(
      after.ok && after.value.pinned,
      "a failed read cannot certify absence or remove a pin",
    ).toEqual([local]);
    expect((await device.drain()).ok).toBe(true);
    const reconciled = await device.status();
    expect(reconciled.ok && reconciled.value.pinned).toEqual([]);
    expect(
      server.requests.filter(
        (request) => request.method === "POST" && request.pathname === "/items",
      ),
    ).toHaveLength(1);
  });

  it("lays a waiting write over a row it pins", async () => {
    harness = await startHarness("pinned-waiting");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          { item: { id: "n1", version: 1, properties: { title: "server" } } },
        ],
      },
    });
    server.copyAnswer(
      "GET",
      "/items/n1",
      answers.updated(
        wireItem({ id: "n1", version: 2, properties: { title: "elsewhere" } }),
      ),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect(
      (await device.update("n1", { properties: { title: "mine" }, version: 1 }))
        .ok,
    ).toBe(true);

    expect((await device.pin("n1")).ok).toBe(true);
    const held = await device.get("n1");
    // The witness: the pin read the server's row, at its later version.
    expect(held.ok && held.value.version).toBe(2);
    expect(
      held.ok && held.value.properties.title,
      "a pin put the server's row over a write still waiting, so the copy reads as if the write were undone",
    ).toBe("mine");
  });

  it("says whether a row it unpins was pinned", async () => {
    harness = await startHarness("unpin-says");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
    });
    server.copyAnswer(
      "GET",
      "/items/note",
      answers.updated(wireItem({ id: "note" })),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const never = await device.unpin("note");
    expect(never.ok, JSON.stringify(never)).toBe(true);
    expect(
      never.ok && [never.value.pinned, never.value.was_pinned],
      "an unpin of a row that was never pinned said it was",
    ).toEqual([false, false]);

    expect((await device.pin("note")).ok).toBe(true);
    const once = await device.unpin("note");
    // The witness: the same call on a pinned row says so.
    expect(once.ok && [once.value.pinned, once.value.was_pinned]).toEqual([
      false,
      true,
    ]);
  });

  it("keeps the edges of a type held whole when it unpins a row", async () => {
    harness = await startHarness("unpin-whole-edges");
    const { server, device } = harness;
    const beneath = {
      id: "kept-beneath",
      source_id: "settings",
      target_id: "below",
      edge_type: "parent-of",
    };
    const drawn = { id: "drawn", source_id: "settings", target_id: "below" };
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
      edges: { "parent-of": [beneath] },
    });
    server.copyAnswer(
      "GET",
      "/items/settings",
      answers.updated(
        wireItem({
          id: "settings",
          type: "core.bookmark",
          edges: {
            "parent-of": { data: [wireEdge(beneath)], next_cursor: null },
            references: { data: [wireEdge(drawn)], next_cursor: null },
          },
        }),
      ),
    );
    const ids = async () => {
      const edges = await device.edgesFrom("settings");
      expect(edges.ok).toBe(true);
      return edges.ok ? edges.value.map((edge) => edge.id).sort() : [];
    };

    const hydrated = await device.hydrate(["core.note"], "library", {
      edgeTypes: ["parent-of"],
    });
    expect(hydrated.ok, JSON.stringify(hydrated)).toBe(true);
    expect((await device.pin("settings")).ok).toBe(true);
    // The witness: the pin held both edges the row draws.
    expect(await ids()).toEqual(["drawn", "kept-beneath"]);

    expect((await device.unpin("settings")).ok).toBe(true);
    expect((await device.get("settings")).ok).toBe(false);
    expect(
      await ids(),
      "an unpin took an edge of a type held whole with the row, or kept one of a type that is not",
    ).toEqual(["kept-beneath"]);
  });

  it("keeps a row it unpins while a write to it still waits, and lets it go once answered", async () => {
    harness = await startHarness("unpin-waiting");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "bound", version: 1 } }] },
    });
    server.copyAnswer(
      "GET",
      "/items/bound",
      answers.updated(wireItem({ id: "bound", version: 1 })),
      answers.updated(
        wireItem({ id: "bound", version: 2, type: "core.bookmark" }),
      ),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.pin("bound")).ok).toBe(true);
    expect(
      (
        await device.update("bound", {
          properties: {},
          version: 1,
          type: "core.bookmark",
        })
      ).ok,
    ).toBe(true);

    const unpinned = await device.unpin("bound");
    expect(unpinned.ok && unpinned.value.was_pinned).toBe(true);
    const held = await device.get("bound");
    expect(
      held.ok && held.value.type,
      "an unpin evicted a row by the move still waiting on it, before the server answered it",
    ).toBe("core.bookmark");

    scriptWrites(server, {
      update: [
        answers.updated(
          wireItem({ id: "bound", version: 2, type: "core.bookmark" }),
        ),
      ],
    });
    expect((await device.drain()).ok).toBe(true);
    expect(
      (await device.get("bound")).ok,
      "the row stayed after the move out of the slice was answered, with nothing holding it",
    ).toBe(false);
  });

  it("hydrates again with other edge types held whole, and applies no event of one it no longer holds", async () => {
    harness = await startHarness("rehydrate-edge-types");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "note" } }] },
      edges: {
        "parent-of": [{ id: "old", source_id: "outer", target_id: "inner" }],
        supersedes: [],
      },
    });
    server.copyAnswer(
      "GET",
      "/events",
      copyHeadRead("10"),
      copyReplay("10", []),
      copyReplay("12", [
        edgeEvent(
          "11",
          "edge.created",
          wireEdge({
            id: "no-longer-whole",
            source_id: "outer",
            target_id: "inner",
            edge_type: "parent-of",
          }),
        ),
        edgeEvent(
          "12",
          "edge.created",
          wireEdge({
            id: "now-whole",
            source_id: "outer",
            target_id: "inner",
            edge_type: "supersedes",
          }),
        ),
      ]),
    );
    const ids = async () => {
      const edges = await device.edgesFrom("outer");
      expect(edges.ok).toBe(true);
      return edges.ok ? edges.value.map((edge) => edge.id).sort() : [];
    };

    expect(
      (
        await device.hydrate(["core.note"], "library", {
          edgeTypes: ["parent-of"],
        })
      ).ok,
    ).toBe(true);
    // The witness: the first hydration held the edge type it named.
    expect(await ids()).toEqual(["old"]);

    const again = await device.hydrate(["core.note"], "library", {
      edgeTypes: ["supersedes"],
    });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    const status = await device.status();
    expect(
      status.ok && status.value.slice_edge_types,
      "the report names the edge types an earlier hydration held, not this one's",
    ).toEqual(["supersedes"]);
    expect(await ids()).toEqual([]);

    expect((await device.catchUp()).ok).toBe(true);
    expect(
      await ids(),
      "an edge event of a type only an earlier hydration held whole was applied, or one of a type this one holds was not",
    ).toEqual(["now-whole"]);
  });

  it("drops the edges at both ends of a purged row", async () => {
    harness = await startHarness("purge-edges");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "stays",
              edges: {
                references: {
                  data: [
                    wireEdge({
                      id: "toward",
                      source_id: "stays",
                      target_id: "purged",
                    }),
                  ],
                  next_cursor: null,
                },
              },
            },
          },
          {
            item: {
              id: "purged",
              edges: {
                references: {
                  data: [
                    wireEdge({
                      id: "away",
                      source_id: "purged",
                      target_id: "stays",
                    }),
                  ],
                  next_cursor: null,
                },
              },
            },
          },
        ],
      },
    });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent("11", "item.purged", wireItem({ id: "purged" })),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const before = await device.edgesFrom("stays");
    expect(
      before.ok ? before.value.map((edge) => edge.id) : [],
      "hydration did not hold the edge, so its absence below proves nothing",
    ).toEqual(["toward"]);
    const drawnBefore = await device.edgesTo("stays");
    expect(
      drawnBefore.ok ? drawnBefore.value.map((edge) => edge.id) : [],
      "hydration did not hold the purged row's own edge, so its absence below proves nothing",
    ).toEqual(["away"]);

    expect((await device.catchUp()).ok).toBe(true);

    const after = await device.edgesFrom("stays");
    expect(after.ok).toBe(true);
    expect(
      after.ok ? after.value.map((edge) => edge.id) : undefined,
      "an edge to a purged row stayed, so the copy points at an item that exists nowhere",
    ).toEqual([]);
    const drawn = await device.edgesTo("stays");
    expect(
      drawn.ok ? drawn.value.map((edge) => edge.id) : undefined,
      "an edge from a purged row stayed, so the copy holds an edge from an item that exists nowhere",
    ).toEqual([]);
  });

  it("does not add a row that was never in the slice", async () => {
    harness = await startHarness("no-add");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("12", [
        copyItemEvent("11", "item.created", wireItem({ id: "declared" })),
        copyItemEvent(
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
    server.copyAnswer(
      "GET",
      "/events",
      copyHeadRead("10"),
      copyReplay("10", []),
    );
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    server.copyAnswer(
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
    scriptKey(server);
    server.copyAnswer("GET", "/items", itemsPage([]));
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent(
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
    server.copyAnswer(
      "GET",
      "/events",
      copyHeadRead("10"),
      copyReplay("10", []),
    );
    server.copyAnswer("GET", "/edge-types", edgeTypeCatalog());
    // The hydration, internal replay and catch-up's first read know neither type; the
    // one registered after the catch-up began is there from the next read,
    // and the other is never described.
    server.copyAnswer(
      "GET",
      "/types",
      typeCatalog(),
      typeCatalog(),
      typeCatalog(),
      {
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
      },
    );
    scriptKey(server);
    server.copyAnswer("GET", "/items", itemsPage([]));
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay("14", [
        copyItemEvent(
          "11",
          "item.created",
          wireItem({ id: "late", type: "acme.late-note" }),
        ),
        ...["12", "13", "14"].map((id) =>
          copyItemEvent(
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
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay(
        "13",
        ids.map((id) =>
          copyItemEvent(
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
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      frames: [connected, copyStreamCursor("900"), catchupTooOld("500", "10")],
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
      ).toBe("copy_expired");
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
    server.copyAnswer("GET", "/events", copyHeadRead("900"));
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
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      frames: [connected, copyStreamCursor("900"), catchupTooOld("500", "10")],
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
    server.copyAnswer("GET", "/events", copyHeadRead("900"));
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const recovered = await device.list();
    expect(
      recovered.ok,
      `a hydration did not clear the refusal, so an aged-out cursor bricks the store: ${JSON.stringify(recovered)}`,
    ).toBe(true);
  });
});

/**
 * A server restored from a backup holds a log that ends behind the copy's
 * cursor, and another instance started at the same address holds another
 * log altogether. Either way the copy holds rows the server does not, and
 * misses rows it does; a catch-up that answered "reached the head" would
 * leave it reporting itself current for good.
 */
describe("a server that is not the one the copy followed", () => {
  const OTHER_INSTANCE = "00000000-0000-7000-8000-0000000000ff";

  async function queued(h: Harness): Promise<string> {
    const created = await h.device.create({
      type: "core.note",
      properties: { title: "waiting", body: "waiting" },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable: the assertion above threw");
    h.server.copyAnswer(
      "GET",
      `/items/${created.value.item_id}`,
      refusal(404, "item_not_found", "The queued create has not been sent."),
    );
    return created.value.id;
  }

  async function expectExpired(
    h: Harness,
    ended: { ok: boolean; refusal?: { code: string; raw: string } },
    named: string[],
    waiting: string,
  ): Promise<void> {
    expect(
      ended.ok,
      "a server that does not continue the copy's log was answered as a clean pass, so the copy reports itself current while it misses what the server holds",
    ).toBe(false);
    if (!ended.ok) {
      expect(ended.refusal?.code).toBe("copy_expired");
      for (const word of named) expect(ended.refusal?.raw).toContain(word);
    }
    const status = await h.device.status();
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (status.ok) {
      expect(
        status.value.hydration,
        "the copy did not say it is owed a hydration",
      ).toBe("expired");
      expect(status.value.event_cursor ?? null).toBeNull();
      // The witness that `expired` is this copy's and not an empty store's.
      expect(status.value.slice_types).toContain("core.note");
    }
    const queue = await h.device.queue();
    expect(
      queue.ok ? queue.value.map((row) => row.id) : queue,
      "the queue went with the copy, so a write the caller was told was queued is gone",
    ).toContain(waiting);
  }

  it("hydrates again when the server's log ends behind its cursor, keeping the queue", async () => {
    harness = await startHarness("restored-behind");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "first" } }] },
    });
    // What the real server answers a cursor past its head: the head it
    // holds, then the terminal frame.
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      frames: [connected, copyStreamCursor("7"), cursorAhead("10", "7")],
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const waiting = await queued(harness);

    await expectExpired(harness, await device.catchUp(), ["7", "10"], waiting);

    server.copyAnswer("GET", "/events", copyHeadRead("7"));
    const again = await device.hydrate(["core.note"], "library");
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.ok ? again.value.cursor : undefined).toBe("7");
    const queue = await device.queue();
    expect(queue.ok ? queue.value.map((row) => row.id) : queue).toContain(
      waiting,
    );
  });

  it("hydrates again when the server says its cursor is ahead of the log", async () => {
    harness = await startHarness("cursor-ahead");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "first" } }] },
    });
    // A head read that outran its budget names no position, so the
    // terminal frame is the only word the copy has.
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      frames: [connected, cursorAhead("10", "7")],
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const waiting = await queued(harness);
    await expectExpired(harness, await device.catchUp(), ["7"], waiting);
  });

  it("ends a follow whose server's log ends behind its cursor, and forgets the cursor", async () => {
    harness = await startHarness("follow-restored");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.copyAnswer("GET", "/events", {
      kind: "sse",
      frames: [connected, copyStreamCursor("7"), cursorAhead("10", "7")],
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const waiting = await queued(harness);
    const before = server.requests.filter(
      (request) => request.pathname === "/events",
    ).length;
    const started = Date.now();
    const ended = await device.follow(30);
    expect(
      Date.now() - started,
      "the follow stayed open over a log behind its cursor and ended only when its time ran out",
    ).toBeLessThan(10_000);
    expect(
      server.requests.filter((request) => request.pathname === "/events")
        .length - before,
      "the follow asked again from a cursor the server's log does not hold",
    ).toBe(1);
    await expectExpired(harness, ended, ["7"], waiting);
  });

  it("hydrates again when another instance answers at the same address", async () => {
    harness = await startHarness("other-instance");
    const { server, device } = harness;
    let instance = SCRIPTED_INSTANCE;
    const replayFromInstance = (head: string): Answer => {
      const answer = copyReplay(head, []);
      if (answer.kind !== "sse") throw new Error("a replay must be a stream");
      return {
        ...answer,
        frames: answer.frames.map((frame) => ({
          ...frame,
          data:
            typeof frame.data === "object" &&
            frame.data !== null &&
            "instance_id" in frame.data
              ? { ...frame.data, instance_id: instance }
              : frame.data,
        })),
      };
    };
    server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "first" } }] },
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    // The witness: the instance the copy hydrated from catches up.
    server.copyAnswer("GET", "/events", () => replayFromInstance("10"));
    const caught = await device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);

    // A fresh instance at the same address, whose log has run past the
    // copy's cursor; the copy marker identifies the new instance.
    instance = OTHER_INSTANCE;
    server.copyAnswer("GET", "/events", () => replayFromInstance("40"));
    const waiting = await queued(harness);
    await expectExpired(
      harness,
      await device.catchUp(),
      ["read_view_invalid"],
      waiting,
    );

    // A follow meets another instance and ends as the catch-up did.
    server.copyAnswer("GET", "/events", () => replayFromInstance("40"));
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    instance = SCRIPTED_INSTANCE;
    const followed = await device.follow(30);
    await expectExpired(
      harness,
      followed,
      [OTHER_INSTANCE, SCRIPTED_INSTANCE],
      waiting,
    );
  });
});
