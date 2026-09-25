/**
 * The instant columns as the write path maintains them.
 *
 * `instant-columns.test.ts` covers the normalizer in isolation. This
 * covers the thing that has actually broken before: a column that agrees
 * with the row on the write that created it and then drifts, because a
 * later write path forgot to recompute it. Every assertion reads the
 * stored column back rather than an API response, since the API never
 * shows it and a stale value is invisible from outside.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { Storage } from "./interface.js";

let ctx: TestContext;
let memberKey: string;

interface InstantRow {
  starts_at: string | null;
  ends_at: string | null;
}

async function readColumns(
  storage: Storage,
  id: string,
): Promise<InstantRow | undefined> {
  const sqlite = storage as unknown as {
    __sqliteAll: (q: string) => Promise<unknown[]>;
  };
  const rows = (await sqlite.__sqliteAll(
    `SELECT starts_at, ends_at FROM items WHERE id = '${id}'`,
  )) as InstantRow[];
  return rows[0];
}

async function createItem(
  properties: Record<string, unknown>,
  type = "core.event",
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: memberKey,
    body: { type, properties },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function patchItem(
  id: string,
  properties: Record<string, unknown>,
  version: number,
): Promise<void> {
  const res = await request(ctx.app, "PATCH", `/items/${id}`, {
    key: memberKey,
    body: { properties, version },
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  ctx = await createTestContext();
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: {
      label: "instant-columns-write",
      source: "instant-columns-src",
      type_permissions: { "*": "write" },
    },
  });
  ({ key: memberKey } = (await res.json()) as { key: string });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("the instant columns on the write path", () => {
  it("normalizes an offset-bearing time on create", async () => {
    const id = await createItem({
      title: "Berlin standup",
      starts_at: "2026-03-24T09:00:00+01:00",
      ends_at: "2026-03-24T09:30:00+01:00",
    });
    expect(await readColumns(ctx.storage, id)).toEqual({
      starts_at: "2026-03-24T08:00:00.000Z",
      ends_at: "2026-03-24T08:30:00.000Z",
    });
  });

  it("follows the property when a patch moves the event", async () => {
    const id = await createItem({
      title: "Moving meeting",
      starts_at: "2026-04-01T09:00:00.000Z",
    });
    await patchItem(id, { starts_at: "2026-04-02T15:00:00+02:00" }, 1);
    expect((await readColumns(ctx.storage, id))?.starts_at).toBe(
      "2026-04-02T13:00:00.000Z",
    );
  });

  it("nulls the column when a write clears the property", async () => {
    // The failure this pins is the quiet one: a merge that leaves the
    // old column behind puts the event back on a calendar it is no
    // longer on. A replace that leaves the fields out clears them.
    const id = await createItem({
      title: "Undated",
      starts_at: "2026-04-05T09:00:00.000Z",
      ends_at: "2026-04-05T10:00:00.000Z",
    });
    await ctx.storage.items.update(id, {
      properties: { title: "Undated" },
      properties_mode: "replace",
    });
    expect(await readColumns(ctx.storage, id)).toEqual({
      starts_at: null,
      ends_at: null,
    });
  });

  it("leaves the column alone when a patch sends a null that means nothing", async () => {
    // A null on an optional field means "leave unset", so the property
    // survives and the column has to survive with it. The column agreeing with the row is the whole
    // invariant; agreeing with the request body would break it here.
    const id = await createItem({
      title: "Still dated",
      starts_at: "2026-04-06T09:00:00.000Z",
    });
    await patchItem(id, { starts_at: null }, 1);
    expect((await readColumns(ctx.storage, id))?.starts_at).toBe(
      "2026-04-06T09:00:00.000Z",
    );
  });

  it("refuses junk in a declared datetime field, and tolerates it elsewhere", async () => {
    // Two different guarantees, and the column depends on both. A field
    // declared as a datetime is validated at write time, so junk never
    // reaches the column through the API at all — that refusal is what
    // makes the column trustworthy for the types the calendar reads.
    const refused = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: {
        type: "core.event",
        properties: {
          title: "Dated from memory, badly",
          starts_at: "some time last spring",
        },
      },
    });
    expect(refused.status).toBe(400);

    // Nothing declares the field on a note, so it arrives as an ordinary
    // unknown property and no format check applies. The column is keyed
    // on the field being present, not on the type, so the helper still
    // has to answer null rather than take the write down — which is also
    // the shape of any row written before the grammar existed.
    const undeclared = await createItem(
      { body: "a note", starts_at: "some time last spring" },
      "core.note",
    );
    expect(await readColumns(ctx.storage, undeclared)).toEqual({
      starts_at: null,
      ends_at: null,
    });
  });

  it("maintains the columns for any type carrying the fields", async () => {
    // Keyed on the field, not on the type: nothing enumerates which
    // types are events, so a type that grows a `starts_at` is on the
    // calendar without a code change.
    const id = await createItem(
      { body: "a note that names a time", starts_at: "2026-05-05T09:00:00Z" },
      "core.note",
    );
    expect((await readColumns(ctx.storage, id))?.starts_at).toBe(
      "2026-05-05T09:00:00.000Z",
    );
  });

  it("narrows a list read to the window, in SQL", async () => {
    // The filters are asserted against the store rather than through
    // `/occurrences`, because that route keeps an in-memory window
    // check as a belt: a filter that silently did nothing would still
    // produce the right calendar, and the read would still be the whole
    // corpus. This is the only place the narrowing itself is visible.
    const before = await createItem({
      title: "narrowing: an hour before, in +02:00",
      starts_at: "2028-01-01T01:00:00+02:00",
    });
    const inside = await createItem({
      title: "narrowing: inside, in Z",
      starts_at: "2028-01-01T00:30:00.000Z",
    });
    const after = await createItem({
      title: "narrowing: on the exclusive end",
      starts_at: "2028-01-02T00:00:00.000Z",
    });

    const page = await ctx.storage.items.list({
      type: "core.event",
      state: "active",
      startsAtFrom: "2028-01-01T00:00:00.000Z",
      startsAtTo: "2028-01-02T00:00:00.000Z",
    });
    const ids = page.data.map((item) => item.id);
    expect(ids).toContain(inside);
    // The lower bound is inclusive and the upper exclusive, and both are
    // read as instants rather than as the strings they were stored in.
    expect(ids).not.toContain(before);
    expect(ids).not.toContain(after);
  });

  it("narrows a list read to rows carrying a property key", async () => {
    const withRule = await createItem({
      title: "has-property: a series",
      starts_at: "2028-02-07T09:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    const plain = await createItem({
      title: "has-property: a one-off",
      starts_at: "2028-02-08T09:00:00.000Z",
    });

    const page = await ctx.storage.items.list({
      type: "core.event",
      state: "active",
      hasProperty: "recurrence",
    });
    const ids = page.data.map((item) => item.id);
    expect(ids).toContain(withRule);
    expect(ids).not.toContain(plain);
  });

  it("is recomputed by the three-way merge path too", async () => {
    // A patch carrying a stale `version` takes the conflict-merge
    // branch, which is a second UPDATE with its own set clause. It was
    // the one that would go stale unnoticed.
    const id = await createItem({
      title: "Concurrently edited",
      starts_at: "2026-06-01T09:00:00.000Z",
    });
    await patchItem(id, { title: "Concurrently edited, renamed" }, 1);
    // Version 1 is now stale; the merge resolves against the snapshot.
    await patchItem(id, { starts_at: "2026-06-08T11:00:00+02:00" }, 1);
    expect((await readColumns(ctx.storage, id))?.starts_at).toBe(
      "2026-06-08T09:00:00.000Z",
    );
  });
});
