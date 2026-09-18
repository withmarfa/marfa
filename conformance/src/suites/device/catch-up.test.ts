import { describe, it, expect, afterEach } from "vitest";
import { startHarness, scriptHydration, type Harness } from "./harness.js";
import { notWrittenYet, skipIfPending } from "./pending.js";
import {
  catchupTooOld,
  connected,
  headRead,
  itemEvent,
  itemsPage,
  replay,
  streamCursor,
  typeCatalog,
  wireItem,
  wireType,
} from "../../device/marfa-answers.js";

/**
 * "Events apply in log order, gated by version", and "a stale cursor means
 * re-import, not reconnect".
 *
 * Catch-up is the only thing between a copy and the truth once the snapshot
 * is taken, and every failure here is silent. A cursor that moves too far
 * skips rows nothing will fetch again; a cursor that does not move replays
 * for ever; an aged-out cursor answered by reconnecting leaves a copy missing
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

  it("skips an event older than the row it holds and still advances the cursor", async (context) => {
    skipIfPending(context);
    notWrittenYet("an event older than the row the copy holds");
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
        body: [
          wireType("core.note"),
          wireType("core.file"),
          wireType("acme.field-note", { parent: "core.note" }),
        ],
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
});
