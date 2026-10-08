import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getManagementClient,
  trackItem,
  trackKey,
  trackType,
} from "../../utils/setup.js";
import { tarGz } from "../../utils/archive.js";
import { v7 as uuidv7 } from "uuid";

/**
 * `blobs/file-size-set` and `blobs/file-size-none`: a file item's `size_bytes`
 * is the stored length of the bytes its `blob_ref` names where that reference
 * lends, whatever the write said, and absent where it does not.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let seq = 0;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "file-size",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** This run's own bytes, `extra` long beyond their label. */
function bytesOf(extra: number): Uint8Array {
  seq += 1;
  return new TextEncoder().encode(
    `file-size ${ctx.runId} ${String(seq)} ${"x".repeat(extra)}`,
  );
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function upload(
  extra: number,
  as = client,
): Promise<{ hash: string; size: number }> {
  const bytes = bytesOf(extra);
  const res = await as.uploadBlob(bytes, "image/png");
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  expect(res.data.size_bytes).toBe(bytes.length);
  return { hash: res.data.hash, size: bytes.length };
}

async function file(
  properties: Record<string, unknown>,
  type = "core.file",
  as = client,
  source = ctx.source,
): Promise<MarfaItem> {
  const res = await as.createItem({
    type,
    source,
    properties: { mime_type: "image/png", title: "sized", ...properties },
  });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  trackItem(ctx, res.data.item.id);
  return res.data.item;
}

async function update(
  item: MarfaItem,
  properties: Record<string, unknown>,
): Promise<MarfaItem> {
  const res = await client.updateItem(item.id, {
    version: item.version,
    properties,
  });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return res.data.item;
}

async function sizeOf(id: string): Promise<unknown> {
  const res = await client.getItem(id);
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return res.data.item.properties.size_bytes;
}

describe("a file item carries the size of the bytes it names", () => {
  it("is set on a create that names none, and on one that names another", async () => {
    const blob = await upload(120);
    const plain = await file({ blob_ref: blob.hash });
    expect(plain.properties.size_bytes).toBe(blob.size);
    expect(await sizeOf(plain.id)).toBe(blob.size);
    const lying = await file({ blob_ref: blob.hash, size_bytes: 1 });
    expect(lying.properties.size_bytes).toBe(blob.size);
    expect(await sizeOf(lying.id)).toBe(blob.size);
  });

  it("follows an update that names other bytes, and survives one that clears it", async () => {
    const first = await upload(3);
    const second = await upload(900);
    const item = await file({ blob_ref: first.hash });
    const moved = await update(item, { blob_ref: second.hash });
    expect(moved.properties.size_bytes).toBe(second.size);
    const cleared = await update(moved, { size_bytes: null });
    expect(cleared.properties.size_bytes).toBe(second.size);
    expect(await sizeOf(item.id)).toBe(second.size);
  });

  it("holds for every file type", async () => {
    for (const type of [
      "core.file.image",
      "core.file.audio",
      "core.file.video",
    ]) {
      const blob = await upload(type.length * 3);
      const item = await file({ blob_ref: blob.hash }, type);
      expect(item.properties.size_bytes, type).toBe(blob.size);
    }
  });

  it("is set on a bulk upsert's create and on its update", async () => {
    const first = await upload(17);
    const second = await upload(170);
    const sourceId = `file-size-${ctx.runId}`;
    const entry = (hash: string) => ({
      type: "core.file",
      source: ctx.source,
      source_id: sourceId,
      properties: { blob_ref: hash, mime_type: "image/png", size_bytes: 5 },
    });
    const created = await client.bulkItems([entry(first.hash)]);
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const id = String(created.data.results[0]?.id);
    trackItem(ctx, id);
    expect(created.data.results[0]?.outcome).toBe("created");
    expect(await sizeOf(id)).toBe(first.size);
    const updated = await client.bulkItems([entry(second.hash)]);
    expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
    expect(updated.data.results[0]?.outcome).toBe("updated");
    expect(await sizeOf(id)).toBe(second.size);
  });

  it("follows an update that replaces the properties, and is gone once they name no blob", async () => {
    const first = await upload(14);
    const second = await upload(140);
    const item = await file({ blob_ref: first.hash });
    const replaced = await client.updateItem(item.id, {
      version: item.version,
      properties_mode: "replace",
      properties: { blob_ref: second.hash, mime_type: "image/png" },
    });
    expect(replaced.ok, JSON.stringify(replaced.error)).toBe(true);
    expect(replaced.data.item.properties.size_bytes).toBe(second.size);
    expect(await sizeOf(item.id)).toBe(second.size);

    const unnamed = await client.updateItem(item.id, {
      version: replaced.data.item.version,
      properties_mode: "replace",
      properties: { blob_ref: "no blob yet", mime_type: "image/png" },
    });
    expect(unnamed.ok, JSON.stringify(unnamed.error)).toBe(true);
    expect(unnamed.data.item.properties.size_bytes).toBeUndefined();
    expect(await sizeOf(item.id)).toBeUndefined();
  });

  it("is set by a bulk action's property patch, whatever size the patch carried", async () => {
    const first = await upload(7);
    const second = await upload(70);
    const tag = `file-size-${ctx.runId}-action`;
    const made = await client.createItem({
      type: "core.file",
      source: ctx.source,
      tags: [tag],
      properties: { blob_ref: first.hash, mime_type: "image/png" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    expect(made.data.item.properties.size_bytes).toBe(first.size);

    const queued = await client.bulkAction({
      action: "update_properties",
      patch: { blob_ref: second.hash, size_bytes: 1, title: "patched" },
      filter: { tags: [tag] },
    });
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const job = await client.pollBulkActionToTerminal(
      (queued.data as { id: string }).id,
    );
    expect(job.result?.succeeded).toBe(1);
    const after = await client.getItem(made.data.item.id);
    expect(after.data.item.properties.title).toBe("patched");
    expect(after.data.item.properties.size_bytes).toBe(second.size);
  });

  it("is set on a restore from an archive that carries another size, and none where the line lent nothing", async () => {
    const lent = bytesOf(31);
    const unlent = bytesOf(310);
    const lentId = uuidv7();
    const unlentId = uuidv7();
    const line = (id: string, bytes: Uint8Array, lends: boolean) =>
      JSON.stringify({
        item: {
          id,
          type: "core.file",
          source: ctx.source,
          properties: {
            blob_ref: sha256(bytes),
            mime_type: "image/png",
            size_bytes: 1,
          },
        },
        metadata: { tags: [], extensions: {} },
        ...(lends && { lending_blobs: [sha256(bytes)] }),
      });
    const archive = tarGz([
      {
        name: "manifest.json",
        body: JSON.stringify({
          version: 0,
          format: "marfa-archive-v0",
          created_at: new Date().toISOString(),
          item_count: 2,
          edge_count: 0,
          blob_count: 2,
          type_count: 0,
          edge_type_count: 0,
          blobs: Object.fromEntries(
            [lent, unlent].map((bytes) => [
              sha256(bytes),
              { mime_type: "image/png", size_bytes: bytes.length },
            ]),
          ),
        }),
      },
      {
        name: "items.ndjson",
        body: `${line(lentId, lent, true)}\n${line(unlentId, unlent, false)}\n`,
      },
      { name: `blobs/${sha256(lent)}`, body: lent },
      { name: `blobs/${sha256(unlent)}`, body: unlent },
      { name: "edges.ndjson", body: "" },
      { name: "types.ndjson", body: "" },
    ]);
    const restored = await getManagementClient().restoreArchive(archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, lentId);
    trackItem(ctx, unlentId);

    expect(await sizeOf(lentId)).toBe(lent.length);
    // The instance holds these bytes, and the line did not say they lent.
    expect(
      (await getManagementClient().downloadBlob(sha256(unlent))).status,
    ).toBe(200);
    expect(await sizeOf(unlentId)).toBeUndefined();
  });
});

describe("a file item carries its size through a move and a merge", () => {
  it("is set on a retype into a file type", async () => {
    const blob = await upload(33);
    const made = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: {
        title: "to be a file",
        body: "bytes",
        blob_ref: blob.hash,
        mime_type: "image/png",
      },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    expect(made.data.item.properties.size_bytes).toBeUndefined();
    const moved = await client.updateItem(made.data.item.id, {
      version: made.data.item.version,
      type: "core.file",
      retype: true,
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    expect(moved.data.item.properties.size_bytes).toBe(blob.size);
  });

  it("is set on a stale write and on the keep-both copy it makes", async () => {
    const type = `fixture.${ctx.runId}.kept_file`;
    const registered = await client.registerType({
      id: type,
      parent: "core.file",
      fields: {},
      merge_policy: {
        fields: { blob_ref: "keep_both_copies" },
        default: "last_writer_wins",
      },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackType(ctx, type);
    const base = await upload(1);
    const theirs = await upload(50);
    const mine = await upload(500);
    const item = await file({ blob_ref: base.hash }, type);
    await update(item, { blob_ref: theirs.hash });
    const resolved = await client.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${item.id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { blob_ref: mine.hash, size_bytes: 7 },
        version: item.version,
      },
    });
    expect(resolved.ok, JSON.stringify(resolved.error)).toBe(true);
    const now = await client.getItem(item.id);
    expect(now.ok, JSON.stringify(now.error)).toBe(true);
    const held = now.data.item.properties;
    expect(held.size_bytes).toBe(
      held.blob_ref === theirs.hash ? theirs.size : mine.size,
    );
    const copyId = resolved.data.conflict_resolution?.conflicted_copy_id;
    expect(copyId, "no conflicted copy was written").toBeTruthy();
    trackItem(ctx, String(copyId));
    const copy = await client.getItem(String(copyId));
    expect(copy.ok, JSON.stringify(copy.error)).toBe(true);
    expect(copy.data.item.properties.blob_ref).toBe(mine.hash);
    expect(copy.data.item.properties.size_bytes).toBe(mine.size);
  });
});

describe("a stale write to a file item and its size", () => {
  /** A file whose bytes moved on after the version a writer read, so that a
   *  write based on `read` is stale and the size changed with the bytes. */
  async function moved(): Promise<{
    read: MarfaItem;
    first: { hash: string; size: number };
    second: { hash: string; size: number };
  }> {
    const first = await upload(11);
    const second = await upload(110);
    const read = await file({ blob_ref: first.hash });
    const current = await update(read, { blob_ref: second.hash });
    expect(current.properties.size_bytes).toBe(second.size);
    return { read, first, second };
  }

  async function stale(
    id: string,
    body: Record<string, unknown>,
  ): ReturnType<MarfaClient["rawRequest"]> {
    return client.rawRequest(`/items/${id}`, { method: "PATCH", body });
  }

  it("does not collide on a size it carries as a whole number or null, and merges the rest", async () => {
    // The witness: a stale write naming other bytes does collide, on the
    // bytes and not on the size it carried beside them.
    const witness = await moved();
    const third = await upload(1100);
    const collided = await stale(witness.read.id, {
      version: witness.read.version,
      properties: { blob_ref: third.hash, size_bytes: 123456 },
    });
    expect(collided.status).toBe(409);
    expect(
      (collided.error as unknown as { conflicting_fields: string[] })
        .conflicting_fields,
    ).toEqual(["blob_ref"]);

    for (const carried of [123456, null]) {
      const { read, second } = await moved();
      const merged = await stale(read.id, {
        version: read.version,
        properties: { size_bytes: carried, title: "retitled while stale" },
      });
      expect(merged.status, JSON.stringify(merged.error)).toBe(200);
      const after = await client.getItem(read.id);
      expect(after.data.item.properties.title).toBe("retitled while stale");
      expect(after.data.item.properties.blob_ref).toBe(second.hash);
      expect(after.data.item.properties.size_bytes).toBe(second.size);
    }
  });

  it("does not count a size it leaves out of a whole replacement as a cleared property", async () => {
    const { read, first, second } = await moved();
    const replaced = await stale(read.id, {
      version: read.version,
      properties_mode: "replace",
      properties: {
        blob_ref: first.hash,
        mime_type: "image/png",
        title: "replaced while stale",
      },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    const after = await client.getItem(read.id);
    expect(after.data.item.properties.title).toBe("replaced while stale");
    // Naming the bytes it read is no change, so the newer bytes stand.
    expect(after.data.item.properties.blob_ref).toBe(second.hash);
    expect(after.data.item.properties.size_bytes).toBe(second.size);
  });

  it("refuses a size of another shape on a create, an update and a stale write", async () => {
    const blob = await upload(13);
    const read = await file({ blob_ref: blob.hash });
    // Moved on without the size changing, so a stale write meets no collision
    // before its properties are judged.
    await update(read, { title: "moved on" });
    const whole = await stale(read.id, {
      version: read.version,
      properties: { size_bytes: 77 },
    });
    expect(whole.status, JSON.stringify(whole.error)).toBe(200);

    for (const wrong of ["12", 1.5]) {
      const created = await client.createItem({
        type: "core.file",
        source: ctx.source,
        properties: {
          blob_ref: blob.hash,
          mime_type: "image/png",
          size_bytes: wrong,
        },
      });
      expect(created.status, JSON.stringify(wrong)).toBe(400);
      expect(created.error?.error.code).toBe("invalid_properties");

      const held = await client.getItem(read.id);
      const updated = await client.updateItem(read.id, {
        version: held.data.item.version,
        properties: { size_bytes: wrong as number },
      });
      expect(updated.status, JSON.stringify(wrong)).toBe(400);
      expect(updated.error?.error.code).toBe("invalid_properties");

      const late = await stale(read.id, {
        version: read.version,
        properties: { size_bytes: wrong },
      });
      expect(late.status, JSON.stringify(wrong)).toBe(400);
      expect(late.error?.error.code).toBe("invalid_properties");
    }
    expect(await sizeOf(read.id)).toBe(blob.size);
  });
});

describe("a file item names no size its writer could not read", () => {
  it("carries none for bytes its writer never sent, where the writer that sent them is told", async () => {
    const minted = await client.createKey({
      label: `${ctx.source}-planter`,
      source: `${ctx.source}-planter`,
      type_permissions: { "core.file": "write" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const planter = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const blob = await upload(64);
    const planted = await file(
      { blob_ref: blob.hash, size_bytes: blob.size },
      "core.file",
      planter,
      `${ctx.source}-planter`,
    );
    expect(planted.properties.size_bytes).toBeUndefined();
    expect(await sizeOf(planted.id)).toBeUndefined();
    const proved = await file({ blob_ref: blob.hash });
    expect(proved.properties.size_bytes).toBe(blob.size);
  });

  it("carries none for bytes not yet uploaded, and has it once the digest is written again with them", async () => {
    const bytes = bytesOf(40);
    const early = await file({
      blob_ref: sha256(bytes),
      size_bytes: bytes.length,
    });
    expect(early.properties.size_bytes).toBeUndefined();
    const sent = await client.uploadBlob(bytes, "image/png");
    expect(sent.status, JSON.stringify(sent.error)).toBe(201);
    const later = await update(early, { title: "after the upload" });
    expect(later.properties.size_bytes).toBeUndefined();
    const elsewhere = await upload(2);
    const away = await update(later, { blob_ref: elsewhere.hash });
    const back = await update(away, { blob_ref: sha256(bytes) });
    expect(back.properties.size_bytes).toBe(bytes.length);
  });

  it("carries none for a reference that names no blob the instance could lend, on a create and an update", async () => {
    const blob = await upload(28);
    const bare = blob.hash.slice("sha256:".length);
    const unheld = `sha256:${"0".repeat(63)}1`;
    for (const naming of [bare, unheld, "a name, not a digest"]) {
      const created = await file({ blob_ref: naming, size_bytes: blob.size });
      expect(created.properties.size_bytes, naming).toBeUndefined();
      const updated = await update(created, {
        title: "retitled",
        size_bytes: blob.size,
      });
      expect(updated.properties.size_bytes, naming).toBeUndefined();
      expect(await sizeOf(created.id), naming).toBeUndefined();
    }
    // The witness: the digest the first of these spelled without its prefix
    // is sized once it is spelled whole.
    const whole = await file({ blob_ref: blob.hash });
    expect(whole.properties.size_bytes).toBe(blob.size);
  });

  it("carries none for bytes its writer never sent, whatever an update of the file says", async () => {
    const minted = await client.createKey({
      label: `${ctx.source}-updater`,
      source: `${ctx.source}-updater`,
      type_permissions: { "core.file": "write" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const planter = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const blob = await upload(65);
    const other = await upload(2);
    const planted = await file(
      { blob_ref: other.hash },
      "core.file",
      planter,
      `${ctx.source}-updater`,
    );
    expect(planted.properties.size_bytes).toBeUndefined();
    const named = await planter.updateItem(planted.id, {
      version: planted.version,
      properties: { blob_ref: blob.hash, size_bytes: blob.size },
    });
    expect(named.ok, JSON.stringify(named.error)).toBe(true);
    expect(named.data.item.properties.size_bytes).toBeUndefined();
    expect(await sizeOf(planted.id)).toBeUndefined();
  });
});
