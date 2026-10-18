/**
 * An archive names each blob it should carry and cannot: a copy whose file
 * went from the disk, a blob with no copy left, or one whose only bytes
 * linger after a strike. A blob another store holds is still carried, and
 * bytes that do not hash to their name end the response with an error. A
 * restore answers which named blobs neither the archive nor the instance
 * holds.
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";
import { BlobReplicator } from "../housekeeping/blob-replicate.js";
import {
  closeTestContexts,
  createTestContext,
  request,
  withSecondStore,
  type TestContext,
} from "../test-utils.js";

const contexts: TestContext[] = [];
async function context() {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}
afterEach(() => {
  __resetEventLogForTests();
  vi.restoreAllMocks();
});
afterAll(() => closeTestContexts(contexts));

interface Manifest {
  blob_count: number;
  blobs: Record<string, { mime_type: string; size_bytes: number }>;
  missing_blobs: Record<string, { mime_type: string; size_bytes: number }>;
}

async function upload(ctx: TestContext, content: string): Promise<string> {
  const res = await ctx.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      "Content-Type": "text/plain",
    },
    body: new TextEncoder().encode(content),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { hash: string }).hash;
}

async function noteNaming(ctx: TestContext, hash: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: `![x](${hash})` } },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

function diskPath(ctx: TestContext, hash: string): string {
  const hex = hash.slice("sha256:".length);
  return join(ctx.blobs.disk.locator, hex.slice(0, 4), hex);
}

function exportArchive(ctx: TestContext) {
  return request(ctx.app, "GET", "/export?format=archive", {
    key: ctx.workingKey,
  });
}

async function unpack(bytes: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => {
        if (!Buffer.isBuffer(chunk)) throw new Error("Expected archive bytes");
        chunks.push(chunk);
      });
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    gunzip.on("error", reject);
    Readable.from(bytes).pipe(gunzip).pipe(extract);
  });
  return entries;
}

async function pack(entries: Map<string, Buffer>): Promise<Buffer> {
  const archive = tar.pack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  archive.pipe(gzip);
  for (const [name, data] of entries) archive.entry({ name }, data);
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

async function exported(ctx: TestContext) {
  const res = await exportArchive(ctx);
  expect(res.status).toBe(200);
  const entries = await unpack(Buffer.from(await res.arrayBuffer()));
  const manifest = JSON.parse(
    entries.get("manifest.json")!.toString(),
  ) as Manifest;
  return { entries, manifest };
}

function restore(ctx: TestContext, archive: Buffer) {
  initEventLog(ctx.storage.eventLog);
  return ctx.app.request("/restore", {
    method: "POST",
    headers: {
      cookie: ctx.owner.cookie,
      origin: new URL(ctx.config.authBaseUrl).origin,
      "Content-Type": "application/gzip",
    },
    body: archive,
  });
}

describe("an archive export of a blob it cannot read", () => {
  it("names a blob whose only copy left the disk under missing_blobs and carries the rest", async () => {
    const ctx = await context();
    const kept = await upload(ctx, "the bytes that stay");
    const lost = await upload(ctx, "the bytes whose file goes");
    await noteNaming(ctx, kept);
    await noteNaming(ctx, lost);

    // The witness: both are carried while both files are there.
    const before = await exported(ctx);
    expect(Object.keys(before.manifest.blobs).sort()).toEqual(
      [kept, lost].sort(),
    );
    expect(before.manifest.missing_blobs).toEqual({});
    expect(before.entries.has(`blobs/${lost}`)).toBe(true);

    await rm(diskPath(ctx, lost));
    const { entries, manifest } = await exported(ctx);
    expect(manifest.blob_count).toBe(1);
    expect(Object.keys(manifest.blobs)).toEqual([kept]);
    expect(manifest.missing_blobs).toEqual({
      [lost]: {
        mime_type: "text/plain",
        size_bytes: "the bytes whose file goes".length,
      },
    });
    expect(entries.has(`blobs/${kept}`)).toBe(true);
    expect(entries.has(`blobs/${lost}`)).toBe(false);
  });

  it("names a blob that has lost its last recorded copy", async () => {
    const ctx = await context();
    const hash = await upload(ctx, "a blob with no copy left");
    await noteNaming(ctx, hash);
    expect(
      await ctx.storage.blobs.removeLocation(hash, ctx.blobs.disk.id),
    ).toBe(true);
    await rm(diskPath(ctx, hash));

    const { entries, manifest } = await exported(ctx);
    expect(manifest.blobs).toEqual({});
    expect(Object.keys(manifest.missing_blobs)).toEqual([hash]);
    expect(entries.has(`blobs/${hash}`)).toBe(false);
  });

  it("does not carry the bytes a struck copy left in its store", async () => {
    const ctx = await context();
    const hash = await upload(ctx, "bytes that outlive their copy");
    await noteNaming(ctx, hash);
    // The log no longer records the copy, though the file is still there.
    await ctx.storage.blobs.removeLocation(hash, ctx.blobs.disk.id);

    const { entries, manifest } = await exported(ctx);
    expect(Object.keys(manifest.missing_blobs)).toEqual([hash]);
    expect(entries.has(`blobs/${hash}`)).toBe(false);
  });

  it("names a blob whose store fails to answer for it under missing_blobs, and carries the rest", async () => {
    const ctx = await context();
    const kept = await upload(ctx, "bytes the store answers for");
    const unanswered = await upload(ctx, "bytes the store fails on");
    await noteNaming(ctx, kept);
    await noteNaming(ctx, unanswered);
    const has = ctx.blobs.disk.has.bind(ctx.blobs.disk);
    vi.spyOn(ctx.blobs.disk, "has").mockImplementation(async (hash) => {
      if (hash === unanswered) {
        throw Object.assign(new Error("permission denied"), {
          code: "EACCES",
        });
      }
      return has(hash);
    });

    const { entries, manifest } = await exported(ctx);
    expect(Object.keys(manifest.blobs)).toEqual([kept]);
    expect(Object.keys(manifest.missing_blobs)).toEqual([unanswered]);
    expect(entries.has(`blobs/${kept}`)).toBe(true);
  });

  it("carries a blob whose disk file is gone from another store that holds a copy", async () => {
    const ctx = await context();
    const { stores } = await withSecondStore(ctx);
    const content = "bytes the second store also holds";
    const hash = await upload(ctx, content);
    await noteNaming(ctx, hash);
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();
    expect(await ctx.storage.blobs.listLocations(hash)).toHaveLength(2);

    await rm(diskPath(ctx, hash));
    const { entries, manifest } = await exported(ctx);
    expect(Object.keys(manifest.blobs)).toEqual([hash]);
    expect(manifest.missing_blobs).toEqual({});
    expect(entries.get(`blobs/${hash}`)?.toString()).toBe(content);
  });

  it("carries a blob whose disk copy is short from another store that holds it whole", async () => {
    const ctx = await context();
    const { stores } = await withSecondStore(ctx);
    const content = "bytes cut short on the disk";
    const hash = await upload(ctx, content);
    await noteNaming(ctx, hash);
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();

    await writeFile(diskPath(ctx, hash), "bytes cut");
    const { entries, manifest } = await exported(ctx);
    expect(manifest.missing_blobs).toEqual({});
    expect(entries.get(`blobs/${hash}`)?.toString()).toBe(content);
  });

  it("ends the response with an error when a copy's bytes do not hash to its name", async () => {
    const ctx = await context();
    const content = "bytes that rot in place";
    const hash = await upload(ctx, content);
    await noteNaming(ctx, hash);
    // The witness: the same export reads whole while the bytes are sound.
    await exported(ctx);

    await writeFile(diskPath(ctx, hash), "x".repeat(content.length));
    const res = await exportArchive(ctx);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it("answers an NDJSON export of an item that names a lost blob, which carries no bytes", async () => {
    const ctx = await context();
    const hash = await upload(ctx, "bytes an NDJSON export never reads");
    const id = await noteNaming(ctx, hash);
    await rm(diskPath(ctx, hash));

    const res = await request(ctx.app, "GET", "/export", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { item?: { id: string } });
    expect(lines.map((line) => line.item?.id)).toContain(id);
  });
});

describe("a restore of an archive that lacks a blob it names", () => {
  async function archiveNaming(contents: string[]) {
    const source = await context();
    const hashes: string[] = [];
    for (const content of contents) {
      const hash = await upload(source, content);
      await noteNaming(source, hash);
      hashes.push(hash);
    }
    const res = await exportArchive(source);
    expect(res.status).toBe(200);
    return {
      hashes,
      entries: await unpack(Buffer.from(await res.arrayBuffer())),
    };
  }

  it("answers the blobs the manifest lists that the archive does not carry", async () => {
    const { hashes, entries } = await archiveNaming([
      "carried bytes",
      "bytes the archive dropped",
    ]);
    const [carried, dropped] = hashes as [string, string];
    entries.delete(`blobs/${dropped}`);

    const target = await context();
    const res = await restore(target, await pack(entries));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      imported: 2,
      blobs_imported: 1,
      blobs_missing: [dropped],
    });
    expect(await target.storage.blobs.get(carried)).not.toBeNull();
  });

  it("answers a blob whose entry does not hash to its name as missing", async () => {
    const { hashes, entries } = await archiveNaming(["bytes to be altered"]);
    const [hash] = hashes as [string];
    entries.set(`blobs/${hash}`, Buffer.from("other bytes altogether"));

    const target = await context();
    const res = await restore(target, await pack(entries));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      blobs_imported: 0,
      blobs_missing: [hash],
    });
  });

  it("answers the blobs the manifest names under missing_blobs", async () => {
    const source = await context();
    const hash = await upload(source, "bytes lost before the export");
    await noteNaming(source, hash);
    await rm(diskPath(source, hash));
    const res = await exportArchive(source);
    const archive = Buffer.from(await res.arrayBuffer());

    const target = await context();
    const restored = await restore(target, archive);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restored.json()).toMatchObject({
      imported: 1,
      blobs_imported: 0,
      blobs_missing: [hash],
    });
  });

  it("answers no blob as missing that the instance already holds", async () => {
    const { hashes, entries } = await archiveNaming(["bytes both hold"]);
    const [hash] = hashes as [string];
    entries.delete(`blobs/${hash}`);

    const target = await context();
    const held = await upload(target, "bytes both hold");
    expect(held).toBe(hash);
    const res = await restore(target, await pack(entries));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ blobs_missing: [] });
  });

  it("answers an empty list for an archive that carries every blob it names", async () => {
    const { entries } = await archiveNaming(["bytes carried whole"]);
    const target = await context();
    const res = await restore(target, await pack(entries));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      blobs_imported: 1,
      blobs_missing: [],
    });
  });
});
