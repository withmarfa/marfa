/**
 * The reads a client makes when it comes back after being away.
 *
 * A durable client holds a cursor and asks two questions on reconnect:
 * what changed since this moment, and what state is everything in now.
 * Neither was answerable. The only time filter read the item's own
 * user-meaningful time rather than when the row changed, so a client that
 * had been away could not narrow at all, and a listing that omits its
 * state silently drops trashed rows, so the one fact a client most needs
 * in order to prune its local copy was the one it could not see.
 *
 * `updated_after` is that filter and `state=any` is that listing.
 *
 * **Every assertion here is on which rows come back, never on a status
 * code alone.** An unknown query key is stripped rather than refused, so
 * the failure this feature exists to prevent looks exactly like success:
 * `200`, a well-formed page, and the whole corpus in it. A test that
 * checked only the status would pass against a server that ignored the
 * parameter entirely.
 *
 * Runs on whichever dialect the suite is pointed at. The predicate and
 * the ordering are written once per dialect and the two have disagreed
 * before.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * Forces a row's modification time. Every write path stamps `now`, so a
 * contrived value is the only way to place rows either side of a bound
 * and the only way to make a tie happen on purpose rather than when the
 * clock happens to oblige.
 */
async function forceItemUpdatedAt(id: string, iso: string): Promise<void> {
  const s = ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
  };
  await s.__sqliteRun("UPDATE items SET updated_at = ? WHERE id = ?", [
    iso,
    id,
  ]);
}

async function forceEdgeUpdatedAt(id: string, iso: string): Promise<void> {
  const s = ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
  };
  await s.__sqliteRun("UPDATE edges SET updated_at = ? WHERE id = ?", [
    iso,
    id,
  ]);
}

async function seedNote(body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

interface Page {
  data: { id: string }[];
  cursor: string | null;
  has_more: boolean;
}

async function listItems(query: string): Promise<Page> {
  const res = await request(ctx.app, "GET", `/items?${query}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

/** Ids on one page, in the order the server returned them. */
async function idsFrom(query: string): Promise<string[]> {
  return (await listItems(query)).data.map((i) => i.id);
}

/** Old enough that nothing else in the corpus can be confused with it. */
const EPOCH = "2001-01-01T00:00:00.000Z";
const BOUND = "2001-06-01T00:00:00.000Z";

/**
 * A row parked before the bound and never touched again.
 *
 * Every "a write of this kind is visible to a catch-up" test needs one.
 * Without it the assertion is `toContain`, which a server that ignores
 * the filter and returns the whole corpus satisfies perfectly — so the
 * test would report on the dependency it exists to check while proving
 * nothing about it. The control is the half that fails in that case.
 */
async function seedControl(label: string): Promise<string> {
  const id = await seedNote(`control-${label}`);
  await forceItemUpdatedAt(id, EPOCH);
  return id;
}

describe("updated_after on GET /items", () => {
  it("returns the rows at or after the bound and excludes the ones before", async () => {
    const before = await seedNote("catchup-before");
    const at = await seedNote("catchup-at");
    const after = await seedNote("catchup-after");
    await forceItemUpdatedAt(before, "2001-05-31T23:59:59.999Z");
    await forceItemUpdatedAt(at, BOUND);
    await forceItemUpdatedAt(after, "2001-06-01T00:00:00.001Z");

    const ids = await idsFrom(
      `updated_after=${encodeURIComponent(BOUND)}&limit=200`,
    );

    // The row exactly on the bound is included: the read is inclusive and
    // the client dedupes by id. A strict comparison loses every row that
    // shares the cursor's millisecond, which after a bulk write is most
    // of them.
    expect(ids).toContain(at);
    expect(ids).toContain(after);
    // And the assertion that a stripped parameter would fail: the row
    // before the bound is absent. Without it this test passes against a
    // server that ignores the filter and returns the whole corpus.
    expect(ids).not.toContain(before);
  });

  it("keeps every row of a tie and pages across the boundary without losing one", async () => {
    // A bulk write stamps many rows in one millisecond, so a tie is the
    // normal case rather than a corner. Five rows sharing an instant,
    // read one page at a time, must arrive exactly once each.
    const control = await seedControl("tie");
    const tied: string[] = [];
    for (let i = 0; i < 5; i++) tied.push(await seedNote(`tie-${String(i)}`));
    for (const id of tied)
      await forceItemUpdatedAt(id, "2002-03-03T03:03:03.003Z");

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const q =
        `updated_after=${encodeURIComponent("2002-03-03T03:03:03.003Z")}&limit=2` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const page: Page = await listItems(q);
      seen.push(...page.data.map((i) => i.id));
      cursor = page.has_more ? page.cursor : null;
      if (!cursor) break;
    }

    const tiedSeen = seen.filter((id) => tied.includes(id));
    // Every tied row exactly once. A page boundary that falls inside a
    // tie is where a keyset walk drops or repeats a row, and both
    // failures are invisible in a single-page read.
    expect([...tiedSeen].sort()).toEqual([...tied].sort());
    expect(new Set(tiedSeen).size).toBe(tied.length);
    // And the walk never reached back past the bound, which is what
    // makes the two assertions above about the filter rather than about
    // pagination over the whole corpus.
    expect(seen).not.toContain(control);
  });

  it("orders by modification time and breaks ties on id, ascending", async () => {
    const a = await seedNote("order-a");
    const b = await seedNote("order-b");
    const c = await seedNote("order-c");
    await forceItemUpdatedAt(a, "2003-01-01T00:00:00.000Z");
    await forceItemUpdatedAt(b, "2003-01-01T00:00:00.000Z");
    await forceItemUpdatedAt(c, "2003-01-02T00:00:00.000Z");

    const ids = (
      await idsFrom(
        `updated_after=${encodeURIComponent("2003-01-01T00:00:00.000Z")}&limit=200`,
      )
    ).filter((id) => [a, b, c].includes(id));

    // The tied pair sorts by id between themselves, and the later row
    // comes last. That total order is what makes the cursor resumable —
    // without the id tiebreak two rows sharing an instant have no
    // defined position and a page boundary between them is arbitrary.
    const tiedPair = [a, b].sort();
    expect(ids).toEqual([...tiedPair, c]);
  });
});

describe("what a catch-up can see", () => {
  it("finds an item whose only change was a tag write", async () => {
    const control = await seedControl("tag");
    const id = await seedNote("tagged");
    await forceItemUpdatedAt(id, EPOCH);

    const res = await request(ctx.app, "POST", `/items/${id}/tags`, {
      key: ctx.workingKey,
      body: { tags: ["seen"] },
    });
    expect(res.status).toBe(200);

    const ids = await idsFrom(
      `updated_after=${encodeURIComponent(BOUND)}&limit=200`,
    );
    // Tags live in a sidecar table. A write that moved only that table
    // left the item's modification time behind, so a catch-up filtering
    // on it got back a short list that looked complete.
    expect(ids).toContain(id);
    expect(ids).not.toContain(control);
  });

  it("finds an item whose only change was a property update", async () => {
    const control = await seedControl("update");
    const id = await seedNote("updated");
    await forceItemUpdatedAt(id, EPOCH);

    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: { properties: { body: "updated twice" }, version: 1 },
    });
    expect(res.status).toBe(200);

    const ids = await idsFrom(
      `updated_after=${encodeURIComponent(BOUND)}&limit=200`,
    );
    expect(ids).toContain(id);
    expect(ids).not.toContain(control);
  });

  it("finds an item whose only change was a lifecycle transition", async () => {
    const control = await seedControl("transition");
    const id = await seedNote("transitioned");
    await forceItemUpdatedAt(id, EPOCH);

    const res = await request(ctx.app, "POST", `/items/${id}/transition`, {
      key: ctx.workingKey,
      body: { state: "archived" },
    });
    expect(res.status).toBe(200);

    const ids = await idsFrom(
      `updated_after=${encodeURIComponent(BOUND)}&limit=200`,
    );
    expect(ids).toContain(id);
    expect(ids).not.toContain(control);
  });
});

describe("state=any", () => {
  it("returns trashed rows alongside the rest", async () => {
    const live = await seedNote("state-live");
    const binned = await seedNote("state-binned");
    const res = await request(ctx.app, "POST", `/items/${binned}/transition`, {
      key: ctx.workingKey,
      body: { state: "trashed" },
    });
    expect(res.status).toBe(200);

    const ids = await idsFrom("state=any&limit=200");
    expect(ids).toContain(binned);
    // Both, not just the trashed one: `any` is a widening, and a sentinel
    // that swapped one exclusion for another would satisfy a test that
    // only looked for the bin.
    expect(ids).toContain(live);
  });

  it("leaves the default listing excluding trashed rows", async () => {
    const binned = await seedNote("default-binned");
    const res = await request(ctx.app, "POST", `/items/${binned}/transition`, {
      key: ctx.workingKey,
      body: { state: "trashed" },
    });
    expect(res.status).toBe(200);

    // The other half of the sentinel, and the one a careless
    // implementation breaks: widening the `any` case by relaxing the
    // shared default would make every ordinary listing show the bin.
    expect(await idsFrom("limit=200")).not.toContain(binned);
  });

  it("composes with updated_after so one pass sees a trashed change", async () => {
    const id = await seedNote("catchup-binned");
    await forceItemUpdatedAt(id, EPOCH);
    const res = await request(ctx.app, "POST", `/items/${id}/transition`, {
      key: ctx.workingKey,
      body: { state: "trashed" },
    });
    expect(res.status).toBe(200);

    // The whole point of the pair. A client learning that a row went to
    // the bin is how it prunes its local copy; without `state=any` the
    // transition moves the modification time and then hides the row, so
    // the catch-up reports nothing changed.
    const ids = await idsFrom(
      `state=any&updated_after=${encodeURIComponent(BOUND)}&limit=200`,
    );
    expect(ids).toContain(id);
  });
});

describe("an item cursor knows which ordering issued it", () => {
  it("refuses a catch-up cursor replayed without the filter", async () => {
    // Three rows above the bound, read one at a time, so the first page
    // has to hand back a cursor.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(await seedNote(`item-cursor-${String(i)}`));
    for (const [i, id] of ids.entries())
      await forceItemUpdatedAt(id, `2007-01-0${String(i + 1)}T00:00:00.000Z`);

    const first = await listItems(
      `updated_after=${encodeURIComponent("2007-01-01T00:00:00.000Z")}&limit=1`,
    );
    expect(first.cursor).toBeTruthy();

    const replayed = await request(
      ctx.app,
      "GET",
      `/items?limit=1&cursor=${encodeURIComponent(first.cursor ?? "")}`,
      { key: ctx.workingKey },
    );

    // Dropping the filter while keeping the cursor is the natural client
    // mistake, and both orderings key on an ISO timestamp — so the
    // `updated_at` value compares perfectly well against `created_at`,
    // descending, and returns a page that is simply not the next page.
    // Rows are skipped and repeated with no signal anywhere.
    expect(replayed.status).toBe(400);
    expect(
      ((await replayed.json()) as { error: { message: string } }).error.message,
    ).toContain("ordering");
  });

  it("refuses a default-ordering cursor replayed under the filter", async () => {
    const first = await listItems("limit=1");
    expect(first.cursor).toBeTruthy();

    const replayed = await request(
      ctx.app,
      "GET",
      `/items?updated_after=${encodeURIComponent(EPOCH)}&limit=1&cursor=${encodeURIComponent(first.cursor ?? "")}`,
      { key: ctx.workingKey },
    );

    expect(replayed.status).toBe(400);
    expect(
      ((await replayed.json()) as { error: { message: string } }).error.message,
    ).toContain("ordering");
  });
});

describe("a time bound is read as the instant it names", () => {
  it("keeps a row whose millisecond sits above a second-precision bound", async () => {
    // `updated_at` is always written at millisecond precision and the
    // comparison is lexical over text, so `...:05Z` sorts *above*
    // `...:05.500Z` — `Z` is 90 and `.` is 46. A caller sending a
    // perfectly valid RFC 3339 instant loses up to a full second of
    // changes, with a 200 and a well-formed page.
    const control = await seedControl("second-precision");
    const id = await seedNote("second-precision-target");
    await forceItemUpdatedAt(id, "2005-05-05T05:05:05.500Z");

    const ids = await idsFrom(
      `updated_after=${encodeURIComponent("2005-05-05T05:05:05Z")}&limit=200`,
    );
    expect(ids).toContain(id);
    expect(ids).not.toContain(control);
  });

  it("does not over-match an offset-bearing bound", async () => {
    // `2006-06-06T12:00:00-01:00` is 13:00 UTC, so a row at 12:30 UTC
    // precedes it and must not come back. Compared as text the bound
    // reads as "12:00:00…" and the row is admitted, which is the same
    // defect pointing the other way.
    const id = await seedNote("offset-bound-target");
    await forceItemUpdatedAt(id, "2006-06-06T12:30:00.000Z");

    const ids = await idsFrom(
      `updated_after=${encodeURIComponent("2006-06-06T12:00:00-01:00")}&limit=200`,
    );
    expect(ids).not.toContain(id);
  });

  it("refuses a bound that is not a timestamp at all", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?updated_after=yesterday",
      {
        key: ctx.workingKey,
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).not.toHaveProperty("data");
  });

  it("applies to the item's own time bounds too", async () => {
    const id = await seedNote("occurred-at-bound-target");
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: { occurred_at: "2008-08-08T08:08:08.500Z", version: 1 },
    });
    expect(res.status).toBe(200);

    const ids = await idsFrom(
      `occurred_after=${encodeURIComponent("2008-08-08T08:08:08Z")}&occurred_before=${encodeURIComponent("2008-08-09T00:00:00Z")}&limit=200`,
    );
    expect(ids).toContain(id);
  });
});

describe("an empty bound is refused rather than widened", () => {
  it("refuses an empty updated_after on GET /items", async () => {
    // The ordering switches on the filter being present and the
    // predicate on it being truthy, so an empty value used to order by
    // `(updated_at, id)` ascending and bound nothing at all — a full
    // corpus walk wearing the shape of a narrow catch-up. A client
    // building `?updated_after=${cursor}` before it holds a cursor sends
    // exactly this.
    const res = await request(
      ctx.app,
      "GET",
      "/items?updated_after=&limit=200",
      { key: ctx.workingKey },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    // The shape, not only the status: a stripped or ignored parameter
    // produces a `data` array, and that is the outcome being guarded.
    expect(body).not.toHaveProperty("data");
  });

  it("refuses an empty updated_after on GET /edges", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/edges?updated_after=&limit=200",
      {
        key: ctx.workingKey,
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).not.toHaveProperty("data");
  });
});

/** Ids on one `/edges` page, in the order the server returned them. */
async function listEdges(query: string): Promise<Page> {
  const res = await request(ctx.app, "GET", `/edges?${query}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

async function seedEdge(source: string, target: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/edges", {
    key: ctx.workingKey,
    body: { source_id: source, target_id: target, edge_type: "references" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { edge: { id: string } }).edge.id;
}

describe("updated_after on GET /edges", () => {
  it("returns the edges at or after the bound and excludes the ones before", async () => {
    const a = await seedNote("edge-src-a");
    const b = await seedNote("edge-tgt-a");
    const c = await seedNote("edge-src-b");
    const d = await seedNote("edge-tgt-b");

    const older = await seedEdge(a, b);
    const newer = await seedEdge(c, d);
    await forceEdgeUpdatedAt(older, "2004-01-01T00:00:00.000Z");
    await forceEdgeUpdatedAt(newer, "2004-12-31T00:00:00.000Z");

    const ids = (
      await listEdges(
        `updated_after=${encodeURIComponent("2004-06-01T00:00:00.000Z")}&limit=200`,
      )
    ).data.map((e) => e.id);

    expect(ids).toContain(newer);
    expect(ids).not.toContain(older);
  });

  it("includes an edge sitting exactly on the bound", async () => {
    // The edge stores reimplement the filter rather than sharing the
    // item store's, so the inclusive boundary has to be asserted on both
    // doors or one of them can drift to a strict comparison and lose
    // every row sharing the cursor's millisecond.
    const a = await seedNote("edge-bound-src");
    const b = await seedNote("edge-bound-tgt");
    const c = await seedNote("edge-bound-src-2");

    const on = await seedEdge(a, b);
    const before = await seedEdge(a, c);
    await forceEdgeUpdatedAt(on, "2009-09-09T09:09:09.000Z");
    await forceEdgeUpdatedAt(before, "2009-09-09T09:09:08.999Z");

    const ids = (
      await listEdges(
        `updated_after=${encodeURIComponent("2009-09-09T09:09:09.000Z")}&limit=200`,
      )
    ).data.map((e) => e.id);

    expect(ids).toContain(on);
    expect(ids).not.toContain(before);
  });

  it("keeps every edge of a tie and pages across the boundary without losing one", async () => {
    const anchor = await seedNote("edge-tie-anchor");
    const targets: string[] = [];
    for (let i = 0; i < 5; i++)
      targets.push(await seedNote(`edge-tie-target-${String(i)}`));

    const controlTarget = await seedNote("edge-tie-control-target");
    const control = await seedEdge(anchor, controlTarget);
    await forceEdgeUpdatedAt(control, "2001-01-01T00:00:00.000Z");

    const tied: string[] = [];
    for (const t of targets) tied.push(await seedEdge(anchor, t));
    for (const id of tied)
      await forceEdgeUpdatedAt(id, "2010-10-10T10:10:10.010Z");

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const q =
        `updated_after=${encodeURIComponent("2010-10-10T10:10:10.010Z")}&limit=2` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const page: Page = await listEdges(q);
      seen.push(...page.data.map((e) => e.id));
      cursor = page.has_more ? page.cursor : null;
      if (!cursor) break;
    }

    const tiedSeen = seen.filter((id) => tied.includes(id));
    expect([...tiedSeen].sort()).toEqual([...tied].sort());
    expect(new Set(tiedSeen).size).toBe(tied.length);
    expect(seen).not.toContain(control);
  });
});
