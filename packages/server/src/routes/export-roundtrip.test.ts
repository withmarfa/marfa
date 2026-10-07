/**
 * The property under test is the round trip itself: an export carries
 * everything the content is made of — items under their original
 * ids, tags, extensions, and the edges between them — and a restore
 * onto a fresh database reproduces it. Every assertion here exists
 * because the thing it checks was once silently dropped: edges were
 * never exported while the route's description said they were, restored
 * items were re-minted under new ids (dangling every edge an archive
 * could have carried), and metadata was parsed and discarded.
 */

import { itemWrites } from "../storage/item-writes.js";
import { createHash } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { describe, expect, it, afterAll } from "vitest";
import * as tar from "tar-stream";
import {
  closeTestContexts,
  createTestContext,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

async function extractArchive(data: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c) => {
        if (!Buffer.isBuffer(c)) throw new Error("Expected archive bytes");
        chunks.push(c);
      });
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    Readable.from(data).pipe(gunzip).pipe(extract);
  });
  return entries;
}

async function buildArchive(
  manifest: Record<string, unknown>,
  itemLines: string[],
  edgeLines: string[],
): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  pack.pipe(gzip);

  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  pack.entry({ name: "manifest.json", size: manifestBuf.length }, manifestBuf);
  const itemsBuf = Buffer.from(itemLines.join("\n") + "\n");
  pack.entry({ name: "items.ndjson", size: itemsBuf.length }, itemsBuf);
  const edgesBuf = Buffer.from(
    edgeLines.length > 0 ? edgeLines.join("\n") + "\n" : "",
  );
  pack.entry({ name: "edges.ndjson", size: edgesBuf.length }, edgesBuf);
  pack.finalize();

  await new Promise<void>((resolve) => gzip.on("end", resolve));
  return Buffer.concat(chunks);
}

interface RestoreResult {
  imported: number;
  duplicates: number;
  edges_imported: number;
  edges_skipped: number;
  blobs_imported: number;
}

const contexts: TestContext[] = [];
async function newContext(): Promise<TestContext> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterAll(async () => {
  await closeTestContexts(contexts);
});

describe("export → restore round trip", () => {
  it("reproduces items, ids, tags, extensions, and edges on a fresh database", async () => {
    const source = await newContext();
    const destination = await newContext();

    const note1 = await itemWrites(source.storage).create({
      type: "core.note",
      properties: { title: "First", body: "carries tags and an extension" },
      source: "rt-seed",
      source_id: "n1",
      tier: "feed",
      occurred_at: "2026-01-01T00:00:00.000Z",
      tags: ["alpha", "beta"],
    });
    const note2 = await itemWrites(source.storage).create({
      type: "core.note",
      properties: { title: "Second", body: "archived on purpose" },
      source: "rt-seed",
      source_id: "n2",
      state: "archived",
    });
    const note3 = await itemWrites(source.storage).create({
      type: "core.note",
      properties: { title: "Third", body: "plain" },
      source: "rt-seed",
      source_id: "n3",
    });
    await source.storage.metadata.setExtension(
      note1.id,
      "roundtrip.test",
      {
        checked: true,
        label: "kept",
      },
      null,
    );
    const edge1 = await source.storage.edges.createRaw({
      source_id: note1.id,
      target_id: note2.id,
      edge_type: "references",
      properties: { context: "see also" },
    });
    const edge2 = await source.storage.edges.createRaw({
      source_id: note3.id,
      target_id: note1.id,
      edge_type: "references",
    });

    const exportRes = await request(
      source.app,
      "GET",
      `/export?format=archive`,
      { key: source.workingKey },
    );
    expect(exportRes.status).toBe(200);
    const archive = Buffer.from(await exportRes.arrayBuffer());

    const entries = await extractArchive(archive);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      item_count: number;
      edge_count: number;
    };
    expect(manifest.item_count).toBe(3);
    expect(manifest.edge_count).toBe(2);
    expect(entries.has("edges.ndjson")).toBe(true);

    const restoreRes = await destination.app.request(`/restore`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${destination.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(restoreRes.status).toBe(200);
    const result = (await restoreRes.json()) as RestoreResult;
    expect(result.imported).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.edges_imported).toBe(2);
    expect(result.edges_skipped).toBe(0);

    // Metadata changes the row's clock, so compare with the stored frame,
    // not the earlier create result.
    for (const original of [note1, note2, note3]) {
      const restored = await destination.storage.items.get(original.id);
      expect(restored, `item ${original.source_id ?? original.id}`).not.toBe(
        null,
      );
      expect(restored).toEqual(await source.storage.items.get(original.id));
      expect(restored?.type).toBe(original.type);
      expect(restored?.properties).toEqual(original.properties);
      expect(restored?.state).toBe(original.state);
      expect(restored?.tier).toBe(original.tier);
      expect(restored?.occurred_at).toBe(original.occurred_at);
      expect(restored?.source).toBe(original.source);
      expect(restored?.source_id).toBe(original.source_id);
    }

    const restoredMeta = await destination.storage.metadata.get(note1.id);
    expect(restoredMeta.tags.sort()).toEqual(["alpha", "beta"]);
    expect(restoredMeta.extensions["roundtrip.test"]).toEqual({
      checked: true,
      label: "kept",
    });

    const restoredEdges = await destination.storage.edges.list({});
    expect(restoredEdges.data).toHaveLength(2);
    const byId = new Map(restoredEdges.data.map((e) => [e.id, e]));
    const r1 = byId.get(edge1.id);
    expect(r1?.source_id).toBe(note1.id);
    expect(r1?.target_id).toBe(note2.id);
    expect(r1?.edge_type).toBe("references");
    expect(r1?.properties).toEqual({ context: "see also" });
    const r2 = byId.get(edge2.id);
    expect(r2?.source_id).toBe(note3.id);
    expect(r2?.target_id).toBe(note1.id);
  });

  it("restores a placement in a revoked folder, and skips one whose path leaves the folder", async () => {
    const source = await newContext();
    const destination = await newContext();

    const made = await request(source.app, "POST", "/folders", {
      key: source.workingKey,
      body: { title: "Retired" },
    });
    expect(made.status).toBe(201);
    const folderId = ((await made.json()) as { item: { id: string } }).item.id;
    const placed = await itemWrites(source.storage).create({
      type: "core.note",
      properties: { body: "placed" },
    });
    const planted = await itemWrites(source.storage).create({
      type: "core.note",
      properties: { body: "planted" },
    });
    const kept = await source.storage.edges.createRaw({
      source_id: placed.id,
      target_id: folderId,
      edge_type: "in-folder",
      properties: { path: "Notes/placed.md" },
    });
    await source.storage.edges.createRaw({
      source_id: planted.id,
      target_id: folderId,
      edge_type: "in-folder",
      properties: { path: "../planted.md" },
    });
    const revoke = await request(
      source.app,
      "POST",
      `/folders/${folderId}/revoke`,
      { key: source.workingKey },
    );
    expect(revoke.status).toBe(200);

    const exportRes = await request(
      source.app,
      "GET",
      `/export?format=archive`,
      { key: source.workingKey },
    );
    expect(exportRes.status).toBe(200);
    const restoreRes = await destination.app.request(`/restore`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${destination.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: Buffer.from(await exportRes.arrayBuffer()),
    });
    expect(restoreRes.status).toBe(200);
    const result = (await restoreRes.json()) as RestoreResult & {
      edges_skipped_reasons: Record<string, number>;
    };
    expect(result.edges_imported).toBe(1);
    expect(result.edges_skipped_reasons).toEqual({ validation_error: 1 });
    expect((await destination.storage.items.get(folderId))?.state).toBe(
      "revoked",
    );
    expect((await destination.storage.edges.get(kept.id))?.properties).toEqual({
      path: "Notes/placed.md",
    });
  });

  it("re-restoring the same archive changes nothing and counts duplicates", async () => {
    const source = await newContext();

    const a = await itemWrites(source.storage).create({
      type: "core.note",
      properties: { body: "a" },
      source: "rt2",
      source_id: "a",
      tags: ["keep"],
    });
    const b = await itemWrites(source.storage).create({
      type: "core.note",
      properties: { body: "b" },
      source: "rt2",
      source_id: "b",
    });
    await source.storage.edges.createRaw({
      source_id: a.id,
      target_id: b.id,
      edge_type: "references",
    });

    const exportRes = await request(
      source.app,
      "GET",
      `/export?format=archive`,
      { key: source.workingKey },
    );
    const archive = Buffer.from(await exportRes.arrayBuffer());

    const restore = () =>
      source.app.request(`/restore`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${source.operatorKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      });

    // Restoring into the database the archive came from: everything already
    // exists, so nothing may change and everything counts as duplicate.
    const res = await restore();
    expect(res.status).toBe(200);
    const result = (await res.json()) as RestoreResult;
    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(2);
    expect(result.edges_imported).toBe(0);
    expect(result.edges_skipped).toBe(1);

    const edges = await source.storage.edges.list({});
    expect(edges.data).toHaveLength(1);
    const meta = await source.storage.metadata.get(a.id);
    expect(meta.tags).toEqual(["keep"]);
  });

  it("skips and counts edges whose endpoints the archive does not carry", async () => {
    const ctx = await newContext();

    const itemId = "01912345-0000-7000-8000-000000000001";
    const missingId = "01912345-0000-7000-8000-00000000dead";
    const archive = await buildArchive(
      {
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 1,
        edge_count: 1,
        blob_count: 0,
        blobs: {},
      },
      [
        JSON.stringify({
          item: {
            id: itemId,
            type: "core.note",
            properties: { body: "only item" },
            source: "rt3",
            source_id: "only",
          },
          metadata: { item_id: itemId, tags: [], extensions: {} },
        }),
      ],
      [
        JSON.stringify({
          edge: {
            source_id: itemId,
            target_id: missingId,
            edge_type: "references",
            properties: {},
          },
        }),
      ],
    );

    const res = await ctx.app.request(`/restore`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as RestoreResult;
    expect(result.imported).toBe(1);
    expect(result.edges_imported).toBe(0);
    expect(result.edges_skipped).toBe(1);

    const edges = await ctx.storage.edges.list({});
    expect(edges.data).toHaveLength(0);
  });

  it("emits only edges whose endpoints are both inside a filtered export", async () => {
    const ctx = await newContext();

    const note = await itemWrites(ctx.storage).create({
      type: "core.note",
      properties: { body: "in filter" },
      source: "rt4",
      source_id: "n",
    });
    const bookmark = await itemWrites(ctx.storage).create({
      type: "core.bookmark",
      properties: { url: "https://example.com" },
      source: "rt4",
      source_id: "b",
    });
    await ctx.storage.edges.createRaw({
      source_id: note.id,
      target_id: bookmark.id,
      edge_type: "references",
    });

    const readEdgeLines = async (path: string): Promise<unknown[]> => {
      const res = await request(ctx.app, "GET", path, { key: ctx.workingKey });
      expect(res.status).toBe(200);
      const text = await res.text();
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { edge?: unknown })
        .filter((p) => p.edge !== undefined)
        .map((p) => p.edge);
    };

    // Type-filtered: the bookmark endpoint is outside the export, so the
    // edge must not be emitted — the output never references an item it
    // does not carry.
    const filtered = await readEdgeLines(`/export?type=core.note`);
    expect(filtered).toHaveLength(0);

    const unfiltered = await readEdgeLines(`/export`);
    expect(unfiltered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The bytes an archive claims to hold.
//
// The blob lookup once asked a bucket no hash lived in, and the manifest
// recorded `blob_count: 0` while the response reported success. The archive work exists to stop exactly that: an
// export that looks like it worked and cannot restore what it claims to hold.
//
// Driven by restoring into an empty database and reading the bytes back,
// because reading the manifest is what let this survive: the count agreed
// with the (empty) blob set it was counting.
//
// **Driven with a working key.** An operator caller's type map is empty,
// and an export is a list read narrowed by that map, so under the operator
// it would carry no items and therefore no blob hashes.
// ---------------------------------------------------------------------------

describe("an archive's blobs", () => {
  it("carries the bytes, and a restore reads them back", async () => {
    const source = await newContext();
    const destination = await newContext();

    const bytes = Buffer.from("the file's exact contents, and not a stand-in");
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    // Through the doors, so the key exporting both sent the bytes and named
    // them, which is what lets the archive carry them
    // (`blobs/export-carries-served`).
    const uploaded = await source.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${source.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: bytes,
    });
    expect(uploaded.status).toBe(201);
    const named = await request(source.app, "POST", "/items", {
      key: source.workingKey,
      body: {
        type: "core.file",
        properties: {
          title: "attachment",
          blob_ref: hash,
          mime_type: "text/plain",
        },
      },
    });
    expect(named.status).toBe(201);

    const exportRes = await request(
      source.app,
      "GET",
      "/export?format=archive",
      { key: source.workingKey },
    );
    expect(exportRes.status).toBe(200);
    const archive = Buffer.from(await exportRes.arrayBuffer());
    const entries = await extractArchive(archive);

    // The bytes are in the archive, and they are the right bytes. Asserting
    // presence alone would pass on an archive that packed an empty file.
    expect(
      entries.get(`blobs/${hash}`),
      "no bytes packed for the blob",
    ).toBeDefined();
    expect(entries.get(`blobs/${hash}`)!.toString()).toBe(bytes.toString());

    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      blob_count: number;
    };
    expect(manifest.blob_count).toBe(1);

    // And the round trip, which is what the archive is for: restore into a
    // database that has never seen these bytes and read one back.
    const restoreRes = await destination.app.request(`/restore`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${destination.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(restoreRes.status, await restoreRes.clone().text()).toBe(200);
    const restored = await destination.blobs.disk.get(hash);
    expect(restored).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of restored!.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe(bytes.toString());
  });
});
