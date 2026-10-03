import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

interface Row {
  id: string;
  properties: Record<string, unknown>;
}

async function create(properties: Record<string, unknown>): Promise<Row> {
  const response = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.media.book",
      properties: { title: "Paging book", body: "", ...properties },
    },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { item: Row }).item;
}

async function walk(
  field: string,
  direction: "asc" | "desc",
  type: string | undefined,
  limit: number,
  known: Set<string>,
): Promise<string[]> {
  const delivered: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({
      sort: `properties.${field}`,
      direction,
      limit: String(limit),
    });
    if (type) query.set("type", type);
    if (cursor) query.set("cursor", cursor);
    const response = await request(
      ctx.app,
      "GET",
      `/items?${query.toString()}`,
      {
        key: ctx.workingKey,
      },
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      data: Row[];
      next_cursor: string | null;
    };
    delivered.push(
      ...page.data.filter((row) => known.has(row.id)).map((row) => row.id),
    );
    cursor = page.next_cursor;
    if (cursor) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      expect(cursors.size).toBeLessThan(200);
    }
  } while (cursor);
  return delivered;
}

describe("property-sort pagination", () => {
  it("walks numeric values under concrete, wildcard and absent type filters", async () => {
    const rows = [];
    for (const page_count of [2, 10, 20, 30, 40, 50]) {
      rows.push(await create({ page_count }));
    }
    const ids = rows.map((row) => row.id);
    for (const type of ["core.media.book", "core.media.*", undefined]) {
      for (const direction of ["asc", "desc"] as const) {
        expect(
          await walk("page_count", direction, type, 2, new Set(ids)),
        ).toEqual(direction === "asc" ? ids : [...ids].reverse());
      }
    }
  });

  it("walks mixed scalar kinds and the null tail with ascending ID ties", async () => {
    const values = [
      -2,
      false,
      0,
      true,
      1,
      1.5,
      2,
      10,
      10,
      "",
      "10",
      "2",
      'a"b',
      "z",
      "é",
      "é",
      null,
      undefined,
      { nested: 1 },
      [2, 3],
    ];
    const rows: Row[] = [];
    for (const value of values) {
      const row = await create(
        value === undefined ? {} : { paging_probe: value },
      );
      if (value !== undefined)
        expect(row.properties.paging_probe).toEqual(value);
      rows.push(row);
    }
    const groups = [
      [0],
      [1, 2],
      [3, 4],
      [5],
      [6],
      [7, 8],
      [9],
      [10],
      [11],
      [12],
      [13],
      [14, 15],
    ].map((indices) => indices.map((i) => rows[i]!.id).sort());
    const tail = rows
      .slice(16)
      .map((row) => row.id)
      .sort();
    const known = new Set(rows.map((row) => row.id));
    for (const type of ["core.media.book", "core.media.*", undefined]) {
      for (const direction of ["asc", "desc"] as const) {
        for (const limit of [1, 2, 3]) {
          const expected = (
            direction === "asc" ? groups : [...groups].reverse()
          ).flat();
          expect(
            await walk("paging_probe", direction, type, limit, known),
          ).toEqual([...expected, ...tail]);
        }
      }
    }
  });

  it("refuses property cursors carrying an invalid encoded scalar", async () => {
    for (const page_count of [1, 2]) await create({ page_count });
    const query =
      "type=core.media.book&sort=properties.page_count&direction=asc&limit=1";
    const first = await request(ctx.app, "GET", `/items?${query}`, {
      key: ctx.workingKey,
    });
    expect(first.status).toBe(200);
    const page = (await first.json()) as { data: Row[]; next_cursor: string };
    const honored = await request(
      ctx.app,
      "GET",
      `/items?${query}&cursor=${page.next_cursor}`,
      { key: ctx.workingKey },
    );
    expect(honored.status).toBe(200);
    const next = (await honored.json()) as { data: Row[] };
    expect(next.data).toHaveLength(1);
    expect(next.data[0]!.id).not.toBe(page.data[0]!.id);
    const payload = JSON.parse(
      Buffer.from(page.next_cursor, "base64url").toString(),
    ) as Record<string, unknown>;
    for (const v of ["", "unquoted", "null", "{}", "[]", "1e400"]) {
      const cursor = Buffer.from(JSON.stringify({ ...payload, v })).toString(
        "base64url",
      );
      const refused = await request(
        ctx.app,
        "GET",
        `/items?${query}&cursor=${cursor}`,
        { key: ctx.workingKey },
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: {
          code: "validation_error",
          message: "Invalid pagination cursor",
        },
      });
    }
  });
});
