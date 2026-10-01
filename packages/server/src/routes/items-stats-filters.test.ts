/**
 * `GET /items/stats` under a listing's filters: the count is the number of
 * rows `GET /items` walks for the same keys.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
const TAG = "stats-filters";

async function stats(query: string): Promise<Record<string, number>> {
  const res = await request(ctx.app, "GET", `/items/stats?${query}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, number>;
}

async function listedCount(query: string): Promise<number> {
  const res = await request(ctx.app, "GET", `/items?${query}&limit=200`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: unknown[]; next_cursor: unknown };
  expect(body.next_cursor).toBeNull();
  return body.data.length;
}

beforeAll(async () => {
  ctx = await createTestContext();
  for (const body of ["one", "two", "three"]) {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body }, tags: [TAG] },
    });
    expect(res.status).toBe(201);
  }
  const other = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "untagged" } },
  });
  expect(other.status).toBe(201);
  // The reserved namespace refuses a write to every credential, so the
  // system row goes in through the store.
  const folder = await ctx.storage.items.create({
    type: "system.folder",
    properties: { title: "stats-folder" },
  });
  await ctx.storage.metadata.set(folder.id, [TAG]);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /items/stats with a listing's filters", () => {
  it("counts what the listing walks for the same keys", async () => {
    for (const query of [
      `tags=${TAG}`,
      "type=core.note",
      `filter=${encodeURIComponent('properties.body eq "two"')}`,
      `tags=${TAG}&include=system`,
    ]) {
      const counted = await stats(query);
      expect(counted.active ?? 0, query).toBe(await listedCount(query));
    }
    expect(await stats(`tags=${TAG}`)).toEqual({ active: 3 });
  });

  it("leaves system rows out unless asked, as the listing does", async () => {
    // Both halves: the folder is counted when asked for, so its absence
    // below is the default and not a row that was never there.
    expect(await stats(`tags=${TAG}&include=system&by=type`)).toEqual({
      "core.note": 3,
      "system.folder": 1,
    });
    expect(await stats(`tags=${TAG}&by=type`)).toEqual({ "core.note": 3 });
    expect(await stats(`tags=${TAG}&type=system.folder`)).toEqual({
      active: 1,
    });
  });

  it("counts every state when none is named, and one when one is", async () => {
    const res = await request(ctx.app, "GET", `/items?tags=${TAG}`, {
      key: ctx.workingKey,
    });
    const { data } = (await res.json()) as { data: { id: string }[] };
    const first = data[0];
    if (!first) throw new Error("no tagged row to archive");
    const archived = await request(
      ctx.app,
      "POST",
      `/items/${first.id}/transition`,
      { key: ctx.workingKey, body: { state: "archived" } },
    );
    expect(archived.status).toBe(200);

    expect(await stats(`tags=${TAG}`)).toEqual({ active: 2, archived: 1 });
    expect(await stats(`tags=${TAG}&state=archived`)).toEqual({ archived: 1 });
    expect(await stats(`tags=${TAG}&state=any`)).toEqual({
      active: 2,
      archived: 1,
    });
  });

  it("refuses what the listing refuses", async () => {
    const unknownType = await request(
      ctx.app,
      "GET",
      "/items/stats?type=user.never_registered",
      { key: ctx.workingKey },
    );
    expect(unknownType.status).toBe(400);
    const emptyShorthand = await request(
      ctx.app,
      "GET",
      "/items/stats?edge[about]=",
      { key: ctx.workingKey },
    );
    expect(emptyShorthand.status).toBe(400);
    const hydration = await request(
      ctx.app,
      "GET",
      "/items/stats?include=edges",
      { key: ctx.workingKey },
    );
    expect(hydration.status).toBe(400);
  });
});
