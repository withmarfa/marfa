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
import { BlobIntegrityChecker } from "../housekeeping/blob-integrity.js";
import { BlobOrphanReporter } from "../housekeeping/blob-orphans.js";
import { storeChecks } from "../storage/blob-layer.js";
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

  it("answers 503 blob_store_unavailable, not missing_blobs, when a store fails to answer for a blob", async () => {
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

    const res = await exportArchive(ctx);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "blob_store_unavailable",
    );
  });

  it("answers 503 blob_store_unavailable when a store does not answer in time", async () => {
    const ctx = await context();
    const { second } = await withSecondStore(ctx);
    const hash = await upload(ctx, "bytes only a hanging store holds");
    await noteNaming(ctx, hash);
    await ctx.storage.blobs.recordLocation(hash, second.id);
    await rm(diskPath(ctx, hash));
    vi.spyOn(second, "has").mockImplementation(
      () => new Promise(() => undefined),
    );
    const timeout = storeChecks.timeoutMs;
    storeChecks.timeoutMs = 50;
    try {
      const res = await exportArchive(ctx);
      expect(res.status).toBe(503);
    } finally {
      storeChecks.timeoutMs = timeout;
    }
  });

  it("checks the copies of many blobs a few at a time, with one location read a page", async () => {
    const ctx = await context();
    const { second } = await withSecondStore(ctx);
    const hashes: string[] = [];
    for (let i = 0; i < 60; i++) {
      const hash = await upload(ctx, `bytes number ${String(i)} of many`);
      await ctx.storage.blobs.recordLocation(hash, second.id);
      await rm(diskPath(ctx, hash));
      hashes.push(hash);
    }
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: hashes.map((h) => `![x](${h})`).join(" ") },
      },
    });
    expect(res.status).toBe(201);
    let running = 0;
    let most = 0;
    vi.spyOn(second, "has").mockImplementation(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return null;
    });
    const listLocations = vi.spyOn(ctx.storage.blobs, "listLocations");

    const { manifest } = await exported(ctx);
    expect(Object.keys(manifest.missing_blobs)).toHaveLength(60);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(storeChecks.concurrency);
    expect(listLocations).not.toHaveBeenCalled();
  });

  it("strikes a copy whose bytes do not hash to its name, and the next export reads another store's", async () => {
    const ctx = await context();
    const { stores } = await withSecondStore(ctx);
    const content = "bytes that rot on the disk alone";
    const hash = await upload(ctx, content);
    await noteNaming(ctx, hash);
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();
    await writeFile(diskPath(ctx, hash), "x".repeat(content.length));

    const cut = await exportArchive(ctx);
    expect(cut.status).toBe(200);
    await expect(cut.arrayBuffer()).rejects.toThrow();
    expect(
      (await ctx.storage.blobs.listLocations(hash)).map((l) => l.store_id),
    ).not.toContain(ctx.blobs.disk.id);

    const { entries, manifest } = await exported(ctx);
    expect(manifest.missing_blobs).toEqual({});
    expect(entries.get(`blobs/${hash}`)?.toString()).toBe(content);
  });

  it("ends the response with an error when a listed blob's last copy goes before its entry", async () => {
    const ctx = await context();
    const hash = await upload(ctx, "bytes deleted while the export runs");
    await noteNaming(ctx, hash);
    const get = ctx.blobs.disk.get.bind(ctx.blobs.disk);
    vi.spyOn(ctx.blobs.disk, "get").mockImplementation(async (wanted) => {
      if (wanted === hash) {
        await ctx.storage.blobs.removeLocation(hash, ctx.blobs.disk.id);
        return null;
      }
      return get(wanted);
    });

    const res = await exportArchive(ctx);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
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

  it("registers a blob it answers as missing, so every export after it names the blob too", async () => {
    const source = await context();
    const hash = await upload(source, "bytes lost before the backup");
    await noteNaming(source, hash);
    await rm(diskPath(source, hash));
    const archive = Buffer.from(
      await (await exportArchive(source)).arrayBuffer(),
    );

    const target = await context();
    const restored = await restore(target, archive);
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restored.json()).toMatchObject({ blobs_missing: [hash] });
    expect(await target.storage.blobs.get(hash)).toEqual({
      mime_type: "text/plain",
      size_bytes: "bytes lost before the backup".length,
    });
    expect(await target.storage.blobs.listLocations(hash)).toEqual([]);

    // The jobs that walk the registry take a blob with no copy in their
    // stride, and none of them claims a copy of it.
    const { stores } = await withSecondStore(target);
    const bounds = { maxBlobs: 100, maxBytes: 1024 * 1024 };
    await new BlobReplicator(target.storage, stores, bounds).runOnce();
    await new BlobIntegrityChecker(target.storage, stores, {
      maxRows: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();
    await new BlobOrphanReporter(target.storage, stores, 0).runOnce();
    expect(await target.storage.blobs.listLocations(hash)).toEqual([]);

    const res = await request(target.app, "GET", "/export?format=archive", {
      headers: { cookie: target.owner.cookie },
    });
    expect(res.status).toBe(200);
    const entries = await unpack(Buffer.from(await res.arrayBuffer()));
    const manifest = JSON.parse(
      entries.get("manifest.json")!.toString(),
    ) as Manifest;
    expect(Object.keys(manifest.missing_blobs)).toEqual([hash]);
  });

  it("answers 503 blob_store_unavailable and writes nothing when a store fails to answer for a named blob", async () => {
    const { hashes, entries } = await archiveNaming([
      "bytes a failing store holds",
    ]);
    const [hash] = hashes as [string];
    entries.delete(`blobs/${hash}`);

    const target = await context();
    expect(await upload(target, "bytes a failing store holds")).toBe(hash);
    const before = await target.storage.items.list({ limit: 100 });
    vi.spyOn(target.blobs.disk, "has").mockRejectedValue(
      Object.assign(new Error("I/O error"), { code: "EIO" }),
    );
    const res = await restore(target, await pack(entries));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "blob_store_unavailable",
    );
    expect(
      (await target.storage.items.list({ limit: 100 })).data.map((i) => i.id),
    ).toEqual(before.data.map((i) => i.id));
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
