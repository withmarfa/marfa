import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let key: string;

beforeAll(async () => {
  ctx = await createTestContext();
  key = await mintWorkingKey(ctx);
});

afterAll(async () => {
  await ctx.cleanup();
});

/** A note at version 2, tagged `kept`. */
async function changedNote(): Promise<string> {
  const writes = itemWrites(ctx.storage);
  const created = await writes.create({
    writer: null,
    type: "core.note",
    properties: { body: "first" },
  });
  await writes.update(created.id, {
    writer: null,
    may_read_type: () => true,
    properties: { body: "second" },
    version: created.version,
  });
  await ctx.storage.metadata.addTags(created.id, ["kept"]);
  return created.id;
}

async function tags(id: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", `/items/${id}/metadata`, { key });
  return ((await res.json()) as { metadata: { tags: string[] } }).metadata.tags;
}

interface Stale {
  error: { code: string };
  current: { id: string; version: number };
}

describe("a tag write that names a version", () => {
  it("adds the tags when the version is the item's", async () => {
    const id = await changedNote();
    const res = await request(ctx.app, "POST", `/items/${id}/tags?version=2`, {
      key,
      body: { tags: ["added"] },
    });
    expect(res.status).toBe(200);
    expect(await tags(id)).toEqual(["kept", "added"]);
  });

  it("adds nothing and answers the item now when the version is stale", async () => {
    const id = await changedNote();
    const res = await request(ctx.app, "POST", `/items/${id}/tags?version=1`, {
      key,
      body: { tags: ["added"] },
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("X-Error-Code")).toBe("version_conflict");
    const body = (await res.json()) as Stale;
    expect(body.error.code).toBe("version_conflict");
    expect(body.current).toMatchObject({ id, version: 2 });
    expect(await tags(id)).toEqual(["kept"]);
  });

  it("removes the tag when the version is the item's", async () => {
    const id = await changedNote();
    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${id}/tags/kept?version=2`,
      { key },
    );
    expect(res.status).toBe(200);
    expect(await tags(id)).toEqual([]);
  });

  it("removes nothing and answers the item now when the version is stale", async () => {
    const id = await changedNote();
    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${id}/tags/kept?version=1`,
      { key },
    );
    expect(res.status).toBe(409);
    expect(res.headers.get("X-Error-Code")).toBe("version_conflict");
    const body = (await res.json()) as Stale;
    expect(body.current).toMatchObject({ id, version: 2 });
    expect(await tags(id)).toEqual(["kept"]);
  });
});
