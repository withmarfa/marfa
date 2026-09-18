import { describe, it, expect, afterEach } from "vitest";
import { startHarness, scriptHydration, type Harness } from "./harness.js";
import {
  headRead,
  itemEvent,
  itemsPage,
  refusal,
  replay,
  typeCatalog,
  wireItem,
} from "../../device/marfa-answers.js";

/**
 * "Hydration subscribes first, then reads."
 *
 * The ordering is the whole rule. A device that reads the rows and then asks
 * where the log has reached names a resume point past every write that landed
 * during the read, and those writes are then in neither the snapshot nor the
 * replay. Nothing reports them missing: the copy is simply wrong, by exactly
 * the writes somebody made while it was being built.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("what a hydration declares", () => {
  it("refuses an empty type list and a bare wildcard before reading anything", async () => {
    harness = await startHarness("declare");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });

    for (const types of [[], ["*"]]) {
      const refused = await device.hydrate(types, "library");
      expect(
        refused.ok,
        `hydrating ${JSON.stringify(types)} was accepted, so a device can ask for everything or for nothing and get a copy whose contents nobody declared`,
      ).toBe(false);
    }
    expect(
      server.requests.map((request) => request.pathname),
      "the device went to the server before deciding it had nothing to ask for, so a refusal costs a round trip and a log line on every one",
    ).toEqual([]);

    // The control. The same device with a real type list has to hydrate, or
    // the refusals above are a device that cannot hydrate at all.
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  });

  it("refuses a type name outside the grammar", async () => {
    harness = await startHarness("grammar");
    const { server, device } = harness;
    server.answer("GET", "/events", headRead("10"));
    server.answer("GET", "/types", typeCatalog());
    server.answer("GET", "/items", (request) =>
      request.query.get("type") === "bookmark"
        ? refusal(
            400,
            "invalid_type",
            "Type identifier must have at least two segments",
          )
        : itemsPage([{ item: wireItem({ id: "n1" }) }]),
    );

    const refused = await device.hydrate(["bookmark"], "library");
    expect(
      refused.ok,
      "a name that is not a type identifier hydrated, so the device holds a slice of a type that cannot exist and reports it as complete",
    ).toBe(false);

    // The control, on the same server: a well-formed name hydrates, so the
    // refusal above is about the name rather than about the door.
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
  });
});

describe("the order a hydration reads in", () => {
  it("takes the cursor before the snapshot, so a write during the snapshot replays", async () => {
    harness = await startHarness("ordering");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "already-there" } }] },
    });
    // The whole sequence is scripted before the device runs: answers for a
    // door are consumed in order, so a second subscription is the replay the
    // catch-up below makes, carrying a write that landed at id 11 while the
    // snapshot at cursor 10 was being read.
    server.answer(
      "GET",
      "/events",
      replay("11", [
        itemEvent(
          "11",
          "item.created",
          wireItem({ id: "written-during-the-snapshot" }),
        ),
      ]),
    );

    const hydrated = await device.hydrate(["core.note"], "library");
    expect(hydrated.ok).toBe(true);

    const doors = server.requests.map((request) => request.pathname);
    const cursorRead = doors.indexOf("/events");
    const firstRow = doors.indexOf("/items");
    expect(
      cursorRead,
      "the device never asked where the log had reached",
    ).toBeGreaterThanOrEqual(0);
    expect(
      cursorRead,
      "the snapshot was taken before the cursor, so every write that lands while the snapshot is being read falls between the two and reaches the copy through neither",
    ).toBeLessThan(firstRow);

    // And the consequence, rather than only the ordering: a write that landed
    // while the snapshot was being read reaches the copy on the first replay.
    expect((await device.catchUp()).ok).toBe(true);
    const held = await device.list();
    expect(held.ok).toBe(true);
    expect(
      held.ok ? held.value.map((item) => item.id) : [],
      "a row written while the snapshot was being read never reached the copy, which is the loss the ordering exists to prevent",
    ).toContain("written-during-the-snapshot");
  });
});

describe("what a hydration leaves behind", () => {
  it("replaces what the store held", async () => {
    harness = await startHarness("replace");
    const { server, device } = harness;
    server.answer("GET", "/events", headRead("10"));
    server.answer("GET", "/types", typeCatalog());
    server.answer("GET", "/items", (request) =>
      request.query.get("type") === "core.note"
        ? itemsPage([{ item: wireItem({ id: "from-the-first-slice" }) }])
        : itemsPage([
            {
              item: wireItem({
                id: "from-the-second-slice",
                type: "core.bookmark",
              }),
            },
          ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.hydrate(["core.bookmark"], "library")).ok).toBe(true);

    const held = await device.list();
    expect(held.ok).toBe(true);
    const ids = held.ok ? held.value.map((item) => item.id) : [];
    expect(ids, "the new slice did not land").toContain(
      "from-the-second-slice",
    );
    expect(
      ids,
      "the previous slice survived the hydration, so a device that narrows what it declares keeps carrying rows it no longer asks the server about and never learns they changed",
    ).not.toContain("from-the-first-slice");

    const status = await device.status();
    expect(status.ok).toBe(true);
    expect(
      status.ok ? status.value.slice_types : [],
      "the device reports a slice it no longer holds",
    ).toEqual(["core.bookmark"]);
  });

  it("leaves an interrupted hydration to be run again, never resumed", async () => {
    harness = await startHarness("interrupted-hydration");
    const { server, device } = harness;
    server.answer("GET", "/events", headRead("10"));
    server.answer("GET", "/types", typeCatalog());
    server.answer(
      "GET",
      "/items",
      { kind: "drop" },
      itemsPage([
        { item: wireItem({ id: "a" }) },
        { item: wireItem({ id: "b" }) },
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(false);
    expect(
      (await device.list()).ok,
      "a half-hydrated store answered a read, so a caller sees part of a slice as though it were the whole one",
    ).toBe(false);

    const again = await device.hydrate(["core.note"], "library");
    expect(
      again.ok,
      `the second hydration was refused: ${JSON.stringify(again)}`,
    ).toBe(true);
    expect(
      again.ok ? again.value.items : -1,
      "the second hydration reported fewer rows than the slice holds, so it resumed the interrupted one rather than replacing it and the copy is short whatever the first attempt missed",
    ).toBe(2);
    expect((await device.list()).ok).toBe(true);
  });

  it("reports the counts, the pages and the cursor it stored", async () => {
    harness = await startHarness("report");
    const { server, device } = harness;
    server.answer("GET", "/events", headRead("42"));
    server.answer("GET", "/types", typeCatalog());
    server.answer(
      "GET",
      "/items",
      itemsPage([{ item: wireItem({ id: "page-one" }) }], {
        cursor: "p2",
        hasMore: true,
      }),
      itemsPage([{ item: wireItem({ id: "page-two" }) }]),
    );

    const hydrated = await device.hydrate(["core.note"], "library");
    expect(
      hydrated.ok,
      `the hydration was refused: ${JSON.stringify(hydrated)}`,
    ).toBe(true);
    if (!hydrated.ok) return;
    expect(
      hydrated.value.items,
      "the report did not count every row it pulled",
    ).toBe(2);
    expect(
      hydrated.value.pages,
      "the report counted one page for a walk that took two, so a caller cannot tell a complete walk from a truncated one",
    ).toBe(2);
    expect(
      hydrated.value.cursor,
      "the report named a cursor other than the one it took before the snapshot",
    ).toBe("42");

    const status = await device.status();
    expect(
      status.ok ? status.value.event_cursor : null,
      "the cursor the hydration reported is not the cursor the store kept, so a catch-up resumes from somewhere the caller was never told about",
    ).toBe("42");
  });
});
