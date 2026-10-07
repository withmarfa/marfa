import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote, generateId } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "occurred-at"));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Return an ISO 8601 instant N days in the past */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("occurred_at compliance", () => {
  it("create with occurred_at preserves the value", async () => {
    const ts = daysAgo(7);
    const note = createNote({ source: ctx.source, occurred_at: ts });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    expect(r.data.item.occurred_at).toBe(ts);
    const createdMs = new Date(r.data.item.created_at).getTime();
    const tsMs = new Date(ts).getTime();
    expect(createdMs).toBeGreaterThan(tsMs);
  });

  it("refuses an occurred_at that is not a timestamp, naming the field", async () => {
    const sourceId = `occurred-bad-${generateId()}`;
    const refused = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        occurred_at: "last tuesday",
      }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.message).toContain("occurred_at");

    // The witness, and the proof nothing was written: the same natural key
    // with a timestamp lands as a new row.
    const accepted = await client.createItem(
      createNote({
        source: ctx.source,
        source_id: sourceId,
        occurred_at: daysAgo(1),
      }),
    );
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(201);
    trackItem(ctx, accepted.data.item.id);
  });

  it("reads a zone-less occurred_at as UTC", async () => {
    const created = await client.createItem(
      createNote({ source: ctx.source, occurred_at: "2026-04-01T07:00:00" }),
    );
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    trackItem(ctx, created.data.item.id);
    expect(created.data.item.occurred_at).toBe("2026-04-01T07:00:00.000Z");

    const read = await client.getItem(created.data.item.id);
    expect(read.data.item.occurred_at).toBe("2026-04-01T07:00:00.000Z");
  });

  it("create without occurred_at defaults to created_at", async () => {
    const note = createNote({ source: ctx.source });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    expect(typeof r.data.item.occurred_at).toBe("string");
    expect(r.data.item.occurred_at).toBe(r.data.item.created_at);
  });

  it("occurred_at persists on fetch", async () => {
    const ts = daysAgo(3);
    const note = createNote({ source: ctx.source, occurred_at: ts });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.occurred_at).toBe(ts);
  });

  it("COALESCE ordering: sort=occurred_at uses occurred_at then created_at", async () => {
    const noteA = createNote({ source: ctx.source, occurred_at: daysAgo(3) });
    const a = await client.createItem(noteA);
    expect(a.ok).toBe(true);
    trackItem(ctx, a.data.item.id);

    // B carries no occurred_at, so its effective date is created_at.
    const noteB = createNote({ source: ctx.source });
    const b = await client.createItem(noteB);
    expect(b.ok).toBe(true);
    trackItem(ctx, b.data.item.id);

    const noteC = createNote({ source: ctx.source, occurred_at: daysAgo(1) });
    const c = await client.createItem(noteC);
    expect(c.ok).toBe(true);
    trackItem(ctx, c.data.item.id);

    // List descending by occurred_at — expected order: B (now), C (1d), A (3d).
    // Scope to ctx.source so a busy server (lots of core.note items from
    // sibling suites) doesn't push C and A out of the result page.
    const list = await client.listItems({
      type: "core.note",
      source: ctx.source,
      sort: "occurred_at",
      direction: "desc",
      limit: 100,
    });
    expect(list.ok).toBe(true);

    const ids = list.data.data.map((i) => i.id);
    const idxA = ids.indexOf(a.data.item.id);
    const idxB = ids.indexOf(b.data.item.id);
    const idxC = ids.indexOf(c.data.item.id);
    expect(idxA).not.toBe(-1);
    expect(idxB).not.toBe(-1);
    expect(idxC).not.toBe(-1);

    expect(idxB).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxA);
  });

  it("occurred_after filter uses COALESCE(occurred_at, created_at)", async () => {
    const ts = daysAgo(5);
    const note = createNote({ source: ctx.source, occurred_at: ts });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    // occurred_after=6d ago — item's effective date (5d ago) is after, so included
    const included = await client.listItems({
      type: "core.note",
      occurred_after: daysAgo(6),
      limit: 200,
    });
    expect(included.ok).toBe(true);
    const includedIds = included.data.data.map((i) => i.id);
    expect(includedIds).toContain(r.data.item.id);

    // occurred_after=4d ago — item's effective date (5d ago) is before, so excluded
    const excluded = await client.listItems({
      type: "core.note",
      occurred_after: daysAgo(4),
      limit: 200,
    });
    expect(excluded.ok).toBe(true);
    const excludedIds = excluded.data.data.map((i) => i.id);
    expect(excludedIds).not.toContain(r.data.item.id);
  });

  it("occurred_before filter uses COALESCE(occurred_at, created_at)", async () => {
    const ts = daysAgo(5);
    const note = createNote({ source: ctx.source, occurred_at: ts });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    // occurred_before=6d ago — item's effective date (5d ago) is after the cutoff, so excluded
    const excluded = await client.listItems({
      type: "core.note",
      occurred_before: daysAgo(6),
      limit: 200,
    });
    expect(excluded.ok).toBe(true);
    const excludedIds = excluded.data.data.map((i) => i.id);
    expect(excludedIds).not.toContain(r.data.item.id);

    // occurred_before=4d ago — item's effective date (5d ago) is before the cutoff, so included
    const included = await client.listItems({
      type: "core.note",
      occurred_before: daysAgo(4),
      limit: 200,
    });
    expect(included.ok).toBe(true);
    const includedIds = included.data.data.map((i) => i.id);
    expect(includedIds).toContain(r.data.item.id);
  });

  it("both bounds exclude an item sitting exactly on them", async () => {
    // Three rows, because two of them cannot tell the failures apart. The
    // boundary row proves the comparison is strict rather than inclusive;
    // the row inside the range proves the predicate reached the query at
    // all, because a dropped bound and a bound that excluded everything
    // both leave the boundary row absent; the far row proves the bound is
    // narrowing in the direction it claims.
    //
    // A distinct base instant per run, so a bound set to it can only be
    // answered by these rows and not by a sibling from another run that
    // happens to share a whole second.
    const base =
      Date.UTC(2001, 0, 1) + Number.parseInt(ctx.runId.slice(1, 7), 16);
    const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();

    const seed = async (offsetMs: number): Promise<string> => {
      const r = await client.createItem(
        createNote({ source: ctx.source, occurred_at: at(offsetMs) }),
      );
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
      expect(r.data.item.occurred_at).toBe(at(offsetMs));
      return r.data.item.id;
    };

    const earlier = await seed(-1000);
    const onBound = await seed(0);
    const later = await seed(1000);

    const ids = async (bound: Record<string, string>): Promise<string[]> => {
      const page = await client.listItems({
        type: "core.note",
        source: ctx.source,
        limit: 200,
        ...bound,
      });
      expect(page.ok).toBe(true);
      // The page has to be whole, or an absence below is a truncation
      // rather than a bound.
      expect(
        page.data.next_cursor,
        "the page was truncated, so a row missing from it proves nothing about the bound",
      ).toBeNull();
      return page.data.data.map((i) => i.id);
    };

    const afterBound = await ids({ occurred_after: at(0) });
    expect(
      afterBound,
      "a row whose own time is exactly the lower bound came back, so the bound is inclusive where the rule says exclusive",
    ).not.toContain(onBound);
    expect(
      afterBound,
      "a row after the lower bound was missing, so the bound is being dropped or is narrowing the wrong way",
    ).toContain(later);
    expect(afterBound).not.toContain(earlier);

    const beforeBound = await ids({ occurred_before: at(0) });
    expect(
      beforeBound,
      "a row whose own time is exactly the upper bound came back, so the bound is inclusive where the rule says exclusive",
    ).not.toContain(onBound);
    expect(
      beforeBound,
      "a row before the upper bound was missing, so the bound is being dropped or is narrowing the wrong way",
    ).toContain(earlier);
    expect(beforeBound).not.toContain(later);
  });

  it("occurred_at does not affect created_at ordering", async () => {
    const noteOld = createNote({
      source: ctx.source,
      occurred_at: daysAgo(30),
    });
    const old = await client.createItem(noteOld);
    expect(old.ok).toBe(true);
    trackItem(ctx, old.data.item.id);

    const noteNew = createNote({ source: ctx.source });
    const newer = await client.createItem(noteNew);
    expect(newer.ok).toBe(true);
    trackItem(ctx, newer.data.item.id);

    const list = await client.listItems({
      type: "core.note",
      source: ctx.source,
      sort: "created_at",
      direction: "desc",
      limit: 100,
    });
    expect(list.ok).toBe(true);

    const ids = list.data.data.map((i) => i.id);
    const idxOld = ids.indexOf(old.data.item.id);
    const idxNew = ids.indexOf(newer.data.item.id);
    expect(idxOld).not.toBe(-1);
    expect(idxNew).not.toBe(-1);

    expect(idxNew).toBeLessThan(idxOld);
  });
});
