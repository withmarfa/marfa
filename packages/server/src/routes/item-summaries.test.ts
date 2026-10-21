import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { itemWrites } from "../storage/item-writes.js";

let ctx: TestContext;
let witnessId: string;
let trashedId: string;
beforeAll(async () => {
  ctx = await createTestContext();
  for (let i = 0; i < 9; i++) {
    const result = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: {
          title: i % 2 ? `Chosen ${String(i)}` : `Other ${String(i)}`,
          body: "private-body-witness Chosen",
          notes: "private-notes-witness",
        },
        tags: ["private-tag"],
      },
    });
    expect(result.status).toBe(201);
    const { item } = (await result.json()) as { item: { id: string } };
    witnessId = item.id;
  }
  await ctx.storage.metadata.setExtension(
    witnessId,
    "private.example",
    { secret: "private-extension-witness" },
    null,
  );
  const trash = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    state: "trashed",
    properties: { title: "Chosen trash", body: "trash-body" },
  });
  trashedId = trash.id;
});
afterAll(async () => {
  await ctx.cleanup();
});

it("keeps items visible when their custom type was removed", async () => {
  const type = await request(ctx.app, "POST", "/types", {
    key: ctx.workingKey,
    body: { id: "user.removed", fields: { title: { type: "string" } } },
  });
  expect(type.status).toBe(201);
  const item = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "user.removed", properties: { title: "Kept after removal" } },
  });
  expect(item.status).toBe(201);
  const removed = await request(
    ctx.app,
    "DELETE",
    "/types/user.removed?force=true",
    {
      key: ctx.workingKey,
    },
  );
  expect(removed.status).toBe(200);
  for (const path of [
    "/auth/owner/items",
    "/auth/owner/items?type=user.removed",
  ]) {
    const page = await ctx.ownerRequest(path);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Kept after removal");
  }
});

it("searches only names before pagination and excludes trash", async () => {
  const names: string[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({
      type: "core.note",
      q: " chosen ",
      limit: "2",
    });
    if (cursor) query.set("cursor", cursor);
    const result = await ctx.ownerRequest(
      `/items/summaries?${query.toString()}`,
    );
    expect(result.status).toBe(200);
    const page = (await result.json()) as {
      data: { id: string; name: string }[];
      next_cursor: string | null;
    };
    expect(page.data.length).toBe(2);
    expect(page.data.map((row) => row.id)).not.toContain(trashedId);
    names.push(...page.data.map((row) => row.name));
    cursor = page.next_cursor;
  } while (cursor);
  expect(names).toEqual(["Chosen 7", "Chosen 5", "Chosen 3", "Chosen 1"]);
  const noHits = await ctx.ownerRequest(
    "/items/summaries?type=core.note&q=private-body-witness",
  );
  expect(await noHits.json()).toEqual({ data: [], next_cursor: null });
});

it("returns only summaries, including on pages, while content doors and errors stay closed", async () => {
  const witness = await request(ctx.app, "GET", `/items/${witnessId}`, {
    key: ctx.workingKey,
  });
  expect(witness.status).toBe(200);
  expect(await witness.text()).toContain("private-body-witness");
  const extension = await request(
    ctx.app,
    "GET",
    `/items/${witnessId}/extensions/private.example`,
    { key: ctx.workingKey },
  );
  expect(extension.status).toBe(200);
  expect(await extension.text()).toContain("private-extension-witness");
  const keys = await ctx.storage.keys.list();
  const result = await ctx.ownerRequest("/items/summaries?type=core.note");
  expect(result.status).toBe(200);
  const page = (await result.json()) as { data: Record<string, unknown>[] };
  expect(page.data).toHaveLength(9);
  for (const row of page.data)
    expect(Object.keys(row).sort()).toEqual([
      "created_at",
      "id",
      "name",
      "source",
    ]);
  for (const path of [
    "/auth/owner/items",
    "/auth/owner/items?type=core.note&q=Chosen",
    "/auth/owner/types/core.note",
  ]) {
    const html = await ctx.ownerRequest(path);
    expect(html.status, path).toBe(200);
    expect(await html.text()).not.toMatch(
      /private-(?:body|notes|extension)-witness|private-tag|trash-body/,
    );
  }
  for (const path of [
    `/items/${witnessId}`,
    `/items/${witnessId}/metadata`,
    `/items/${witnessId}/versions`,
    "/items",
    "/search?q=private-body-witness",
  ]) {
    const refused = await ctx.ownerRequest(path);
    expect(refused.status, path).toBe(401);
    expect(await refused.text()).not.toContain("private-body-witness");
  }
  for (const query of [
    "type=core.note&include=properties",
    "type=core.note&cursor=invalid",
    "type=core.note&limit=0",
  ]) {
    const refused = await ctx.ownerRequest(`/items/summaries?${query}`);
    expect(refused.status, query).toBe(400);
    expect(await refused.text()).not.toMatch(
      /private-(?:body|notes|extension)-witness/,
    );
  }
  expect(
    (
      await request(ctx.app, "GET", "/items/summaries?type=core.note", {
        key: ctx.workingKey,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await ctx.ownerRequest("/items/summaries?type=core.note", {
        headers: { authorization: `Bearer ${ctx.workingKey}` },
      })
    ).status,
  ).toBe(403);
  expect(
    (await ctx.app.request("/items/summaries?type=core.note")).status,
  ).toBe(401);
  expect(await ctx.storage.keys.list()).toEqual(keys);
});
