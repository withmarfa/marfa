import { afterEach, expect, it } from "vitest";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { itemWrites } from "../item-writes.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx.cleanup();
});

type Run = (sql: string, params: unknown[]) => Promise<unknown>;

function sqliteRun(): Run {
  return (ctx.storage as unknown as { __sqliteRun: Run }).__sqliteRun;
}

async function note(title: string, id: string): Promise<string> {
  const made = await itemWrites(ctx.storage).create({
    writer: null,
    id,
    type: "core.note",
    source: "test",
    properties: { title },
  });
  return made.id;
}

const at = (n: number): string =>
  `01900000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function parentOf(parent: string, child: string, n: number) {
  // Written directly: the edge door refuses a cycle, and a walk has to end on
  // one that reached the table by another route, such as an import.
  await sqliteRun()(
    `INSERT INTO edges (id, source_id, target_id, edge_type, properties, created_at, updated_at, version)
     VALUES (?, ?, ?, 'parent-of', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`,
    [at(9000 + n), parent, child],
  );
}

async function ids(
  view: Parameters<TestContext["storage"]["items"]["listInView"]>[0],
  limit = 50,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i += 1) {
    const page = await ctx.storage.items.listInView(view, { limit, cursor });
    out.push(...page.data.map((item) => item.id));
    if (page.next_cursor === null) return out;
    cursor = page.next_cursor;
  }
  throw new Error("a listing did not end");
}

it("ends a walk beneath on a parent-of cycle and lists each item once", async () => {
  ctx = await createTestContext();
  const a = await note("A", at(1));
  const b = await note("B", at(2));
  const c = await note("C", at(3));
  const apart = await note("Apart", at(4));
  await parentOf(a, b, 1);
  await parentOf(b, c, 2);
  await parentOf(c, a, 3);
  const sort = [{ by: "title", direction: "asc" as const }];
  const view = (beneath?: string) => ({
    id: "view",
    version: 1,
    query: beneath ? { beneath } : {},
    sort,
    reader: {},
  });
  expect(await ids(view(b), 1)).toEqual([a, b, c]);
  expect(await ids(view())).toEqual([a, apart, b, c]);
});

it("lists an item without the sorted property last in either direction and pages across the gap", async () => {
  ctx = await createTestContext();
  const withValue = await itemWrites(ctx.storage).create({
    writer: null,
    id: at(1),
    type: "core.note",
    source: "test",
    properties: { title: "With", notes: "x" },
  });
  const without = await note("Without", at(2));
  const also = await itemWrites(ctx.storage).create({
    writer: null,
    id: at(3),
    type: "core.note",
    source: "test",
    properties: { title: "Also", notes: "a" },
  });
  for (const [direction, expected] of [
    ["asc", [also.id, withValue.id, without]],
    ["desc", [withValue.id, also.id, without]],
  ] as const) {
    const view = {
      id: "view",
      version: 1,
      query: {},
      sort: [{ by: "properties.notes", direction }],
      reader: {},
    };
    expect(await ids(view, 1)).toEqual(expected);
  }
});

it("refuses more than ten sort keys, a property name that is not one, and a cursor of another version of the view", async () => {
  ctx = await createTestContext();
  await note("One", at(1));
  await note("Two", at(2));
  const tooMany = Array.from({ length: 11 }, () => ({
    by: "title",
    direction: "asc" as const,
  }));
  await expect(
    ctx.storage.items.listInView(
      { id: "v", version: 1, query: {}, sort: tooMany, reader: {} },
      {},
    ),
  ).rejects.toMatchObject({ code: "validation_error" });
  await expect(
    ctx.storage.items.listInView(
      {
        id: "v",
        version: 1,
        query: {},
        sort: [{ by: "properties.a b", direction: "asc" }],
        reader: {},
      },
      {},
    ),
  ).rejects.toMatchObject({ code: "validation_error" });

  const ten = tooMany.slice(0, 10);
  expect(
    (
      await ctx.storage.items.listInView(
        { id: "v", version: 1, query: {}, sort: ten, reader: {} },
        { limit: 1 },
      )
    ).data,
  ).toHaveLength(1);

  const view = { id: "v", version: 1, query: {}, sort: ten, reader: {} };
  const first = await ctx.storage.items.listInView(view, { limit: 1 });
  expect(
    (
      await ctx.storage.items.listInView(view, {
        limit: 1,
        cursor: first.next_cursor!,
      })
    ).data,
  ).toHaveLength(1);
  for (const other of [
    { ...view, version: 2 },
    { ...view, id: "w" },
  ]) {
    await expect(
      ctx.storage.items.listInView(other, { cursor: first.next_cursor! }),
    ).rejects.toMatchObject({ code: "validation_error" });
  }
});

it("orders by a property as GET /items does", async () => {
  ctx = await createTestContext();
  const made: string[] = [];
  for (const [i, notes] of ["c", "a", "b"].entries()) {
    const item = await itemWrites(ctx.storage).create({
      writer: null,
      id: at(i + 1),
      type: "core.note",
      source: "test",
      properties: { title: `N${String(i)}`, notes },
    });
    made.push(item.id);
  }
  for (const [direction, expected] of [
    ["asc", [made[1], made[2], made[0]]],
    ["desc", [made[0], made[2], made[1]]],
  ] as const) {
    const listed = await ctx.storage.items.list({
      sort: "properties.notes",
      direction,
      limit: 10,
    });
    const view = {
      id: "v",
      version: 1,
      query: {},
      sort: [{ by: "properties.notes", direction }],
      reader: {},
    };
    expect(listed.data.map((item) => item.id)).toEqual(expected);
    expect(await ids(view, 1)).toEqual(expected);
  }
});
