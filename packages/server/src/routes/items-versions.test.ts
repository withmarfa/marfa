import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Version } from "@withmarfa/shared";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface VersionPage {
  data: Version[];
  next_cursor: string | null;
}

async function json<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

/** A note written `edits` times after its create. */
async function editedNote(edits: number): Promise<string> {
  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      source_id: `history-${Math.random().toString(36).slice(2)}`,
      properties: { body: "edit 0" },
    },
  });
  const { item } = (await created.json()) as { item: { id: string } };
  for (let version = 1; version <= edits; version++) {
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: ctx.workingKey,
        body: { properties: { body: `edit ${String(version)}` }, version },
      }),
    );
  }
  return item.id;
}

async function walk(id: string, key: string, limit: number) {
  const pages: VersionPage[] = [];
  let cursor: string | null = null;
  do {
    const query: string =
      `limit=${String(limit)}` +
      (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`);
    const page: VersionPage = await json(
      await request(ctx.app, "GET", `/items/${id}/versions?${query}`, { key }),
    );
    pages.push(page);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return pages;
}

describe("GET /items/{id}/versions", () => {
  it("names each snapshot's type, tier, own time and natural key", async () => {
    const id = await editedNote(1);
    const { data } = await json<VersionPage>(
      await request(ctx.app, "GET", `/items/${id}/versions`, {
        key: ctx.workingKey,
      }),
    );
    expect(data).toHaveLength(1);
    const [snapshot] = data;
    expect(snapshot).toMatchObject({
      item_id: id,
      version: 1,
      properties: { body: "edit 0" },
      type: "core.note",
      tier: "library",
    });
    expect(snapshot?.source_id).toMatch(/^history-/);
    expect(typeof snapshot?.occurred_at).toBe("string");
  });

  it("pages the history oldest first, every snapshot once, ending on null", async () => {
    const id = await editedNote(5);
    const pages = await walk(id, ctx.workingKey, 2);
    expect(pages.map((p) => p.data.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap((p) => p.data.map((v) => v.version))).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("fills a page past the snapshots the key may not read", async () => {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.task", properties: { title: "task 0" } },
    });
    const { item } = (await created.json()) as { item: { id: string } };
    const writes: Record<string, unknown>[] = [
      { properties: { title: "task 1" }, version: 1 },
      { properties: { title: "task 2" }, version: 2 },
      {
        type: "core.note",
        retype: true,
        properties: { body: "note 3" },
        version: 3,
      },
      { properties: { body: "note 4" }, version: 4 },
      { properties: { body: "note 5" }, version: 5 },
    ];
    for (const body of writes) {
      await json(
        await request(ctx.app, "PATCH", `/items/${item.id}`, {
          key: ctx.workingKey,
          body,
        }),
      );
    }
    const noteKey = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
    });

    // The witness: the full key reads the three task snapshots.
    const everything = await walk(item.id, ctx.workingKey, 10);
    expect(everything.flatMap((p) => p.data.map((v) => v.type))).toEqual([
      "core.task",
      "core.task",
      "core.task",
      "core.note",
      "core.note",
    ]);

    const pages = await walk(item.id, noteKey, 1);
    expect(pages.map((p) => p.data.map((v) => v.version))).toEqual([[4], [5]]);
    expect(pages.flatMap((p) => p.data.map((v) => v.type))).toEqual([
      "core.note",
      "core.note",
    ]);
  });

  it("answers a first page on the item read that the listing continues", async () => {
    const id = await editedNote(3);
    const detail = await json<{ versions: VersionPage }>(
      await request(ctx.app, "GET", `/items/${id}?include=versions`, {
        key: ctx.workingKey,
      }),
    );
    expect(detail.versions.data.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(detail.versions.next_cursor).toBeNull();
  });

  it("refuses a malformed cursor, another listing's cursor and an unknown parameter", async () => {
    const id = await editedNote(1);
    const foreign = Buffer.from(
      JSON.stringify({ v: "1", id: "x", k: "audit:created_at:desc" }),
    ).toString("base64url");
    const forged = Buffer.from(
      JSON.stringify({ v: "one", id: "x", k: "item-versions:version:asc" }),
    ).toString("base64url");
    for (const query of [
      "cursor=not-a-cursor",
      `cursor=${foreign}`,
      `cursor=${forged}`,
      "limit=0",
      "curser=x",
    ]) {
      const res = await request(
        ctx.app,
        "GET",
        `/items/${id}/versions?${query}`,
        { key: ctx.workingKey },
      );
      expect(res.status, query).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code, query).toBe("validation_error");
    }
  });
});
