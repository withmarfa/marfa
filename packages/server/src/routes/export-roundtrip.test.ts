/**
 * The property under test is the round trip itself: an export carries
 * everything a space's content is made of — items under their original
 * ids, tags, extensions, and the edges between them — and a restore
 * onto a fresh database reproduces it. Every assertion here exists
 * because the thing it checks was once silently dropped: edges were
 * never exported while the route's description said they were, restored
 * items were re-minted under new ids (dangling every edge an archive
 * could have carried), and metadata was parsed and discarded.
 *
 * The restore space must match the archive's manifest space — an
 * archive restores into the space it came from, on the same or a fresh
 * database. Cross-space restore is deliberately refused upstream and
 * covered by export.space-scoping.test.ts.
 */

import { createHash } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { describe, expect, it, afterAll } from "vitest";
import * as tar from "tar-stream";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

async function extractArchive(data: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
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
  for (const ctx of contexts) {
    await ctx.cleanup();
  }
});

describe("export → restore round trip", () => {
  it("reproduces items, ids, tags, extensions, and edges on a fresh database", async () => {
    const source = await newContext();
    const destination = await newContext();
    const space = `t-rt-${Math.random().toString(36).slice(2, 10)}`;

    const note1 = await source.storage.items.create(
      {
        type: "core.note",
        properties: { title: "First", body: "carries tags and an extension" },
        source: "rt-seed",
        source_id: "n1",
        tier: "feed",
        timestamp: "2026-01-01T00:00:00.000Z",
        tags: ["alpha", "beta"],
      },
      space,
    );
    const note2 = await source.storage.items.create(
      {
        type: "core.note",
        properties: { title: "Second", body: "archived on purpose" },
        source: "rt-seed",
        source_id: "n2",
        state: "archived",
      },
      space,
    );
    const note3 = await source.storage.items.create(
      {
        type: "core.note",
        properties: { title: "Third", body: "plain" },
        source: "rt-seed",
        source_id: "n3",
      },
      space,
    );
    await source.storage.metadata.setExtension(note1.id, "roundtrip.test", {
      checked: true,
      label: "kept",
    });
    const edge1 = await source.storage.edges.createRaw(
      {
        source_id: note1.id,
        target_id: note2.id,
        edge_type: "references",
        properties: { context: "see also" },
      },
      space,
    );
    const edge2 = await source.storage.edges.createRaw(
      { source_id: note3.id, target_id: note1.id, edge_type: "references" },
      space,
    );

    const exportRes = await request(
      source.app,
      "GET",
      `/export?format=archive&target_space_id=${space}`,
      { key: source.adminKey },
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

    const restoreRes = await destination.app.request(
      `/admin/restore-archive?target_space_id=${space}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${destination.adminKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      },
    );
    expect(restoreRes.status).toBe(200);
    const result = (await restoreRes.json()) as RestoreResult;
    expect(result.imported).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.edges_imported).toBe(2);
    expect(result.edges_skipped).toBe(0);

    // Items come back under their original ids, with the content-bearing
    // fields intact. created_at / updated_at / version are re-stamped by
    // design and deliberately not compared.
    for (const original of [note1, note2, note3]) {
      const restored = await destination.storage.items.get(original.id, space);
      expect(restored, `item ${original.source_id ?? original.id}`).not.toBe(
        null,
      );
      expect(restored?.type).toBe(original.type);
      expect(restored?.properties).toEqual(original.properties);
      expect(restored?.state).toBe(original.state);
      expect(restored?.tier).toBe(original.tier);
      expect(restored?.timestamp).toBe(original.timestamp);
      expect(restored?.source).toBe(original.source);
      expect(restored?.source_id).toBe(original.source_id);
    }

    const restoredMeta = await destination.storage.metadata.get(note1.id);
    expect(restoredMeta.tags.sort()).toEqual(["alpha", "beta"]);
    expect(restoredMeta.extensions["roundtrip.test"]).toEqual({
      checked: true,
      label: "kept",
    });

    const restoredEdges = await destination.storage.edges.list({
      spaceId: space,
    });
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

  it("re-restoring the same archive changes nothing and counts duplicates", async () => {
    const source = await newContext();
    const space = `t-rt2-${Math.random().toString(36).slice(2, 10)}`;

    const a = await source.storage.items.create(
      {
        type: "core.note",
        properties: { body: "a" },
        source: "rt2",
        source_id: "a",
        tags: ["keep"],
      },
      space,
    );
    const b = await source.storage.items.create(
      {
        type: "core.note",
        properties: { body: "b" },
        source: "rt2",
        source_id: "b",
      },
      space,
    );
    await source.storage.edges.createRaw(
      { source_id: a.id, target_id: b.id, edge_type: "references" },
      space,
    );

    const exportRes = await request(
      source.app,
      "GET",
      `/export?format=archive&target_space_id=${space}`,
      { key: source.adminKey },
    );
    const archive = Buffer.from(await exportRes.arrayBuffer());

    const restore = () =>
      source.app.request(`/admin/restore-archive?target_space_id=${space}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${source.adminKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      });

    // Restoring into the space the archive came from: everything already
    // exists, so nothing may change and everything counts as duplicate.
    const res = await restore();
    expect(res.status).toBe(200);
    const result = (await res.json()) as RestoreResult;
    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(2);
    expect(result.edges_imported).toBe(0);
    expect(result.edges_skipped).toBe(1);

    const edges = await source.storage.edges.list({ spaceId: space });
    expect(edges.data).toHaveLength(1);
    const meta = await source.storage.metadata.get(a.id);
    expect(meta.tags).toEqual(["keep"]);
  });

  it("skips and counts edges whose endpoints the archive does not carry", async () => {
    const ctx = await newContext();
    const space = `t-rt3-${Math.random().toString(36).slice(2, 10)}`;

    const itemId = "01912345-0000-7000-8000-000000000001";
    const missingId = "01912345-0000-7000-8000-00000000dead";
    const archive = await buildArchive(
      {
        version: 1,
        format: "marfa-archive-v1",
        created_at: new Date().toISOString(),
        space_id: space,
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

    const res = await ctx.app.request(
      `/admin/restore-archive?target_space_id=${space}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.adminKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      },
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as RestoreResult;
    expect(result.imported).toBe(1);
    expect(result.edges_imported).toBe(0);
    expect(result.edges_skipped).toBe(1);

    const edges = await ctx.storage.edges.list({ spaceId: space });
    expect(edges.data).toHaveLength(0);
  });

  it("emits only edges whose endpoints are both inside a filtered export", async () => {
    const ctx = await newContext();
    const space = `t-rt4-${Math.random().toString(36).slice(2, 10)}`;

    const note = await ctx.storage.items.create(
      {
        type: "core.note",
        properties: { body: "in filter" },
        source: "rt4",
        source_id: "n",
      },
      space,
    );
    const bookmark = await ctx.storage.items.create(
      {
        type: "core.bookmark",
        properties: { url: "https://example.com" },
        source: "rt4",
        source_id: "b",
      },
      space,
    );
    await ctx.storage.edges.createRaw(
      { source_id: note.id, target_id: bookmark.id, edge_type: "references" },
      space,
    );

    const readEdgeLines = async (path: string): Promise<unknown[]> => {
      const res = await request(ctx.app, "GET", path, { key: ctx.adminKey });
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
    const filtered = await readEdgeLines(
      `/export?type=core.note&target_space_id=${space}`,
    );
    expect(filtered).toHaveLength(0);

    const unfiltered = await readEdgeLines(`/export?target_space_id=${space}`);
    expect(unfiltered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The platform admin's own export, which is the one that carried no bytes.
//
// A space-less export spans every space, so its blob lookup has to as well.
// It asked the instance-wide `""` bucket instead — where none of those
// hashes live — and the manifest recorded `blob_count: 0` while the response
// reported success. The archive work exists to stop exactly that: an export
// that looks like it worked and cannot restore what it claims to hold.
//
// Driven by restoring into an empty space and reading the bytes back,
// because reading the manifest is what let this survive: the count agreed
// with the (empty) blob set it was counting.
// ---------------------------------------------------------------------------

describe("a platform-level export", () => {
  it("carries the bytes from every space it spans", async () => {
    const source = await newContext();
    const destination = await newContext();
    const spaceA = `t-pa-${Math.random().toString(36).slice(2, 8)}`;
    const spaceB = `t-pb-${Math.random().toString(36).slice(2, 8)}`;

    const bytesA = Buffer.from("space A's file, and its exact contents");
    const bytesB = Buffer.from("space B's file — different bytes entirely");
    const hashes = new Map<string, string>();
    for (const [space, bytes] of [
      [spaceA, bytesA],
      [spaceB, bytesB],
    ] as const) {
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      await source.blobBackend.put(hash, bytes, "text/plain");
      await source.storage.blobs.register(
        hash,
        "text/plain",
        bytes.length,
        hash,
        space,
      );
      await source.storage.items.create(
        {
          type: "core.file",
          properties: {
            title: `${space} attachment`,
            blob_ref: hash,
            mime_type: "text/plain",
            size: bytes.length,
          },
          source: "pa-seed",
        },
        space,
      );
      hashes.set(space, hash);
    }

    // No `target_space_id`: the platform admin's whole-instance export.
    const exportRes = await request(
      source.app,
      "GET",
      "/export?format=archive",
      { key: source.adminKey },
    );
    expect(exportRes.status).toBe(200);
    const archive = Buffer.from(await exportRes.arrayBuffer());
    const entries = await extractArchive(archive);

    // The bytes are in the archive, and they are the right bytes. Asserting
    // presence alone would pass on an archive that packed two empty files.
    const hashA = hashes.get(spaceA)!;
    const hashB = hashes.get(spaceB)!;
    expect(
      entries.get(`blobs/${hashA}`),
      "no bytes packed for the first space",
    ).toBeDefined();
    expect(
      entries.get(`blobs/${hashB}`),
      "no bytes packed for the second space",
    ).toBeDefined();
    expect(entries.get(`blobs/${hashA}`)!.toString()).toBe(bytesA.toString());
    expect(entries.get(`blobs/${hashB}`)!.toString()).toBe(bytesB.toString());

    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      blob_count: number;
      space_id: string | null;
    };
    expect(manifest.blob_count).toBe(2);
    expect(manifest.space_id).toBeNull();

    // And the round trip, which is what the archive is for: restore into a
    // database that has never seen these bytes and read one back.
    const restoreRes = await destination.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${destination.adminKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(restoreRes.status, await restoreRes.clone().text()).toBe(200);
    const restored = await destination.blobBackend.get(hashA);
    expect(restored).not.toBeNull();
    expect(Buffer.from(restored!).toString()).toBe(bytesA.toString());
  });
});
