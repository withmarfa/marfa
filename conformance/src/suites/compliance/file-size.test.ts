import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  trackItem,
  trackKey,
} from "../../utils/setup.js";

/**
 * `blobs.md` 31 and 32: a file item's `size_bytes` is the stored length of
 * the bytes its `blob_ref` names where that reference lends, whatever the
 * write said, and absent where it does not.
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
});
