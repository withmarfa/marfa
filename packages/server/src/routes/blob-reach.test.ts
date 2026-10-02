import { createHash } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { collectBlobHashes } from "../storage/blob-utils.js";

let ctx: TestContext;
let seq = 0;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Bytes no other test uploads, by the working key, answered by hash. */
async function upload(words: string): Promise<string> {
  seq += 1;
  const bytes = new TextEncoder().encode(`${words} ${String(seq)}`);
  const res = await ctx.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      "Content-Type": "text/plain",
    },
    body: bytes,
  });
  expect(res.status).toBe(201);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function read(key: string, hash: string): Promise<number> {
  return (await request(ctx.app, "GET", `/blobs/${hash}`, { key })).status;
}

async function uploadAs(key: string): Promise<Response> {
  seq += 1;
  return ctx.app.request("/blobs", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "text/plain" },
    body: new TextEncoder().encode(
      `sent by a narrow credential ${String(seq)}`,
    ),
  });
}

describe("a signed-in app and the blob doors", () => {
  it("holds a signed-in app to its granted type scopes", async () => {
    const asFile = await upload("named by a file");
    const asNote = await upload("linked from a note");
    await ctx.storage.items.create({
      type: "core.file",
      properties: { blob_ref: asFile, mime_type: "text/plain" },
      tier: "library",
    });
    await ctx.storage.items.create({
      type: "core.note",
      properties: { body: `see ![it](/blobs/${asNote})` },
      tier: "library",
    });
    const { token: noteReader } = await seedOauthBearer(ctx.storage, [
      "core.note:read",
    ]);
    const { token: noteWriter } = await seedOauthBearer(ctx.storage, [
      "core.note:write",
    ]);

    expect(await read(ctx.workingKey, asFile)).toBe(200);
    expect(await read(noteReader, asFile)).toBe(404);
    expect(await read(noteReader, asNote)).toBe(200);

    const refused = await uploadAs(noteReader);
    expect(refused.status).toBe(403);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("type_not_permitted");
    expect((await uploadAs(noteWriter)).status).toBe(201);
  });
});

/** The hashes the index holds for one item, beside what its row names. */
async function indexed(
  id: string,
): Promise<{ held: string[]; named: string[] }> {
  const raw = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<{ hash: string }[]>;
  };
  const rows = await raw.__sqliteAll(
    `SELECT hash FROM item_blob_references WHERE item_id = '${id}' ORDER BY hash`,
  );
  const item = await ctx.storage.items.getIncludingTrashed(id);
  const named = new Set<string>();
  collectBlobHashes(item?.properties ?? {}, named);
  return { held: rows.map((r) => r.hash), named: [...named].sort() };
}

describe("the reference index a blob door reads", () => {
  it("follows an item's properties through every write that changes them", async () => {
    const first = await upload("first");
    const second = await upload("second");
    const reader = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
    });

    const created = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: `![a](${first})` },
      tier: "library",
    });
    expect(await indexed(created.id)).toEqual({
      held: [first],
      named: [first],
    });
    expect(await read(reader, first)).toBe(200);
    expect(await read(reader, second)).toBe(404);

    const moved = await ctx.storage.items.update(created.id, {
      properties: { body: `![b](${second})` },
      version: created.version,
    });
    expect("error" in moved).toBe(false);
    expect(await indexed(created.id)).toEqual({
      held: [second],
      named: [second],
    });
    expect(await read(reader, first)).toBe(404);
    expect(await read(reader, second)).toBe(200);

    // A write at a stale version takes the merge path, and a keep-both
    // resolution writes a sibling holding the losing write.
    const stale = await ctx.storage.items.update(created.id, {
      properties: { body: `![a](${first}) again` },
      version: created.version,
      conflict_mode: "auto",
    });
    expect("error" in stale).toBe(false);
    const after = await indexed(created.id);
    expect(after).toEqual({ held: [second], named: [second] });
    const siblings = (await ctx.storage.items.list({ limit: 500 })).data.filter(
      (item) =>
        item.id !== created.id &&
        JSON.stringify(item.properties).includes(first.slice(7)),
    );
    expect(siblings).toHaveLength(1);
    expect(await indexed(siblings[0]!.id)).toEqual({
      held: [first],
      named: [first],
    });
    expect(await read(reader, first)).toBe(200);

    await ctx.storage.items.transition(created.id, "trashed");
    expect((await indexed(created.id)).held).toEqual([second]);
    expect(await read(reader, second)).toBe(200);
    await ctx.storage.items.purge(created.id);
    expect((await indexed(created.id)).held).toEqual([]);
    expect(await read(reader, second)).toBe(404);
  });

  it("answers by the item's current type after a retype", async () => {
    const hash = await upload("retyped");
    const noteReader = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
    });
    const created = await ctx.storage.items.create({
      type: "core.note",
      properties: { body: `![a](${hash})` },
      tier: "library",
    });
    expect(await read(noteReader, hash)).toBe(200);
    const moved = await ctx.storage.items.update(created.id, {
      type: "core.bookmark",
      properties: { url: `https://example.com/${hash.slice(7)}` },
      properties_mode: "replace",
      version: created.version,
    });
    expect("error" in moved, JSON.stringify(moved)).toBe(false);
    expect(await ctx.storage.blobs.referencingTypes(hash)).toEqual([
      "core.bookmark",
    ]);
    expect(await read(noteReader, hash)).toBe(404);
  });
});
