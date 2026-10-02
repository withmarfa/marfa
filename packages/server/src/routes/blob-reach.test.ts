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
import { blobPrincipal } from "./_blob-reach.js";

let ctx: TestContext;
let seq = 0;
/** The working key, as the uploads below credit it. */
let writer: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const current = await request(ctx.app, "GET", "/keys/current", {
    key: ctx.workingKey,
  });
  writer = `key:${((await current.json()) as { id: string }).id}`;
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

async function sendAs(key: string, bytes: Uint8Array): Promise<Response> {
  return ctx.app.request("/blobs", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "text/plain" },
    body: bytes,
  });
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
      blob_writer: writer,
      type: "core.file",
      properties: { blob_ref: asFile, mime_type: "text/plain" },
      tier: "library",
    });
    await ctx.storage.items.create({
      blob_writer: writer,
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

describe("a reference and the bytes behind it", () => {
  it("lends no reach through a digest written by a key that never sent the bytes", async () => {
    const bytes = new TextEncoder().encode("a file another key's note names");
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    expect((await sendAs(ctx.workingKey, bytes)).status).toBe(201);
    await ctx.storage.items.create({
      blob_writer: writer,
      type: "core.file",
      properties: { blob_ref: hash, mime_type: "text/plain" },
      tier: "library",
    });
    const noteWriter = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
    });
    expect(await read(noteWriter, hash)).toBe(404);

    const named = await request(ctx.app, "POST", "/items", {
      key: noteWriter,
      body: { type: "core.note", properties: { body: `![x](${hash})` } },
    });
    expect(named.status).toBe(201);
    expect(await read(noteWriter, hash)).toBe(404);

    // Sending the bytes is the proof the hash alone is not: the same note
    // lends its reach once its writer has uploaded them.
    expect((await sendAs(noteWriter, bytes)).status).toBe(201);
    expect(await read(noteWriter, hash)).toBe(200);
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

describe("who a reference is credited to", () => {
  it("credits a stored key as itself, an app's own key whatever source it names", () => {
    const base = {
      id: "k1",
      label: "l",
      sources: [],
      default_tier: "library" as const,
      is_operator: false,
      type_permissions: {},
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: null,
    };
    expect(
      blobPrincipal({ ...base, source: "key:another", oauth_client_id: "c" }),
    ).toBe("key:k1");
    expect(blobPrincipal({ ...base, source: "device" })).toBe("key:k1");
    expect(
      blobPrincipal({ ...base, source: "oauth:c:u", oauth_client_id: "c" }),
    ).toBe("oauth:c:u");
  });

  it("keeps a sibling's inherited digests credited as the row credited them", async () => {
    const hash = await upload("planted in a title");
    const reader = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
    });
    const planted = await ctx.storage.items.create({
      blob_writer: "key:never-sent-the-bytes",
      type: "core.note",
      properties: { title: hash, body: "original" },
      tier: "library",
    });
    expect(await read(reader, hash)).toBe(404);
    const moved = await ctx.storage.items.update(planted.id, {
      blob_writer: writer,
      properties: { body: "from the winner" },
      version: planted.version,
    });
    expect("error" in moved).toBe(false);
    const stale = await ctx.storage.items.update(planted.id, {
      blob_writer: writer,
      properties: { body: "from the loser" },
      version: planted.version,
      conflict_mode: "auto",
    });
    expect("error" in stale).toBe(false);
    const sibling = (await ctx.storage.items.list({ limit: 500 })).data.find(
      (item) =>
        item.id !== planted.id && item.properties.body === "from the loser",
    );
    expect(sibling?.properties.title).toBe(hash);
    expect(await read(reader, hash)).toBe(404);
  });

  it("restores a row's credit only for the digests its archive line says lent", async () => {
    const lent = await upload("lent where the archive was taken");
    const planted = await upload("planted where the archive was taken");
    const reader = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
    });
    const source = await ctx.storage.items.create({
      blob_writer: writer,
      type: "core.note",
      properties: { body: `![a](${lent})` },
      tier: "library",
    });
    await ctx.storage.items.update(source.id, {
      blob_writer: "key:never-sent-the-bytes",
      properties: { title: planted },
    });
    expect(await ctx.storage.blobs.lendingHashesOf(source.id)).toEqual([lent]);

    const restored = await ctx.storage.items.create({
      blob_writer: "key:operator",
      blob_lenders: [lent],
      type: "core.note",
      properties: { title: planted, body: `![a](${lent})` },
      tier: "library",
    });
    await ctx.storage.blobs.recordUploader(lent, "key:operator");
    await ctx.storage.blobs.recordUploader(planted, "key:operator");
    expect(await ctx.storage.blobs.lendingHashesOf(restored.id)).toEqual([
      lent,
    ]);
    await ctx.storage.items.purge(
      (await ctx.storage.items.transition(source.id, "trashed")).id,
    );
    expect(await read(reader, lent)).toBe(200);
    expect(await read(reader, planted)).toBe(404);
  });
});

describe("the reference index a blob door reads", () => {
  it("follows an item's properties through every write that changes them", async () => {
    const first = await upload("first");
    const second = await upload("second");
    const reader = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
    });

    const created = await ctx.storage.items.create({
      blob_writer: writer,
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
      blob_writer: writer,
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
      blob_writer: writer,
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
      blob_writer: writer,
      type: "core.note",
      properties: { body: `![a](${hash})` },
      tier: "library",
    });
    expect(await read(noteReader, hash)).toBe(200);
    const moved = await ctx.storage.items.update(created.id, {
      blob_writer: writer,
      type: "core.bookmark",
      properties: { url: `https://example.com/${hash.slice(7)}` },
      properties_mode: "replace",
      version: created.version,
    });
    expect("error" in moved, JSON.stringify(moved)).toBe(false);
    expect(await ctx.storage.blobs.lendingTypes(hash)).toEqual([
      "core.bookmark",
    ]);
    expect(await read(noteReader, hash)).toBe(404);
  });
});
