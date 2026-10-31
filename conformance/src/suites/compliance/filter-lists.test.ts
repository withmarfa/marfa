import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext, MarfaItem } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import {
  createBookmark,
  createNote,
  createTask,
} from "../../generators/items.js";

/**
 * A `type` or `state` filter that names several values, on every door that
 * reads items by them: `GET /items`, `GET /items/stats`, `GET /search` and
 * `GET /export` (`search-and-filters/type-list`, `search-and-filters/state-list`).
 *
 * Every case asserts on which ids come back, and each seeds a row the list
 * leaves out, so a door that ignored the list and a door that read only its
 * first entry both fail.
 */

let client: MarfaClient;
let ctx: TestContext;

let liveNote: MarfaItem;
let filedNote: MarfaItem;
let binnedNote: MarfaItem;
let liveTask: MarfaItem;
let filedTask: MarfaItem;
let liveBookmark: MarfaItem;

let mine: Set<string>;

const WORD = "zqfilterlists";

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "filter-lists"));

  const seed = async (
    make: typeof createNote,
    label: string,
  ): Promise<MarfaItem> => {
    const base = make({
      source: ctx.source,
      source_id: `filter-lists-${label}`,
    });
    const res = await client.createItem({
      ...base,
      properties: { ...base.properties, title: `${WORD} ${label}` },
    });
    expect(
      res.ok,
      `the fixture cannot seed ${label}, so nothing below means anything: ${JSON.stringify(res.error)}`,
    ).toBe(true);
    trackItem(ctx, res.data.item.id);
    return res.data.item;
  };

  liveNote = await seed(createNote, "live-note");
  filedNote = await seed(createNote, "filed-note");
  binnedNote = await seed(createNote, "binned-note");
  liveTask = await seed(createTask, "live-task");
  filedTask = await seed(createTask, "filed-task");
  liveBookmark = await seed(createBookmark, "live-bookmark");

  for (const item of [filedNote, filedTask]) {
    const res = await client.transitionItem(item.id, "archived");
    expect(
      res.ok,
      "the fixture cannot archive a row, so no case below tells two states apart",
    ).toBe(true);
  }
  const binned = await client.deleteItem(binnedNote.id);
  expect(
    binned.ok,
    "the fixture cannot put a row in the bin, so no case below reaches it",
  ).toBe(true);

  mine = new Set(
    [liveNote, filedNote, binnedNote, liveTask, filedTask, liveBookmark].map(
      (item) => item.id,
    ),
  );
});

afterAll(async () => {
  await cleanup(ctx);
});

const sorted = (ids: string[]): string[] => ids.slice().sort();

async function listed(query: Record<string, string>): Promise<string[]> {
  const res = await client.listItems({
    source: ctx.source,
    limit: 100,
    ...query,
  });
  expect(res.ok, `the listing refused: ${JSON.stringify(res.error)}`).toBe(
    true,
  );
  return res.data.data.map((item) => item.id).filter((id) => mine.has(id));
}

async function searched(query: Record<string, string>): Promise<string[]> {
  const res = await client.search(WORD, {
    source: ctx.source,
    limit: 100,
    ...query,
  });
  expect(res.ok, `the search refused: ${JSON.stringify(res.error)}`).toBe(true);
  return res.data.data.map((hit) => hit.item.id).filter((id) => mine.has(id));
}

async function exported(query: Record<string, string>): Promise<string[]> {
  const res = await client.exportItems({ source: ctx.source, ...query });
  expect(res.ok, `the export refused: ${JSON.stringify(res.error)}`).toBe(true);
  return res.data
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { item?: MarfaItem })
    .flatMap((parsed) =>
      parsed.item && mine.has(parsed.item.id) ? [parsed.item.id] : [],
    );
}

async function counted(
  query: Record<string, string>,
): Promise<Record<string, number>> {
  const params = new URLSearchParams({ source: ctx.source, ...query });
  const res = await client.rawRequest<Record<string, number>>(
    `/items/stats?${params.toString()}`,
  );
  expect(res.ok, `the count refused: ${JSON.stringify(res.error)}`).toBe(true);
  return res.data;
}

describe("a type list", () => {
  it("answers the items of any type it names, on every door", async () => {
    const both = "core.note,core.task";
    // The bookmark is the witness: it is in every answer below with no
    // `type`, so its absence is the list narrowing.
    expect(
      await listed({}),
      "the listing does not answer the bookmark unfiltered, so its absence below proves nothing",
    ).toContain(liveBookmark.id);
    expect(
      sorted(await listed({ type: both })),
      "the listing did not answer exactly the active rows of both types",
    ).toEqual(sorted([liveNote.id, liveTask.id]));
    expect(
      sorted(await searched({ type: both })),
      "the search did not match exactly the active rows of both types",
    ).toEqual(sorted([liveNote.id, liveTask.id]));
    expect(
      sorted(await exported({ type: both })),
      "the export did not carry exactly the rows of both types outside the bin",
    ).toEqual(sorted([liveNote.id, filedNote.id, liveTask.id, filedTask.id]));
    expect(
      await counted({ type: both, by: "type", state: "active" }),
      "the count did not group exactly the active rows of both types",
    ).toEqual({ "core.note": 1, "core.task": 1 });
  });

  it("refuses the list for an entry it would refuse alone", async () => {
    const list = "core.note,core.nosuchtype";
    for (const [door, res] of [
      ["listing", await client.listItems({ source: ctx.source, type: list })],
      ["search", await client.search(WORD, { type: list })],
      ["export", await client.exportItems({ type: list })],
      [
        "count",
        await client.rawRequest(
          `/items/stats?type=${encodeURIComponent(list)}`,
        ),
      ],
    ] as const) {
      expect(
        res.ok,
        `the ${door} answered a list holding an unregistered type, so a typo in one entry narrows the answer silently`,
      ).toBe(false);
      expect(
        res.error?.error.code,
        `the ${door} refused with the wrong code`,
      ).toBe("unknown_type");
    }
  });

  it("refuses more than ten entries", async () => {
    const eleven = Array.from(
      { length: 11 },
      (_, i) => `acme${String(i)}.*`,
    ).join(",");
    const ten = eleven.split(",").slice(0, 10).join(",");
    const accepted = await client.listItems({ source: ctx.source, type: ten });
    expect(
      accepted.ok,
      "a list of ten wildcards is refused, so the refusal below is not about the count",
    ).toBe(true);
    const res = await client.listItems({ source: ctx.source, type: eleven });
    expect(res.ok, "a list of eleven types was answered").toBe(false);
    expect(res.error?.error.code).toBe("validation_error");
  });

  it("drops blank entries and repeats before it counts the list", async () => {
    const eleven = Array.from({ length: 11 }, () => "core.note").join(",");
    for (const type of ["core.note,", ",core.note, ", eleven]) {
      expect(
        sorted(await listed({ type })),
        `${type} did not answer exactly the active note`,
      ).toEqual([liveNote.id]);
    }
  });
});

describe("a state list", () => {
  it("answers the rows in any state it names, on every door", async () => {
    const both = "active,archived";
    expect(
      sorted(await listed({ state: both })),
      "the listing did not answer exactly the active and archived rows",
    ).toEqual(
      sorted([
        liveNote.id,
        filedNote.id,
        liveTask.id,
        filedTask.id,
        liveBookmark.id,
      ]),
    );
    expect(
      sorted(await searched({ state: both })),
      "the search did not match exactly the active and archived rows",
    ).toEqual(
      sorted([
        liveNote.id,
        filedNote.id,
        liveTask.id,
        filedTask.id,
        liveBookmark.id,
      ]),
    );
    expect(
      sorted(await exported({ state: "archived,trashed" })),
      "the export did not carry exactly the archived and binned rows",
    ).toEqual(sorted([filedNote.id, filedTask.id, binnedNote.id]));
    expect(
      await counted({ state: "archived,trashed" }),
      "the count did not group exactly the archived and binned rows",
    ).toEqual({ archived: 2, trashed: 1 });
  });

  it("never matches the bin on the search door, even when the list names it", async () => {
    const ids = await searched({ state: "archived,trashed" });
    expect(
      ids,
      "the archived rows are not matched, so the absence of the bin below proves nothing",
    ).toContain(filedNote.id);
    expect(ids, "a search matched a row in the bin").not.toContain(
      binnedNote.id,
    );
  });

  it("combines with a type list", async () => {
    expect(
      sorted(
        await listed({
          state: "active,archived",
          type: "core.task,core.bookmark",
        }),
      ),
    ).toEqual(sorted([liveTask.id, filedTask.id, liveBookmark.id]));
  });

  it("refuses any beside another state, and a list with no state in it", async () => {
    for (const state of ["any,active", "", ",", " , "]) {
      for (const [door, res] of [
        ["listing", await client.listItems({ source: ctx.source, state })],
        ["search", await client.search(WORD, { state })],
        ["export", await client.exportItems({ state })],
        [
          "count",
          await client.rawRequest(
            `/items/stats?state=${encodeURIComponent(state)}`,
          ),
        ],
      ] as const) {
        expect(
          res.ok,
          `the ${door} answered state=${JSON.stringify(state)}, so a filter that names nothing coherent reads as a selection`,
        ).toBe(false);
        expect(
          res.error?.error.code,
          `the ${door} refused state=${JSON.stringify(state)} with the wrong code`,
        ).toBe("validation_error");
      }
    }
  });

  it("refuses a list holding a value that is not a state", async () => {
    const res = await client.listItems({
      source: ctx.source,
      state: "active,nonsense",
    });
    expect(res.ok, "a list with an off-enum entry was answered").toBe(false);
    expect(res.error?.error.code).toBe("validation_error");
  });
});

describe("the page limit", () => {
  it("counts only the rows the state and type lists keep", async () => {
    // The two newest rows, the bookmark and the live task, are rows the
    // lists leave out, and the archived task is the newest they keep: a
    // limit applied before the filter would answer an empty page or one of
    // those two.
    const first = await client.listItems({
      source: ctx.source,
      state: "archived,trashed",
      type: "core.task,core.note",
      limit: 1,
      sort: "created_at",
      direction: "desc",
    });
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    expect(
      first.data.data.map((item) => item.id),
      "a page of one did not hold the newest row the lists keep",
    ).toEqual([filedTask.id]);
    expect(
      first.data.next_cursor,
      "a page of one with more matching rows reported no next page",
    ).not.toBeNull();

    const hits = await client.search(WORD, {
      source: ctx.source,
      state: "active,archived",
      type: "core.note",
      limit: 1,
    });
    expect(hits.ok, JSON.stringify(hits.error)).toBe(true);
    expect(
      hits.data.data.map((hit) => hit.item.id),
      "a search page of one held no row or a row the lists leave out",
    ).toHaveLength(1);
    expect([liveNote.id, filedNote.id]).toContain(hits.data.data[0]?.item.id);
  });
});
