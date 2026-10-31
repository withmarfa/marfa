import { describe, it, expect, afterEach } from "vitest";
import {
  copyItemEvent,
  copyReplay,
  wireItem,
} from "../../device/marfa-answers.js";
import type { DeviceUnderTest, Item } from "../../device/protocol.js";
import { scriptHydration, startHarness, type Harness } from "./harness.js";

/**
 * The bin as the copy holds it: a row the slice takes stays in the copy when
 * it goes to the bin, by the device's own delete or by an event, and a local
 * list naming the bin answers those rows with the server away, newest binned
 * first. The copy stamps when its own delete binned a row, clears it on
 * restore, and holds the server's time once the server's row arrives
 * (`device/bin-local-order`, `device/bin-local-stamp`,
 * `device/bin-local-restore`, `device/bin-local-server-time`). A purge takes
 * the row out, however late the copy hears of it.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const T0 = "2026-09-18T00:00:00.000Z";
const T1 = "2026-09-18T01:00:00.000Z";
const T2 = "2026-09-18T02:00:00.000Z";
const T3 = "2026-09-18T03:00:00.000Z";
const T4 = "2026-09-18T04:00:00.000Z";

async function ids(
  device: DeviceUnderTest,
  filters: Parameters<DeviceUnderTest["list"]>[0],
): Promise<string[]> {
  const listed = await device.list(filters);
  expect(listed.ok, `the list was refused: ${JSON.stringify(listed)}`).toBe(
    true,
  );
  return listed.ok ? listed.value.map((item) => item.id) : [];
}

/** Every row the copy holds, in every state, with its state. */
async function held(
  device: DeviceUnderTest,
): Promise<Array<{ id: string; state: string }>> {
  const listed = await device.list({ allStates: true });
  expect(listed.ok, JSON.stringify(listed)).toBe(true);
  return listed.ok
    ? listed.value
        .map(({ id, state }) => ({ id, state }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];
}

/** A local read the server never saw: the requests stay where they were. */
async function offline<T>(
  started: Harness,
  read: () => Promise<T>,
): Promise<T> {
  await started.server.offline();
  const before = started.server.requests.length;
  try {
    return await read();
  } finally {
    await started.server.online();
    expect(
      started.server.requests.length,
      "the local read went to the server",
    ).toBe(before);
  }
}

describe("a row the copy holds goes to the bin", () => {
  it("holds a row the device puts in the bin, and lists it there with the server away", async () => {
    harness = await startHarness("bin-held-delete");
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [{ item: { id: "kept" } }, { item: { id: "other" } }],
      },
    });
    expect((await harness.device.hydrate(["core.note"], "library")).ok).toBe(
      true,
    );
    // The witness: before the delete the bin holds nothing, so the row in
    // it below is the delete's doing.
    expect(await ids(harness.device, { state: "trashed" })).toEqual([]);

    const deleted = await harness.device.deleteItem("kept");
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);

    const started = harness;
    const binned = await offline(started, () =>
      ids(started.device, { state: "trashed" }),
    );
    expect(
      binned,
      "a row the device put in the bin left the copy, so a person cannot find it again offline",
    ).toEqual(["kept"]);
    expect(
      await ids(started.device, {}),
      "a row in the bin is still answered as present",
    ).toEqual(["other"]);
  });

  it("holds a row an event puts in the bin, and lists it there with the server away", async () => {
    harness = await startHarness("bin-held-event");
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [{ item: { id: "row", updated_at: T0 } }],
      },
    });
    harness.server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent(
          "11",
          "item.deleted",
          wireItem({ id: "row", state: "trashed", updated_at: T1 }),
        ),
      ]),
    );
    expect((await harness.device.hydrate(["core.note"], "library")).ok).toBe(
      true,
    );
    expect(await ids(harness.device, { state: "trashed" })).toEqual([]);
    const caught = await harness.device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);

    const started = harness;
    expect(
      await offline(started, () => ids(started.device, { state: "trashed" })),
      "a row the server put in the bin left the copy, so the bin offline misses it",
    ).toEqual(["row"]);
  });

  it("orders the bin newest binned first, a row with no time at its updated_at", async () => {
    harness = await startHarness("bin-held-order");
    // Created in the opposite order to the one they went to the bin in, so a
    // list in creation order answers them reversed. `written-since` was
    // changed after it went to the bin, so a list by `updated_at` puts it
    // first; `no-time` kept no time and stands at its `updated_at`.
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "written-since",
              state: "trashed",
              created_at: T3,
              updated_at: T4,
              trashed_at: T0,
            },
          },
          {
            item: {
              id: "no-time",
              state: "trashed",
              created_at: T2,
              updated_at: T1,
            },
          },
          {
            item: {
              id: "last-binned",
              state: "trashed",
              created_at: T0,
              updated_at: T3,
              trashed_at: T3,
            },
          },
          {
            item: {
              id: "middle-binned",
              state: "trashed",
              created_at: T1,
              updated_at: T2,
              trashed_at: T2,
            },
          },
        ],
      },
    });
    expect((await harness.device.hydrate(["core.note"], "library")).ok).toBe(
      true,
    );
    const started = harness;
    const newest = ["last-binned", "middle-binned", "no-time", "written-since"];
    expect(
      await offline(started, () => ids(started.device, { state: "trashed" })),
      "the bin was not answered newest first by the time each row went there",
    ).toEqual(newest);
    expect(
      await ids(started.device, { state: "trashed", direction: "asc" }),
      "a direction alone did not reverse the bin's order",
    ).toEqual([...newest].reverse());
    expect(
      await ids(started.device, { state: "trashed", sort: "updated_at" }),
      "a named sort did not replace the bin's order",
    ).toEqual(["written-since", "last-binned", "middle-binned", "no-time"]);
  });
});

/** Every row the copy holds, in every state, by id. */
async function rows(device: DeviceUnderTest): Promise<Map<string, Item>> {
  const listed = await device.list({ allStates: true });
  expect(listed.ok, JSON.stringify(listed)).toBe(true);
  return new Map(listed.ok ? listed.value.map((row) => [row.id, row]) : []);
}

describe("when a held row went to the bin", () => {
  it("records when the device put it there, leaving updated_at, clears it on restore, and takes a new time on a second delete", async () => {
    harness = await startHarness("bin-held-stamp");
    scriptHydration(harness.server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "kept", updated_at: T0 } }] },
    });
    expect((await harness.device.hydrate(["core.note"], "library")).ok).toBe(
      true,
    );
    expect((await rows(harness.device)).get("kept")).toMatchObject({
      state: "active",
      trashed_at: null,
    });

    const started = harness;
    await started.server.offline();
    try {
      const before = Date.now();
      expect((await started.device.deleteItem("kept")).ok).toBe(true);
      const after = Date.now();
      const binned = (await rows(started.device)).get("kept");
      expect(binned?.state).toBe("trashed");
      expect(binned?.updated_at, "the delete moved updated_at").toBe(T0);
      expect(binned?.trashed_at, "the delete kept no time").not.toBeNull();
      const first = Date.parse(binned?.trashed_at ?? "");
      expect(first).toBeGreaterThanOrEqual(before - 1000);
      expect(first).toBeLessThanOrEqual(after + 1000);

      expect((await started.device.restoreItem("kept")).ok).toBe(true);
      expect((await rows(started.device)).get("kept")).toMatchObject({
        state: "active",
        trashed_at: null,
      });

      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await started.device.deleteItem("kept")).ok).toBe(true);
      const again = (await rows(started.device)).get("kept");
      expect(
        Date.parse(again?.trashed_at ?? ""),
        "a second delete kept the first delete's time",
      ).toBeGreaterThan(first);
    } finally {
      await started.server.online();
    }
  });

  it("holds the server's time in place of its own once the server's row arrives", async () => {
    harness = await startHarness("bin-held-server-time");
    scriptHydration(harness.server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "row", updated_at: T0 } }] },
    });
    harness.server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent(
          "11",
          "item.deleted",
          wireItem({
            id: "row",
            state: "trashed",
            version: 2,
            updated_at: T1,
            trashed_at: T1,
          }),
        ),
      ]),
    );
    expect((await harness.device.hydrate(["core.note"], "library")).ok).toBe(
      true,
    );
    const started = harness;
    await started.server.offline();
    const deleted = await started.device.deleteItem("row");
    const local = (await rows(started.device)).get("row")?.trashed_at;
    await started.server.online();
    expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
    // The witness: the device's own time, which the server's then replaces.
    expect(local).not.toBeNull();
    expect(local).not.toBe(T1);

    const caught = await started.device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect(
      (await rows(started.device)).get("row")?.trashed_at,
      "the device kept its own time over the server's",
    ).toBe(T1);
  });
});

describe("a row that goes to the bin and back before the copy hears", () => {
  it("holds one row, in the state the last event gives", async () => {
    harness = await startHarness("bin-held-restored");
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [
          { item: { id: "back", updated_at: T0 } },
          { item: { id: "gone-again", state: "trashed", updated_at: T0 } },
        ],
      },
    });
    harness.server.copyAnswer(
      "GET",
      "/events",
      copyReplay("14", [
        copyItemEvent(
          "11",
          "item.deleted",
          wireItem({ id: "back", state: "trashed", updated_at: T1 }),
        ),
        copyItemEvent(
          "12",
          "item.restored",
          wireItem({ id: "back", state: "active", updated_at: T2 }),
        ),
        copyItemEvent(
          "13",
          "item.restored",
          wireItem({ id: "gone-again", state: "active", updated_at: T1 }),
        ),
        copyItemEvent(
          "14",
          "item.deleted",
          wireItem({ id: "gone-again", state: "trashed", updated_at: T2 }),
        ),
      ]),
    );
    expect((await harness.device.hydrate(["core.note"], "library")).ok).toBe(
      true,
    );
    const caught = await harness.device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect(caught.ok && caught.value.applied).toBe(4);

    expect(
      await held(harness.device),
      "a row that went to the bin and back is held twice, or in a state it left",
    ).toEqual([
      { id: "back", state: "active" },
      { id: "gone-again", state: "trashed" },
    ]);
    expect(await ids(harness.device, { state: "trashed" })).toEqual([
      "gone-again",
    ]);
    expect(await ids(harness.device, {})).toEqual(["back"]);
  });
});

describe("a purge the copy hears of late", () => {
  it("drops a row purged while the copy was offline, at its next catch-up", async () => {
    harness = await startHarness("bin-purged-offline");
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [
          { item: { id: "purged", state: "trashed" } },
          { item: { id: "stays", state: "trashed" } },
        ],
      },
    });
    harness.server.copyAnswer(
      "GET",
      "/events",
      copyReplay("11", [
        copyItemEvent(
          "11",
          "item.purged",
          wireItem({ id: "purged", state: "trashed" }),
        ),
      ]),
    );
    expect((await harness.device.hydrate(["core.note"], "library")).ok).toBe(
      true,
    );

    // While the server is away the copy still answers the row from its bin:
    // the witness that the row was held, and that only the event removes it.
    const started = harness;
    await started.server.offline();
    const missed = await started.device.catchUp();
    const binned = await ids(started.device, { state: "trashed" });
    await started.server.online();
    expect(missed.ok, "a catch-up with the server away succeeded").toBe(false);
    expect(binned.sort()).toEqual(["purged", "stays"]);

    const caught = await started.device.catchUp();
    expect(caught.ok, JSON.stringify(caught)).toBe(true);
    expect(
      await held(started.device),
      "a row the server purged is still held, so a person can still see and restore a row that no longer exists",
    ).toEqual([{ id: "stays", state: "trashed" }]);
  });
});
