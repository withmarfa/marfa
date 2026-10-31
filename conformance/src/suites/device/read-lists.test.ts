import { describe, it, expect, afterEach } from "vitest";
import type { WireItemOptions } from "../../device/marfa-answers.js";
import type { DeviceUnderTest, Outcome } from "../../device/protocol.js";
import { scriptHydration, startHarness, type Harness } from "./harness.js";

/**
 * A local list or search that names several types or several states, read
 * from the copy alone as the server reads the same lists
 * (`search-and-filters/type-list` and `search-and-filters/state-list`).
 *
 * Every case seeds a row the lists leave out, so a device that ignored a list
 * and one that read only its first entry both fail.
 */

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const WORD = "zqreadlists";

/** Created in this order, oldest first, so a created-at sort is known. */
const ROWS = [
  { id: "live-note", type: "core.note", state: "active" },
  { id: "filed-note", type: "core.note", state: "archived" },
  { id: "binned-note", type: "core.note", state: "trashed" },
  { id: "live-event", type: "core.event", state: "active" },
  { id: "filed-event", type: "core.event", state: "archived" },
  { id: "live-bookmark", type: "core.bookmark", state: "active" },
] as const;

const TYPES = ["core.note", "core.event", "core.bookmark"];

async function seeded(label: string): Promise<DeviceUnderTest> {
  harness = await startHarness(label);
  const rows: Record<string, Array<{ item: WireItemOptions }>> = {};
  ROWS.forEach((row, index) => {
    const at = `2026-09-18T00:00:0${String(index)}.000Z`;
    (rows[row.type] ??= []).push({
      item: {
        id: row.id,
        type: row.type,
        state: row.state,
        created_at: at,
        updated_at: at,
        occurred_at: at,
        properties: { title: `${WORD} ${row.id}` },
      },
    });
  });
  scriptHydration(harness.server, { head: "10", rows });
  const hydrated = await harness.device.hydrate(TYPES, "library");
  expect(
    hydrated.ok,
    `the hydration failed, so nothing below is about a read: ${JSON.stringify(hydrated)}`,
  ).toBe(true);
  const held = await harness.device.list({ allStates: true });
  expect(
    held.ok ? held.value.map((item) => item.id).sort() : held,
    "the copy does not hold every seeded row, so an absence below says nothing about the read",
  ).toEqual(ROWS.map((row) => row.id).sort());
  return harness.device;
}

function idsOf(
  outcome: Outcome<Array<{ id: string }>>,
  what: string,
): string[] {
  expect(outcome.ok, `${what} was refused: ${JSON.stringify(outcome)}`).toBe(
    true,
  );
  return outcome.ok ? outcome.value.map((item) => item.id).sort() : [];
}

async function listed(
  device: DeviceUnderTest,
  filters: Parameters<DeviceUnderTest["list"]>[0],
): Promise<string[]> {
  return idsOf(await device.list(filters), "the list");
}

async function searched(
  device: DeviceUnderTest,
  filters: Parameters<DeviceUnderTest["search"]>[1],
): Promise<string[]> {
  const found = await device.search(WORD, filters);
  return idsOf(
    found.ok ? { ok: true, value: found.value.map((hit) => hit.item) } : found,
    "the search",
  );
}

function refusedWith(outcome: Outcome<unknown>): string {
  if (outcome.ok) return "answered";
  return outcome.refusal.raw.includes("validation_error")
    ? `${outcome.refusal.code}/validation_error`
    : outcome.refusal.code;
}

describe("a local read naming several types", () => {
  it("answers the rows any type names, on a list and a search", async () => {
    const device = await seeded("read-type-list");
    // The bookmark is the witness: it is answered with no type named, so
    // its absence below is the list narrowing.
    expect(await listed(device, {})).toContain("live-bookmark");
    expect(await searched(device, {})).toContain("live-bookmark");

    const both = ["core.note", "core.event"];
    expect(
      await listed(device, { type: both }),
      "a list naming two types did not answer exactly the active rows of both",
    ).toEqual(["live-event", "live-note"]);
    expect(
      await searched(device, { type: both }),
      "a search naming two types did not match exactly the active rows of both",
    ).toEqual(["live-event", "live-note"]);
    expect(
      await listed(device, { type: ["core.event", "core.*"] }),
      "a namespace beside a type in the list did not answer its whole subtree",
    ).toEqual(["live-bookmark", "live-event", "live-note"]);
  });

  it("refuses the list for an entry it would refuse alone", async () => {
    const device = await seeded("read-type-list-refused");
    for (const [type, code] of [
      [["core.note", "core.taks"], "unknown_type"],
      [["core.note", "Core.task"], "validation/validation_error"],
    ] as const) {
      for (const outcome of [
        await device.list({ type: [...type] }),
        await device.search(WORD, { type: [...type] }),
      ]) {
        expect(
          refusedWith(outcome),
          `${type.join(",")} was not refused as its bad entry is alone, so one typo in a list narrows the answer silently`,
        ).toBe(code);
      }
    }
  });

  it("refuses more than ten types", async () => {
    const device = await seeded("read-type-list-max");
    const eleven = Array.from({ length: 11 }, (_, i) => `acme${String(i)}.*`);
    expect(
      await listed(device, { type: eleven.slice(0, 10) }),
      "a list of ten wildcards is refused, so the refusal below is not about the count",
    ).toEqual([]);
    for (const outcome of [
      await device.list({ type: eleven }),
      await device.search(WORD, { type: eleven }),
    ]) {
      expect(refusedWith(outcome), "a list of eleven types was answered").toBe(
        "validation/validation_error",
      );
    }
  });

  it("drops blank entries and repeats before it counts the list", async () => {
    const device = await seeded("read-type-list-blanks");
    for (const type of [
      ["core.note", ""],
      Array.from({ length: 11 }, () => "core.note"),
    ]) {
      expect(
        await listed(device, { type }),
        `${JSON.stringify(type)} did not answer exactly the active note`,
      ).toEqual(["live-note"]);
      expect(
        await searched(device, { type }),
        `a search naming ${JSON.stringify(type)} did not match exactly the active note`,
      ).toEqual(["live-note"]);
    }
  });

  it("refuses the global wildcard, alone or in a list", async () => {
    const device = await seeded("read-type-list-wildcard");
    for (const type of [["*"], ["core.note", "*"]]) {
      for (const outcome of [
        await device.list({ type }),
        await device.search(WORD, { type }),
      ]) {
        expect(
          refusedWith(outcome),
          `${type.join(",")} was answered, where the server refuses the global wildcard`,
        ).toBe("validation/validation_error");
      }
    }
  });
});

describe("a local read naming several states", () => {
  it("answers the rows in any state it names, and a search still never the bin", async () => {
    const device = await seeded("read-state-list");
    expect(
      await listed(device, { state: ["active", "archived"] }),
      "a list naming two states did not answer exactly the rows in either",
    ).toEqual([
      "filed-event",
      "filed-note",
      "live-bookmark",
      "live-event",
      "live-note",
    ]);
    expect(
      await listed(device, { state: ["archived", "trashed"] }),
      "a list naming the archive and the bin did not answer exactly the rows in either",
    ).toEqual(["binned-note", "filed-event", "filed-note"]);
    const found = await searched(device, { state: ["archived", "trashed"] });
    expect(
      found,
      "a search naming the archive did not match the archived rows, so the absence of the bin below proves nothing",
    ).toEqual(["filed-event", "filed-note"]);
    expect(
      await listed(device, {
        state: ["active", "archived"],
        type: ["core.event", "core.bookmark"],
      }),
      "a state list and a type list did not narrow together",
    ).toEqual(["filed-event", "live-bookmark", "live-event"]);
  });

  it("refuses states named beside every state", async () => {
    const device = await seeded("read-state-list-all");
    expect(
      (await device.list({ allStates: true })).ok,
      "every state alone is refused, so the refusal below is not about the pair",
    ).toBe(true);
    for (const outcome of [
      await device.list({ state: ["active"], allStates: true }),
      await device.search(WORD, { state: ["active"], allStates: true }),
    ]) {
      expect(
        refusedWith(outcome),
        "a read naming states and every state was answered, so one of the two was dropped silently",
      ).toBe("validation/validation_error");
    }
  });
});

describe("the limit on a local read", () => {
  it("counts only the rows the type and state lists keep", async () => {
    const device = await seeded("read-limit-after-filter");
    // The newest row, the bookmark, is one the type list leaves out, and the
    // next, the archived event, is one the state list leaves out: a limit
    // applied before either list answers an empty page or the wrong row.
    const page = await device.list({
      state: ["active", "trashed"],
      type: ["core.event", "core.note"],
      sort: "created_at",
      direction: "desc",
      limit: 1,
    });
    expect(
      page.ok ? page.value.map((item) => item.id) : page,
      "a page of one did not hold the newest row the lists keep",
    ).toEqual(["live-event"]);

    const hits = await device.search(
      WORD,
      { state: ["active", "archived"], type: "core.note" },
      1,
    );
    expect(
      hits.ok ? hits.value.map((hit) => hit.item.id) : hits,
      "a search page of one held no row",
    ).toHaveLength(1);
    expect(["live-note", "filed-note"]).toContain(
      hits.ok ? hits.value[0]?.item.id : undefined,
    );
  });
});
