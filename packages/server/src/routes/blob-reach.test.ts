/**
 * Which writes make a reference lend a blob's reach, door by door.
 *
 * Each door that writes an item's properties for a credential hands the
 * store the credential's proof of holding the bytes, and each case here is
 * written so it fails if that one door stops doing so: the bytes are sent by
 * a key, nothing lends them before the door under test writes the digest,
 * and a reader that may read every type is refused them until it has.
 */
import { itemWrites } from "../storage/item-writes.js";
import { createHash } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  runBulkActionAsync,
  seedOauthBearer,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { collectBlobHashes } from "../storage/blob-utils.js";
import { blobPrincipal } from "./_blob-reach.js";
import { TextEnrichmentSweeper } from "../enrichment/sweeper.js";
import { DEFAULT_MAX_STRING_LENGTH } from "@withmarfa/shared";

let ctx: TestContext;
let seq = 0;
/** May read every type, and lends nothing of its own. */
let reader: string;

beforeAll(async () => {
  ctx = await createTestContext();
  reader = await mintWorkingKey(ctx, { type_permissions: { "*": "read" } });
});

afterAll(async () => {
  await ctx.cleanup();
});

function sweeper(): TextEnrichmentSweeper {
  return new TextEnrichmentSweeper({
    storage: ctx.storage,
    blobs: ctx.blobs,
    ocr: null,
    batchSize: 64,
    itemTimeoutMs: 60_000,
    maxBlobBytes: 20 * 1024 * 1024,
    maxTextChars: DEFAULT_MAX_STRING_LENGTH,
    maxAttempts: 3,
  });
}

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Fresh bytes sent by `key`, answered by their hash. */
async function sent(
  key: string,
  words: string,
  mimeType = "text/plain",
): Promise<{ hash: string; bytes: Uint8Array }> {
  seq += 1;
  const bytes = new TextEncoder().encode(`${words} ${String(seq)}`);
  const res = await sendAs(key, bytes, mimeType);
  expect(res.status).toBe(201);
  return { hash: hashOf(bytes), bytes };
}

function sendAs(
  key: string,
  bytes: Uint8Array,
  mimeType = "text/plain",
): Promise<Response> {
  return Promise.resolve(
    ctx.app.request("/blobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": mimeType },
      body: bytes,
    }),
  );
}

async function read(key: string, hash: string): Promise<number> {
  return (await request(ctx.app, "GET", `/blobs/${hash}`, { key })).status;
}

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

interface Written {
  item: { id: string; version: number };
}

async function note(
  key: string,
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<Written> {
  return json<Written>(
    await request(ctx.app, "POST", "/items", {
      key,
      body: { type: "core.note", properties, ...extra },
    }),
    201,
  );
}

/** A key that may write notes and bookmarks, and nothing else. */
function writer(): Promise<string> {
  return mintWorkingKey(ctx, {
    type_permissions: { "core.note": "write", "core.bookmark": "write" },
  });
}

describe("a door that writes an item's properties credits its caller's proof", () => {
  it("POST /items", async () => {
    const key = await writer();
    const { hash } = await sent(key, "created");
    expect(await read(reader, hash)).toBe(404);
    await note(key, { body: `![x](${hash})` });
    expect(await read(reader, hash)).toBe(200);
  });

  it("POST /items onto an existing natural key", async () => {
    const key = await writer();
    const { hash } = await sent(key, "upserted");
    await note(key, { body: "first" }, { source_id: `upsert-${String(seq)}` });
    expect(await read(reader, hash)).toBe(404);
    const again = await request(ctx.app, "POST", "/items", {
      key,
      body: {
        type: "core.note",
        properties: { body: `![x](${hash})` },
        source_id: `upsert-${String(seq)}`,
      },
    });
    expect(again.status).toBeLessThan(300);
    expect(await read(reader, hash)).toBe(200);
  });

  it("PATCH /items/{id} at the current version", async () => {
    const key = await writer();
    const { hash } = await sent(key, "patched");
    const { item } = await note(key, { body: "plain" });
    expect(await read(reader, hash)).toBe(404);
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key,
        body: { properties: { body: `![x](${hash})` }, version: item.version },
      }),
      200,
    );
    expect(await read(reader, hash)).toBe(200);
  });

  it("PATCH /items/{id} at a stale version that merges", async () => {
    const key = await writer();
    const { hash } = await sent(key, "merged");
    const { item } = await note(key, { title: "t", body: "b" });
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key,
        body: { properties: { body: "moved on" }, version: item.version },
      }),
      200,
    );
    expect(await read(reader, hash)).toBe(404);
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}?conflict=auto`, {
        key,
        body: { properties: { title: `![x](${hash})` }, version: item.version },
      }),
      200,
    );
    expect(await read(reader, hash)).toBe(200);
  });

  it("PATCH /items/{id} that keeps both, on the sibling it writes", async () => {
    const key = await writer();
    const { hash } = await sent(key, "kept both");
    const { item } = await note(key, { body: "original" });
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key,
        body: { properties: { body: "the winner" }, version: item.version },
      }),
      200,
    );
    expect(await read(reader, hash)).toBe(404);
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}?conflict=auto`, {
        key,
        body: {
          properties: { body: `the loser ![x](${hash})` },
          version: item.version,
        },
      }),
      200,
    );
    const row = await ctx.storage.items.get(item.id);
    expect(JSON.stringify(row?.properties)).not.toContain(hash.slice(7));
    expect(await read(reader, hash)).toBe(200);
  });

  it("PATCH /items/{id} that moves the row to another type", async () => {
    const key = await writer();
    const { hash } = await sent(key, "retyped");
    const { item } = await note(key, { body: "a note" });
    expect(await read(reader, hash)).toBe(404);
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key,
        body: {
          type: "core.bookmark",
          retype: true,
          properties: {
            url: "https://example.com/retyped",
            title: `![x](${hash})`,
          },
          properties_mode: "replace",
          version: item.version,
        },
      }),
      200,
    );
    expect(await read(reader, hash)).toBe(200);
  });

  it("POST /items/bulk, on a create and on an update", async () => {
    const key = await writer();
    const created = await sent(key, "bulk created");
    const updated = await sent(key, "bulk updated");
    const sourceId = `bulk-${String(seq)}`;
    await note(key, { body: "before" }, { source_id: sourceId });
    expect(await read(reader, created.hash)).toBe(404);
    expect(await read(reader, updated.hash)).toBe(404);
    await json(
      await request(ctx.app, "POST", "/items/bulk", {
        key,
        body: {
          items: [
            {
              type: "core.note",
              properties: { body: `![x](${created.hash})` },
              source_id: `${sourceId}-new`,
            },
            {
              type: "core.note",
              properties: { body: `![x](${updated.hash})` },
              source_id: sourceId,
            },
          ],
        },
      }),
      200,
    );
    expect(await read(reader, created.hash)).toBe(200);
    expect(await read(reader, updated.hash)).toBe(200);
  });

  it("POST /items/bulk-actions with update_properties", async () => {
    const key = await writer();
    const { hash } = await sent(key, "bulk action");
    const tag = `blob-action-${String(seq)}`;
    await note(key, { body: "tagged" }, { tags: [tag] });
    expect(await read(reader, hash)).toBe(404);
    const { initialStatus } = await runBulkActionAsync(
      ctx,
      {
        action: "update_properties",
        patch: { title: `![x](${hash})` },
        filter: { tags: [tag] },
      },
      key,
    );
    expect(initialStatus).toBe(202);
    expect(await read(reader, hash)).toBe(200);
  });

  it("POST /folders and PATCH /folders/{id}, whose settings are properties", async () => {
    const owner = await writer();
    const onCreate = await sent(owner, "named by a folder's title");
    const onUpdate = await sent(owner, "named by a folder's new title");
    await note(owner, {
      body: `![a](${onCreate.hash}) ![b](${onUpdate.hash})`,
    });
    // A key whose only write is `system.folder` cannot upload, and lends
    // through a folder only what it may already read.
    const folderKey = await mintWorkingKey(ctx, {
      type_permissions: { "system.folder": "write", "core.note": "read" },
    });
    const folderReader = await mintWorkingKey(ctx, {
      type_permissions: { "system.folder": "read" },
    });
    expect(
      (await sendAs(folderKey, new TextEncoder().encode("refused"))).status,
    ).toBe(403);
    expect(await read(folderReader, onCreate.hash)).toBe(404);
    expect(await read(folderReader, onUpdate.hash)).toBe(404);

    await json(
      await request(ctx.app, "POST", "/folders", {
        key: folderKey,
        body: { title: `![a](${onCreate.hash})` },
      }),
      201,
    );
    expect(await read(folderReader, onCreate.hash)).toBe(200);

    const plain = await json<Written>(
      await request(ctx.app, "POST", "/folders", {
        key: folderKey,
        body: { title: "plain" },
      }),
      201,
    );
    await json(
      await request(ctx.app, "PATCH", `/folders/${plain.item.id}`, {
        key: folderKey,
        body: { title: `![b](${onUpdate.hash})`, version: plain.item.version },
      }),
      200,
    );
    expect(await read(folderReader, onUpdate.hash)).toBe(200);
  });

  it("a signed-in app, through its granted scopes", async () => {
    const { token: app } = await seedOauthBearer(ctx.storage, [
      "core.note:write",
    ]);
    const { hash } = await sent(app, "sent by an app");
    expect(await read(reader, hash)).toBe(404);
    await note(app, { body: `![x](${hash})` });
    expect(await read(reader, hash)).toBe(200);
  });
});

describe("a signed-in app and the blob doors", () => {
  it("holds a signed-in app to its granted type scopes", async () => {
    const owner = await writer();
    const asFile = await sent(ctx.workingKey, "named by a file");
    const asNote = await sent(owner, "linked from a note");
    await json(
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.file",
          properties: { blob_ref: asFile.hash, mime_type: "text/plain" },
        },
      }),
      201,
    );
    await note(owner, { body: `see ![it](/blobs/${asNote.hash})` });
    const { token: noteReader } = await seedOauthBearer(ctx.storage, [
      "core.note:read",
    ]);
    const { token: noteWriter } = await seedOauthBearer(ctx.storage, [
      "core.note:write",
    ]);
    expect(await read(reader, asFile.hash)).toBe(200);
    expect(await read(noteReader, asFile.hash)).toBe(404);
    expect(await read(noteReader, asNote.hash)).toBe(200);

    const refused = await sendAs(noteReader, new TextEncoder().encode("no"));
    expect(refused.status).toBe(403);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("type_not_permitted");
    expect(
      (await sendAs(noteWriter, new TextEncoder().encode("yes"))).status,
    ).toBe(201);
  });
});

describe("what proves holding the bytes", () => {
  it("lends nothing through a digest written by a key that neither sent the bytes nor could read them", async () => {
    const owner = await writer();
    const { hash, bytes } = await sent(owner, "a file only files reach");
    await json(
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.file",
          properties: { blob_ref: hash, mime_type: "text/plain" },
        },
      }),
      201,
    );
    const noteKey = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
    });
    expect(await read(noteKey, hash)).toBe(404);

    const { item } = await note(noteKey, { body: `![x](${hash})` });
    expect(await read(noteKey, hash)).toBe(404);

    // Written without proof, the digest stays dead while the row names it,
    // even once its writer sends the bytes and writes it again; dropping it
    // and writing it anew with the proof is what lends it.
    expect((await sendAs(noteKey, bytes)).status).toBe(201);
    const again = await json<Written>(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: noteKey,
        body: {
          properties: { body: `![x](${hash}) again` },
          version: item.version,
        },
      }),
      200,
    );
    expect(await read(noteKey, hash)).toBe(404);
    const dropped = await json<Written>(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: noteKey,
        body: { properties: { body: "none" }, version: again.item.version },
      }),
      200,
    );
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: noteKey,
        body: {
          properties: { body: `![x](${hash})` },
          version: dropped.item.version,
        },
      }),
      200,
    );
    expect(await read(noteKey, hash)).toBe(200);
  });

  it("keeps a planted digest dead when a key holding every blob edits the row", async () => {
    const hash = (await sent(ctx.workingKey, "a private file")).hash;
    await json(
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.file",
          properties: { blob_ref: hash, mime_type: "text/plain" },
        },
      }),
      201,
    );
    const planter = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
    });
    const { item } = await note(planter, { body: `a typo ![x](${hash})` });
    expect(await read(planter, hash)).toBe(404);

    // The full key fixes the typo, sending the body with the hash in it.
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: ctx.workingKey,
        body: {
          properties: { body: `a fixed typo ![x](${hash})` },
          version: item.version,
        },
      }),
      200,
    );
    expect(await read(ctx.workingKey, hash)).toBe(200);
    expect(await read(planter, hash)).toBe(404);
  });

  it("credits a stale write only for digests its base version lacked", async () => {
    const victim = await sent(ctx.workingKey, "a secret a stale edit echoes");
    await json(
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.file",
          properties: { blob_ref: victim.hash, mime_type: "text/plain" },
        },
      }),
      201,
    );
    const planter = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
    });
    const { item } = await note(planter, {
      body: `a typo ![x](${victim.hash})`,
    });
    // The owner's device holds this version. The planter then takes the
    // hash out again.
    const removed = await json<Written>(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: planter,
        body: { properties: { body: "nothing here" }, version: item.version },
      }),
      200,
    );
    expect(removed.item.version).toBeGreaterThan(item.version);

    // The device's edit, made on the old version, still carries the hash.
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}?conflict=auto`, {
        key: ctx.workingKey,
        body: {
          properties: { body: `a fixed typo ![x](${victim.hash})` },
          version: item.version,
        },
      }),
      200,
    );
    const holding = (await ctx.storage.items.list({ limit: 1000 })).data.filter(
      (row) => JSON.stringify(row.properties).includes(victim.hash.slice(7)),
    );
    expect(holding.some((row) => row.type === "core.note")).toBe(true);
    expect(await read(planter, victim.hash)).toBe(404);
  });

  it("keeps a server-made write's digest dead after a full key rewrites the row", async () => {
    // Lent through a note, which the attacker may not read.
    const victim = await sent(ctx.workingKey, "a private file");
    await note(ctx.workingKey, { body: `![x](${victim.hash})` });
    const attacker = await mintWorkingKey(ctx, {
      type_permissions: { "core.file": "write" },
    });
    expect(await read(attacker, victim.hash)).toBe(404);
    // The attacker's own text file holds the victim's digest; the sweep
    // writes that text into the attacker's row for no credential.
    const text = await sent(
      attacker,
      `notes on ${victim.hash.slice("sha256:".length)}`,
    );
    const own = await json<Written>(
      await request(ctx.app, "POST", "/items", {
        key: attacker,
        body: {
          type: "core.file",
          properties: { blob_ref: text.hash, mime_type: "text/plain" },
        },
      }),
      201,
    );
    await sweeper().runOnce();
    const swept = await ctx.storage.items.get(own.item.id);
    expect(String(swept?.properties.extracted_text)).toContain(
      victim.hash.slice("sha256:".length),
    );
    expect((await indexed(own.item.id)).held).toContain(victim.hash);
    expect(await read(attacker, victim.hash)).toBe(404);

    // The full key, which reads every blob, rewrites the whole row.
    await json(
      await request(ctx.app, "PATCH", `/items/${own.item.id}`, {
        key: ctx.workingKey,
        body: {
          properties: swept?.properties,
          properties_mode: "replace",
          version: swept?.version,
        },
      }),
      200,
    );
    expect(await read(attacker, victim.hash)).toBe(404);
  });

  it("keeps a planted digest dead through an export, a purge and a restore", async () => {
    const victim = await sent(ctx.workingKey, "a private file, archived");
    await json(
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.file",
          properties: { blob_ref: victim.hash, mime_type: "text/plain" },
        },
      }),
      201,
    );
    const planter = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
    });
    const sourceId = `planted-${String(seq)}`;
    const { item } = await note(
      planter,
      { body: `![x](${victim.hash})` },
      { source_id: sourceId },
    );
    const current = await request(ctx.app, "GET", "/keys/current", {
      key: planter,
    });
    const { source } = (await current.json()) as { source: string };
    const exported = await request(
      ctx.app,
      "GET",
      `/export?format=archive&type=core.note&state=any&source=${encodeURIComponent(source)}`,
      { key: ctx.workingKey },
    );
    expect(exported.status).toBe(200);
    const archive = Buffer.from(await exported.arrayBuffer());

    await itemWrites(ctx.storage).transition(item.id, "trashed");
    await itemWrites(ctx.storage).purge(item.id);
    const restored = await ctx.app.request("/restore", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    const back = await ctx.storage.items.get(item.id);
    expect(back?.properties.body).toBe(`![x](${victim.hash})`);
    expect(await read(planter, victim.hash)).toBe(404);

    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: ctx.workingKey,
        body: {
          properties: { body: `![x](${victim.hash}) edited` },
          version: back?.version,
        },
      }),
      200,
    );
    expect(await read(planter, victim.hash)).toBe(404);
  });

  it("counts reading the blob as the write is made as holding it", async () => {
    const owner = await writer();
    const { hash } = await sent(owner, "an image a second device embeds");
    await note(owner, { body: `![x](${hash})` });
    const device = await writer();
    const bookmarksOnly = await mintWorkingKey(ctx, {
      type_permissions: { "core.bookmark": "read" },
    });
    expect(await read(device, hash)).toBe(200);
    expect(await read(bookmarksOnly, hash)).toBe(404);
    await json(
      await request(ctx.app, "POST", "/items", {
        key: device,
        body: {
          type: "core.bookmark",
          properties: { url: "https://example.com/embed", title: hash },
        },
      }),
      201,
    );
    expect(await read(bookmarksOnly, hash)).toBe(200);
  });

  it("never withdraws a lending reference through a write that keeps the digest", async () => {
    const owner = await writer();
    const { hash } = await sent(owner, "kept by any later write");
    const { item } = await note(owner, { body: `![x](${hash})`, title: "a" });
    const other = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
    });
    expect(await read(reader, hash)).toBe(200);
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: other,
        body: { properties: { title: "b" }, version: item.version },
      }),
      200,
    );
    expect(await read(reader, hash)).toBe(200);
  });

  it("upgrades nothing a writer with the proof did not itself send, on the row or a sibling", async () => {
    const owner = await writer();
    const { hash } = await sent(owner, "planted in a title");
    const planter = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "write" },
    });
    const { item } = await note(planter, { title: hash, body: "original" });
    expect(await read(reader, hash)).toBe(404);

    // The owner edits the body: the merge keeps the planted title, which
    // the owner never sent.
    const edited = await json<Written>(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: owner,
        body: { properties: { body: "the winner" }, version: item.version },
      }),
      200,
    );
    expect(edited.item.version).toBeGreaterThan(item.version);
    expect(await read(reader, hash)).toBe(404);

    // A stale write that collides keeps both; the sibling copies the title.
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}?conflict=auto`, {
        key: owner,
        body: { properties: { body: "the loser" }, version: item.version },
      }),
      200,
    );
    const siblings = (await ctx.storage.items.list({ limit: 500 })).data.filter(
      (row) => row.id !== item.id && row.properties.title === hash,
    );
    expect(siblings).toHaveLength(1);
    expect((await indexed(siblings[0]!.id)).held).toEqual([hash]);
    expect((await indexed(siblings[0]!.id)).lends).toEqual([]);
    expect(await read(reader, hash)).toBe(404);
  });

  it("credits an app's own stored key as itself, whatever source it names", () => {
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
      blobPrincipal(
        { ...base, source: "oauth:c:u", oauth_client_id: "c" },
        "api_key",
      ),
    ).toBe("key:k1");
    expect(blobPrincipal({ ...base, source: "oauth:c:u" }, "oauth")).toBe(
      "oauth:c:u",
    );
  });
});

describe("an upload", () => {
  it("takes write on a registered type, and not on a pattern naming none", async () => {
    const nothingRegistered = await mintWorkingKey(ctx, {
      type_permissions: { "user.nothing-registered": "write" },
    });
    const refused = await sendAs(
      nothingRegistered,
      new TextEncoder().encode("no registered type"),
    );
    expect(refused.status).toBe(403);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("type_not_permitted");

    const noteWriter = await writer();
    const taken = await sendAs(
      noteWriter,
      new TextEncoder().encode("a registered type"),
    );
    expect(taken.status).toBe(201);
  });
});

describe("the enrichment sweep", () => {
  it("reads only bytes a file's own reference lends", async () => {
    const owner = await writer();
    const hidden = await sent(
      owner,
      "the quokka ledger, never sent by the file's writer",
    );
    await note(owner, { body: `![x](${hidden.hash})` });
    const own = await sent(
      ctx.workingKey,
      "the wombat ledger, sent by its writer",
    );
    const fileWriter = await mintWorkingKey(ctx, {
      type_permissions: { "core.file": "write" },
    });
    expect(await read(fileWriter, hidden.hash)).toBe(404);

    const named = await json<Written>(
      await request(ctx.app, "POST", "/items", {
        key: fileWriter,
        body: {
          type: "core.file",
          properties: { blob_ref: hidden.hash, mime_type: "text/plain" },
        },
      }),
      201,
    );
    const witness = await json<Written>(
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.file",
          properties: { blob_ref: own.hash, mime_type: "text/plain" },
        },
      }),
      201,
    );

    await sweeper().runOnce();

    const read_ = async (id: string) =>
      (await ctx.storage.items.get(id))?.properties.extracted_text;
    expect(await read_(witness.item.id)).toContain("the wombat ledger");
    expect(await read_(named.item.id)).toBeUndefined();
  });
});

/** The digests the index holds for one item, and which of them lend. */
async function indexed(id: string): Promise<{
  held: string[];
  named: string[];
  lends: string[];
}> {
  const raw = ctx.storage as unknown as {
    __sqliteAll: (q: string) => Promise<{ hash: string; lends: number }[]>;
  };
  const rows = await raw.__sqliteAll(
    `SELECT hash, lends FROM item_blob_references WHERE item_id = '${id}' ORDER BY hash`,
  );
  const item = await ctx.storage.items.getIncludingTrashed(id);
  const named = new Set<string>();
  collectBlobHashes(item?.properties ?? {}, named);
  return {
    held: rows.map((r) => r.hash),
    named: [...named].sort(),
    lends: rows.filter((r) => r.lends === 1).map((r) => r.hash),
  };
}

describe("the reference index a blob door reads", () => {
  it("follows an item's properties, and a purge takes its rows", async () => {
    const owner = await writer();
    const first = await sent(owner, "first");
    const second = await sent(owner, "second");
    const { item } = await note(owner, { body: `![a](${first.hash})` });
    expect(await indexed(item.id)).toMatchObject({
      held: [first.hash],
      named: [first.hash],
    });
    await json(
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: owner,
        body: {
          properties: { body: `![b](${second.hash})` },
          version: item.version,
        },
      }),
      200,
    );
    expect(await indexed(item.id)).toMatchObject({
      held: [second.hash],
      named: [second.hash],
    });
    expect(await read(reader, first.hash)).toBe(404);
    expect(await read(reader, second.hash)).toBe(200);

    await itemWrites(ctx.storage).transition(item.id, "trashed");
    expect(await read(reader, second.hash)).toBe(200);
    await itemWrites(ctx.storage).purge(item.id);
    expect((await indexed(item.id)).held).toEqual([]);
    expect(await read(reader, second.hash)).toBe(404);
  });
});
