import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "timestamp"));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Return an ISO 8601 timestamp N days in the past */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("timestamp compliance", () => {
  it("create with timestamp preserves the value", async () => {
    const ts = daysAgo(7);
    const note = createNote({ source: ctx.source, timestamp: ts });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    expect(r.data.item.timestamp).toBe(ts);
    const createdMs = new Date(r.data.item.created_at).getTime();
    const tsMs = new Date(ts).getTime();
    expect(createdMs).toBeGreaterThan(tsMs);
  });

  it("create without timestamp defaults to created_at", async () => {
    const note = createNote({ source: ctx.source });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    expect(typeof r.data.item.timestamp).toBe("string");
    expect(r.data.item.timestamp).toBe(r.data.item.created_at);
  });

  it("timestamp persists on fetch", async () => {
    const ts = daysAgo(3);
    const note = createNote({ source: ctx.source, timestamp: ts });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    const fetched = await client.getItem(r.data.item.id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.timestamp).toBe(ts);
  });

  it("COALESCE ordering: orderBy=timestamp uses timestamp then created_at", async () => {
    const noteA = createNote({ source: ctx.source, timestamp: daysAgo(3) });
    const a = await client.createItem(noteA);
    expect(a.ok).toBe(true);
    trackItem(ctx, a.data.item.id);

    // B carries no timestamp, so its effective date is created_at.
    const noteB = createNote({ source: ctx.source });
    const b = await client.createItem(noteB);
    expect(b.ok).toBe(true);
    trackItem(ctx, b.data.item.id);

    const noteC = createNote({ source: ctx.source, timestamp: daysAgo(1) });
    const c = await client.createItem(noteC);
    expect(c.ok).toBe(true);
    trackItem(ctx, c.data.item.id);

    // List descending by timestamp — expected order: B (now), C (1d), A (3d).
    // Scope to ctx.source so a busy server (lots of core.note items from
    // sibling suites) doesn't push C and A out of the result page.
    const list = await client.listItems({
      type: "core.note",
      source: ctx.source,
      sort: "timestamp",
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

  it("timestamp_after filter uses COALESCE(timestamp, created_at)", async () => {
    const ts = daysAgo(5);
    const note = createNote({ source: ctx.source, timestamp: ts });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    // timestamp_after=6d ago — item's effective date (5d ago) is after, so included
    const included = await client.listItems({
      type: "core.note",
      timestamp_after: daysAgo(6),
      limit: 200,
    });
    expect(included.ok).toBe(true);
    const includedIds = included.data.data.map((i) => i.id);
    expect(includedIds).toContain(r.data.item.id);

    // timestamp_after=4d ago — item's effective date (5d ago) is before, so excluded
    const excluded = await client.listItems({
      type: "core.note",
      timestamp_after: daysAgo(4),
      limit: 200,
    });
    expect(excluded.ok).toBe(true);
    const excludedIds = excluded.data.data.map((i) => i.id);
    expect(excludedIds).not.toContain(r.data.item.id);
  });

  it("timestamp_before filter uses COALESCE(timestamp, created_at)", async () => {
    const ts = daysAgo(5);
    const note = createNote({ source: ctx.source, timestamp: ts });
    const r = await client.createItem(note);
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);

    // timestamp_before=6d ago — item's effective date (5d ago) is after the cutoff, so excluded
    const excluded = await client.listItems({
      type: "core.note",
      timestamp_before: daysAgo(6),
      limit: 200,
    });
    expect(excluded.ok).toBe(true);
    const excludedIds = excluded.data.data.map((i) => i.id);
    expect(excludedIds).not.toContain(r.data.item.id);

    // timestamp_before=4d ago — item's effective date (5d ago) is before the cutoff, so included
    const included = await client.listItems({
      type: "core.note",
      timestamp_before: daysAgo(4),
      limit: 200,
    });
    expect(included.ok).toBe(true);
    const includedIds = included.data.data.map((i) => i.id);
    expect(includedIds).toContain(r.data.item.id);
  });

  it("both bounds include an item sitting exactly on them", async () => {
    // A distinct instant per run, so a bound set to it can only be answered
    // by this row and not by a sibling that happens to share a whole second.
    const exact = new Date(
      Date.UTC(2001, 0, 1) + Number.parseInt(ctx.runId.slice(1, 7), 16),
    ).toISOString();

    const r = await client.createItem(
      createNote({ source: ctx.source, timestamp: exact }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.timestamp).toBe(exact);

    const after = await client.listItems({
      type: "core.note",
      source: ctx.source,
      timestamp_after: exact,
      limit: 200,
    });
    expect(after.ok).toBe(true);
    expect(after.data.data.map((i) => i.id)).toContain(r.data.item.id);

    const before = await client.listItems({
      type: "core.note",
      source: ctx.source,
      timestamp_before: exact,
      limit: 200,
    });
    expect(before.ok).toBe(true);
    expect(before.data.data.map((i) => i.id)).toContain(r.data.item.id);
  });

  it("timestamp does not affect created_at ordering", async () => {
    const noteOld = createNote({ source: ctx.source, timestamp: daysAgo(30) });
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
