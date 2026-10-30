import { afterEach, describe, expect, it } from "vitest";
import {
  copyItemEvent,
  copyReplay,
  edgeEvent,
  wireEdge,
  wireItem,
  type WireEdgeOptions,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import type { Outcome } from "../../device/protocol.js";
import type { Answer } from "../../device/scripted-server.js";
import { scriptHydration, startHarness, type Harness } from "./harness.js";

/**
 * Reads of many rows in one call, and the rows changed since a cursor (the
 * device chapter's section "Reads of many rows, and what changed").
 */

let harness: Harness | undefined;
let other: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  await other?.stop();
  harness = undefined;
  other = undefined;
  replayed = undefined;
});

const A = "01b00000-0000-7000-8000-0000000000a1";
const B = "01b00000-0000-7000-8000-0000000000a2";
const C = "01b00000-0000-7000-8000-0000000000a3";
const BINNED = "01b00000-0000-7000-8000-0000000000a4";
const AB = "01b00000-0000-7000-8000-0000000000e1";
const BA = "01b00000-0000-7000-8000-0000000000e2";

const ab: WireEdgeOptions = { id: AB, source_id: A, target_id: B };
const ba: WireEdgeOptions = { id: BA, source_id: B, target_id: A };

function note(id: string, title: string, body: string): WireItemOptions {
  return { id, properties: { title, body } };
}

/** What the next catch-up replays, the log holding nothing after the head
 *  where unset. */
let replayed: Answer | undefined;

/** A whole copy of `A`, `B` and `C`, one note in the bin, `AB` from `A` to
 *  `B` and `BA` back. `rows` is the list the server serves, so a fixture
 *  changes it to stand for the server changing. */
async function hydrated(
  label: string,
  rows: Array<{ item: WireItemOptions }> = [
    { item: note(A, "Note A", "about [[Note B]]") },
    { item: note(B, "Note B", "about [[Note A]] and [[Nowhere]]") },
    { item: note(C, "Note C", "") },
    {
      item: {
        ...note(BINNED, "Binned", "about [[Note A]]"),
        state: "trashed",
      },
    },
  ],
): Promise<{ started: Harness; rows: Array<{ item: WireItemOptions }> }> {
  const started = await startHarness(label);
  scriptHydration(started.server, {
    head: "10",
    replay: (cursor) => replayed ?? copyReplay(cursor, []),
    rows: { "core.note": rows },
    edges: { references: [ab, ba] },
  });
  const done = await started.device.hydrate(["core.note"], "library", {
    edgeTypes: ["references"],
  });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  return { started, rows };
}

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.refusal.raw);
  return outcome.value;
}

function code(outcome: Outcome<unknown>): string {
  return outcome.ok ? "answered" : outcome.refusal.code;
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

describe("a read of many items by id", () => {
  it("answers each item held once, in the order named, and the bin only when asked", async () => {
    ({ started: harness } = await hydrated("bulk-get-order"));
    const { device } = harness;
    const named = [C, "01b00000-0000-7000-8000-0000000000ff", BINNED, A, C];

    const listed = value(await device.bulkGet(named));
    expect(
      listed.items.map((item) => item.id),
      "the read answered rows out of the order named, twice, from the bin, or one the copy does not hold",
    ).toEqual([C, A]);
    expect(listed.completeness).toBe("complete");
    // The witness: the item in the bin is held, and answered when asked for.
    const withBin = value(await device.bulkGet(named, { includeBin: true }));
    expect(withBin.items.map((item) => item.id)).toEqual([C, BINNED, A]);
    const one = value(await device.get(A));
    expect(
      listed.items[1],
      "an item read with others differs from the same item read alone",
    ).toEqual(one);
  });

  it("answers what has arrived part way through a hydration, saying the answer is partial", async () => {
    harness = await startHarness("bulk-get-partial");
    const { server, device } = harness;
    let cut = true;
    scriptHydration(server, {
      head: "10",
      pageSize: 1,
      drop: () => cut,
      rows: {
        "core.note": [
          { item: note(A, "Note A", "") },
          { item: note(B, "Note B", "") },
        ],
      },
    });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(false);

    const listed = value(await device.bulkGet([A, B]));
    expect(listed.items.map((item) => item.id)).toEqual([A]);
    expect(
      listed.completeness,
      "a read that left out a row still to arrive did not say the copy was partial",
    ).toBe("partial");
    // The witness: once whole, the same read answers both, marked complete.
    cut = false;
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const whole = value(await device.bulkGet([A, B]));
    expect(whole.items.map((item) => item.id)).toEqual([A, B]);
    expect(whole.completeness).toBe("complete");
  });
});

describe("a read of edges by id", () => {
  it("answers one edge, many in the order named, and refuses one not held", async () => {
    ({ started: harness } = await hydrated("edge-get"));
    const { device } = harness;

    const one = value(await device.edge(AB));
    expect([one.source_id, one.target_id, one.version]).toEqual([A, B, 1]);
    expect(
      code(await device.edge("01b00000-0000-7000-8000-0000000000ef")),
    ).toBe("not_held");
    const many = value(
      await device.bulkGetEdges([
        BA,
        "01b00000-0000-7000-8000-0000000000ef",
        AB,
        BA,
      ]),
    );
    expect(
      many.map((edge) => edge.id),
      "the read answered edges out of the order named, twice, or one the copy does not hold",
    ).toEqual([BA, AB]);
    expect(many[1]).toEqual(one);
  });

  it("answers an edge at the ends a catch-up moved it to", async () => {
    ({ started: harness } = await hydrated("edge-get-moved"));
    const { device } = harness;
    replayed = copyReplay("11", [
      edgeEvent(
        "11",
        "edge.updated",
        wireEdge({ ...ab, target_id: C, version: 2 }),
      ),
    ]);
    value(await device.catchUp());

    const moved = value(await device.edge(AB));
    expect(
      [moved.target_id, moved.version],
      "the read answered the edge where it was before the move",
    ).toEqual([C, 2]);
    expect(value(await device.bulkGetEdges([AB]))).toEqual([moved]);
  });

  it("refuses a read of edges by id part way through a hydration", async () => {
    harness = await startHarness("edge-get-partial");
    const { server, device } = harness;
    let cut = true;
    scriptHydration(server, {
      head: "10",
      pageSize: 1,
      drop: () => cut,
      rows: {
        "core.note": [
          { item: note(A, "Note A", "") },
          { item: note(B, "Note B", "") },
        ],
      },
      edges: { references: [ab] },
    });
    expect(
      (
        await device.hydrate(["core.note"], "library", {
          edgeTypes: ["references"],
        })
      ).ok,
    ).toBe(false);

    expect(code(await device.edge(AB))).toBe("hydration_incomplete");
    expect(code(await device.bulkGetEdges([AB]))).toBe("hydration_incomplete");
    expect(code(await device.bulkLinks([A]))).toBe("hydration_incomplete");
    // The witness: the whole copy answers the same reads.
    cut = false;
    expect(
      (
        await device.hydrate(["core.note"], "library", {
          edgeTypes: ["references"],
        })
      ).ok,
    ).toBe(true);
    expect(value(await device.edge(AB)).id).toBe(AB);
  });
});

describe("a read of many items' body links", () => {
  it("answers for each item what a read of its links answers, leaving out one in the bin or not held", async () => {
    ({ started: harness } = await hydrated("bulk-links"));
    const { device } = harness;

    const links = value(
      await device.bulkLinks([
        B,
        A,
        C,
        BINNED,
        "01b00000-0000-7000-8000-0000000000ff",
      ]),
    );
    expect(
      sorted(Object.keys(links)),
      "the read answered an item in the bin or one the copy does not hold, or left out one it holds",
    ).toEqual(sorted([A, B, C]));
    for (const id of [A, B, C]) {
      expect(
        links[id],
        `the links of ${id} read with others differ from the same read alone`,
      ).toEqual(value(await device.bodyLinks(id)));
    }
    expect(links[B]!.links).toHaveLength(2);
    // The witness: the item in the bin has links, and a read of it alone is
    // refused rather than answered empty.
    expect(code(await device.bodyLinks(BINNED))).not.toBe("answered");
  });
});

describe("what changed since a cursor", () => {
  it("names the items and edges a catch-up changed, moved and purged", async () => {
    ({ started: harness } = await hydrated("changed-catch-up"));
    const { device } = harness;
    const first = value(await device.changed());
    expect(
      first.everything,
      "a read with no cursor named rows one by one",
    ).toBe(true);
    const quiet = value(await device.changed({ since: first.cursor }));
    expect(quiet).toMatchObject({
      everything: false,
      items: [],
      removed_items: [],
      edges: [],
      removed_edges: [],
    });

    replayed = copyReplay("13", [
      copyItemEvent(
        "11",
        "item.updated",
        wireItem({ ...note(C, "Note C", "changed"), version: 2 }),
      ),
      edgeEvent(
        "12",
        "edge.updated",
        wireEdge({ ...ab, target_id: C, version: 2 }),
      ),
      copyItemEvent(
        "13",
        "item.purged",
        wireItem({ ...note(B, "Note B", ""), version: 2 }),
      ),
    ]);
    value(await device.catchUp());

    const changes = value(await device.changed({ since: quiet.cursor }));
    expect(changes.everything).toBe(false);
    expect(
      changes.items,
      "an item changed, or at an edge that moved, was not named",
    ).toEqual(expect.arrayContaining([A, C]));
    expect(changes.items, "a purged item was named as held").not.toContain(B);
    expect(changes.removed_items).toEqual([B]);
    expect(changes.edges, "the moved edge was not named").toEqual([AB]);
    expect(
      changes.removed_edges,
      "the edge the purge took with its item was not named as removed",
    ).toEqual([BA]);
    const after = value(await device.changed({ since: changes.cursor }));
    expect(after.items).toEqual([]);
  });

  it("names what a hydration that replaces the copy holds, and what it took out", async () => {
    const made = await hydrated("changed-hydration");
    harness = made.started;
    const { device } = harness;
    const since = value(await device.changed()).cursor;
    made.rows.splice(1, 1);
    made.rows.push({
      item: note("01b00000-0000-7000-8000-0000000000a5", "New", ""),
    });

    value(
      await device.hydrate(["core.note"], "library", {
        edgeTypes: ["references"],
      }),
    );
    const changes = value(await device.changed({ since }));
    expect(changes.everything).toBe(false);
    expect(changes.items).toEqual(
      expect.arrayContaining([A, C, "01b00000-0000-7000-8000-0000000000a5"]),
    );
    expect(changes.removed_items).toEqual([B]);
  });

  it("answers everything for a cursor it cannot follow one by one", async () => {
    ({ started: harness } = await hydrated("changed-everything"));
    const { device } = harness;
    ({ started: other } = await hydrated("changed-other-store"));
    const elsewhere = value(await other.device.changed()).cursor;
    const here = value(await device.changed()).cursor;
    expect(value(await device.changed({ since: here })).everything).toBe(false);

    expect(
      value(await device.changed({ since: elsewhere })).everything,
      "a cursor from another store was followed as this store's",
    ).toBe(true);
    const [store, items, edges] = here.split(".");
    expect(
      value(
        await device.changed({
          since: `${store}.${String(Number(items) + 5)}.${edges}`,
        }),
      ).everything,
      "a cursor from beyond what the copy has recorded was followed",
    ).toBe(true);
    expect(code(await device.changed({ since: "not a cursor" }))).toBe(
      "invalid",
    );

    await device.deleteItem(A);
    await device.deleteItem(C);
    const two = value(await device.changed({ since: here, most: 2 }));
    expect(two.everything).toBe(false);
    expect(sorted(two.items)).toEqual(sorted([A, C]));
    expect(
      value(await device.changed({ since: here, most: 1 })).everything,
      "more changes than the caller would take were named one by one",
    ).toBe(true);
  });
});
