import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext, MarfaItem } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

/**
 * What a door answers when the caller names no state.
 *
 * A listing's default is the active state (`items/bin-hidden`,
 * `items/archived-hidden`), a search takes the same default
 * (`search-and-filters/state-search-default`), and an export departs from
 * it (`search-and-filters/export-state-default`). Three doors, two answers, and the
 * divergence is deliberate: a listing and a search answer what the reader
 * is working with, while the archive an export writes is what a restore
 * reads back, so dropping archived rows from it would lose them on the
 * round trip.
 *
 * Every case asserts on which ids come back rather than on a count. A door
 * that lost its state predicate and a door that matched nothing both
 * produce a plausible number, and the active row is what says the query
 * reached anything at all.
 */

let client: MarfaClient;
let ctx: TestContext;

let active: MarfaItem;
let archived: MarfaItem;
let trashed: MarfaItem;

/** The three rows this file seeded, so a shared instance's other rows
 *  cannot answer for them. */
let mine: Set<string>;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "state-default"));

  const seed = async (label: string): Promise<MarfaItem> => {
    const res = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: `state-default-${label}`,
        properties: {
          title: `state-default ${label}`,
          body: `zqstatedefault ${label}`,
        },
      }),
    );
    expect(
      res.ok,
      "the fixture cannot seed a row, so nothing below means anything",
    ).toBe(true);
    trackItem(ctx, res.data.item.id);
    return res.data.item;
  };

  active = await seed("active");
  archived = await seed("archived");
  trashed = await seed("trashed");

  const toArchived = await client.transitionItem(archived.id, "archived");
  expect(
    toArchived.ok && toArchived.data.item.state === "archived",
    "the fixture cannot put a row in the archive, so every case below is about two rows rather than three",
  ).toBe(true);

  const toTrashed = await client.deleteItem(trashed.id);
  expect(
    toTrashed.ok,
    "the fixture cannot put a row in the bin, so nothing below distinguishes the bin from the archive",
  ).toBe(true);

  mine = new Set([active.id, archived.id, trashed.id]);
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Ids of this file's rows in a listing, in the order the door returned. */
async function listed(
  filters: Parameters<MarfaClient["listItems"]>[0] = {},
): Promise<string[]> {
  const res = await client.listItems({
    source: ctx.source,
    limit: 100,
    ...filters,
  });
  expect(
    res.ok,
    `the listing door refused this read, so the case that called it is about a refusal rather than a selection: ${JSON.stringify(res)}`,
  ).toBe(true);
  return res.data.data.map((item) => item.id).filter((id) => mine.has(id));
}

async function searched(filters: { state?: string } = {}): Promise<string[]> {
  const res = await client.search("zqstatedefault", { limit: 100, ...filters });
  expect(
    res.ok,
    `the search door refused this read, so the case that called it is about a refusal rather than a selection: ${JSON.stringify(res)}`,
  ).toBe(true);
  return res.data.data.map((hit) => hit.item.id).filter((id) => mine.has(id));
}

async function exported(filters: { state?: string } = {}): Promise<string[]> {
  const res = await client.exportItems({ source: ctx.source, ...filters });
  expect(
    res.ok,
    `the export door refused this read, so the case that called it is about a refusal rather than a selection: ${JSON.stringify(res)}`,
  ).toBe(true);
  return res.data
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { item?: MarfaItem })
    .flatMap((parsed) =>
      parsed.item && mine.has(parsed.item.id) ? [parsed.item.id] : [],
    );
}

describe("the state a door answers when none is named", () => {
  it("a listing that names no state answers the active state", async () => {
    const ids = await listed();
    expect(
      ids,
      "a listing naming no state stopped answering live rows, so an unnarrowed read reports an empty instance",
    ).toContain(active.id);
    expect(
      ids,
      "a listing naming no state answers archived rows, so a reader is handed rows they deliberately put away",
    ).not.toContain(archived.id);
    expect(
      ids,
      "a listing naming no state answers the bin, so a deleted row still reads as present",
    ).not.toContain(trashed.id);
  });

  it("a named state and the sentinel still reach every row", async () => {
    expect(
      await listed({ state: "archived" }),
      "naming a state no longer reaches it, so the rows the default hides are unreachable",
    ).toEqual([archived.id]);
    expect(
      await listed({ state: "trashed" }),
      "naming the bin no longer reaches it, so a deleted row cannot be found in order to be restored",
    ).toEqual([trashed.id]);
    // By identity rather than by length: a sentinel read as a plain state
    // value compares against the column, matches nothing, and leaves a
    // length assertion failing for a reason nobody can see.
    expect(
      (await listed({ state: "any" })).slice().sort(),
      "the sentinel stopped widening, so nothing reads across states in one pass",
    ).toEqual([active.id, archived.id, trashed.id].sort());
  });

  it("a search that names no state answers the active state", async () => {
    const ids = await searched();
    expect(
      ids,
      "a search naming no state stopped matching live rows, so the index answers nothing",
    ).toContain(active.id);
    expect(
      ids,
      "a search answers a row a listing hides, which is two answers to one question",
    ).not.toContain(archived.id);
    expect(
      ids,
      "a search answers the bin, so a deleted row is still findable and reads as present",
    ).not.toContain(trashed.id);
    expect(
      await searched({ state: "archived" }),
      "naming a state no longer reaches it on the search door, so its rows are unreachable by any read",
    ).toEqual([archived.id]);
  });

  it("a read by id answers an archived row and refuses one in the bin", async () => {
    // The other half of what the default means. A listing narrows because
    // the question has no subject; a read naming one row has one, and the
    // archived row a listing hides is the row a caller is holding the id
    // of. The bin is where the two doors agree.
    const filed = await client.getItem(archived.id);
    expect(
      filed.ok,
      "an archived row is not readable by id, so putting a row in the archive makes it unreachable rather than quiet",
    ).toBe(true);

    const live = await client.getItem(active.id);
    expect(
      live.ok,
      "an ordinary read by id was refused, so the refusal below is about a broken door rather than the bin",
    ).toBe(true);

    const binned = await client.getItem(trashed.id);
    expect(
      binned.ok,
      "a row in the bin is readable by id, so a delete hides a row from listings and leaves it addressable",
    ).toBe(false);
  });

  it("a search reads across states under the sentinel, except the bin", async () => {
    const ids = await searched({ state: "any" });
    expect(
      ids,
      "the sentinel stopped widening on the search door, so nothing reads across states through the index",
    ).toContain(archived.id);
    expect(
      ids,
      "the sentinel narrowed rather than widened, so it answers less than naming no state at all",
    ).toContain(active.id);
    // The one thing the sentinel cannot reach here, and it is the index
    // rather than the query: a trashed row is removed from the index on
    // the write that trashes it, so no state value matches it.
    expect(
      ids,
      "a row in the bin is matched by a search, so a deleted row is findable by text and the index holds rows the listing grammar cannot explain",
    ).not.toContain(trashed.id);
    expect(
      await searched({ state: "trashed" }),
      "naming the bin on the search door matches a row, so the index and the listing disagree about what a delete removes",
    ).toEqual([]);
  });

  it("a search does not reach a row born in the bin either", async () => {
    // The case above puts its row in the bin with a delete, which is the one
    // door that took a row back out of the index. A row created with its
    // state named never passes through that door, so it stayed indexed and
    // the sentinel answered it — the index holding what the grammar says no
    // search can reach.
    const born = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: "state-default-born-binned",
        properties: {
          title: "state-default born binned",
          body: "zqstatedefault born",
        },
        state: "trashed",
      }),
    );
    expect(
      born.ok && born.data.item.state === "trashed",
      "the fixture cannot create a row already in the bin, so this case says nothing about the door it exists for",
    ).toBe(true);
    if (!born.ok) return;
    trackItem(ctx, born.data.item.id);
    // Every read here narrows to `mine`, so a row absent from it cannot
    // appear in a result whatever the server does — and the assertion below
    // would hold against a server that indexed the bin and answered it.
    mine.add(born.data.item.id);

    const widened = await searched({ state: "any" });
    // The control: the same read reaches an ordinary row, so the absence
    // below is the bin rather than a search that matches nothing.
    expect(
      widened,
      "the sentinel matches nothing at all on this text, so the absence below would hold against a broken search",
    ).toContain(active.id);
    expect(
      widened,
      "a row created straight into the bin is matched by a search, so whether a deleted row is findable depends on which door put it there",
    ).not.toContain(born.data.item.id);
  });

  it("refuses a state that is not a state, on every door that reads items", async () => {
    // The three doors resolve `state` through one rule, so the refusal has
    // to be the same on all three. Driven per door rather than once,
    // because a door that validated the value itself before the rule ran
    // would answer the same code for a different reason and stop agreeing
    // the moment the rule changed.
    for (const [door, res] of [
      ["listing", await client.listItems({ state: "nonsense" })],
      ["search", await client.search("zqstatedefault", { state: "nonsense" })],
      ["export", await client.exportItems({ state: "nonsense" })],
    ] as const) {
      expect(
        res.ok,
        `the ${door} door answered a state that is not a state, so a typo in a filter is served as a successful selection`,
      ).toBe(false);
      expect(
        res.error?.error.code,
        `the ${door} door refused an off-enum state with the wrong code, so one door's refusal cannot be handled like another's`,
      ).toBe("validation_error");
    }
  });

  it("an export that names no state carries archived rows", async () => {
    const ids = await exported();
    expect(
      ids,
      "an export naming no state stopped carrying live rows, so a backup is empty",
    ).toContain(active.id);
    expect(
      ids,
      "an export took the listing default, so a backup and the restore that reads it lose every archived row",
    ).toContain(archived.id);
    expect(
      ids,
      "an export carries the bin by default, so a restore resurrects deleted rows",
    ).not.toContain(trashed.id);
  });
});
