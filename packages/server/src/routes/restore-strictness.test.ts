/**
 * What an archive may write, and what a refused restore may leave behind.
 *
 * An archive is a file somebody can hand you. Restore is operator-key
 * gated, so this is trust-boundary erosion rather than an open door, but a
 * replay through the raw edge insert (no registry lookup, no endpoint-type
 * constraints, no cardinality, no cycle check, no self-edge guard, no
 * duplicate guard) would let a hand-edited archive plant relationships the
 * API refuses, and count them as imported.
 *
 * Driven with edge types whose constraints show, not only `references`,
 * which is many-to-many with `["*"]` on both ends: the one core edge type
 * for which the missing validation would make no observable difference.
 */
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { describe, expect, it, afterAll, afterEach } from "vitest";
import * as tar from "tar-stream";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";

const contexts: TestContext[] = [];

afterEach(() => {
  __resetEventLogForTests();
});

afterAll(async () => {
  await Promise.all(contexts.map((c) => c.cleanup()));
});

async function newContext(): Promise<TestContext> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

interface RestoreResult {
  imported: number;
  duplicates: number;
  edges_imported: number;
  edges_skipped: number;
  edges_skipped_reasons: Record<string, number>;
  blobs_imported: number;
}

async function buildArchive(opts: {
  itemLines: string[];
  edgeLines: string[];
  blobs?: { hash: string; data: Buffer }[];
}): Promise<Buffer> {
  const blobs = opts.blobs ?? [];
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  pack.pipe(gzip);

  const manifest = {
    version: 0,
    format: "marfa-archive-v0",
    created_at: new Date().toISOString(),
    item_count: opts.itemLines.length,
    edge_count: opts.edgeLines.length,
    blob_count: blobs.length,
    blobs: Object.fromEntries(
      blobs.map((b) => [
        b.hash,
        { mime_type: "text/plain", size_bytes: b.data.length },
      ]),
    ),
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  pack.entry({ name: "manifest.json", size: manifestBuf.length }, manifestBuf);
  const itemsBuf = Buffer.from(opts.itemLines.join("\n") + "\n");
  pack.entry({ name: "items.ndjson", size: itemsBuf.length }, itemsBuf);
  const edgesBuf = Buffer.from(
    opts.edgeLines.length > 0 ? opts.edgeLines.join("\n") + "\n" : "",
  );
  pack.entry({ name: "edges.ndjson", size: edgesBuf.length }, edgesBuf);
  for (const blob of blobs) {
    pack.entry(
      { name: `blobs/${blob.hash}`, size: blob.data.length },
      blob.data,
    );
  }
  pack.finalize();

  await new Promise<void>((resolve) => gzip.on("end", resolve));
  return Buffer.concat(chunks);
}

function noteLine(id: string, body: string, type = "core.note"): string {
  return JSON.stringify({
    item: { id, type, properties: { body }, source: "strict", source_id: id },
    metadata: { item_id: id, tags: [], extensions: {} },
  });
}

function edgeLine(edge: Record<string, unknown>): string {
  return JSON.stringify({ edge: { properties: {}, ...edge } });
}

function blobOf(content: string): { hash: string; data: Buffer } {
  const data = Buffer.from(content);
  return {
    hash: `sha256:${createHash("sha256").update(data).digest("hex")}`,
    data,
  };
}

const A = "01912345-0000-7000-8000-0000000000a1";
const B = "01912345-0000-7000-8000-0000000000b2";
const C = "01912345-0000-7000-8000-0000000000c3";

/** Restore an archive. The route is operator-gated. */
async function restoreInto(
  ctx: TestContext,
  archive: Buffer,
): Promise<Response> {
  return ctx.app.request(`/admin/restore-archive`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.operatorKey}`,
      "Content-Type": "application/gzip",
    },
    body: archive,
  });
}

/** Restore an archive carrying `edgeLines` over three notes, and report. */
async function restoreEdges(
  edgeLines: string[],
  itemTypes: Record<string, string> = {},
): Promise<{ result: RestoreResult; edgeCount: number }> {
  const ctx = await newContext();
  const archive = await buildArchive({
    itemLines: [
      noteLine(A, "a", itemTypes[A]),
      noteLine(B, "b", itemTypes[B]),
      noteLine(C, "c", itemTypes[C]),
    ],
    edgeLines,
  });
  const res = await restoreInto(ctx, archive);
  expect(res.status).toBe(200);
  const result = (await res.json()) as RestoreResult;
  const edges = await ctx.storage.edges.list({});
  return { result, edgeCount: edges.data.length };
}

describe("restore validates the edges it writes", () => {
  it("still imports an edge the API would accept", async () => {
    // The control. Without it, every case below could pass because restore
    // had stopped writing edges at all.
    const { result, edgeCount } = await restoreEdges([
      edgeLine({ source_id: A, target_id: B, edge_type: "references" }),
    ]);
    expect(result.edges_imported).toBe(1);
    expect(result.edges_skipped).toBe(0);
    expect(edgeCount).toBe(1);
  });

  it("refuses an edge type nothing has registered", async () => {
    const { result, edgeCount } = await restoreEdges([
      edgeLine({ source_id: A, target_id: B, edge_type: "acme.invented" }),
    ]);
    expect(result.edges_imported).toBe(0);
    expect(result.edges_skipped_reasons).toMatchObject({
      edge_type_not_found: 1,
    });
    expect(edgeCount).toBe(0);
  });

  it("refuses an edge from an item to itself", async () => {
    const { result, edgeCount } = await restoreEdges([
      edgeLine({ source_id: A, target_id: A, edge_type: "references" }),
    ]);
    expect(result.edges_imported).toBe(0);
    expect(result.edges_skipped).toBe(1);
    // The reason, not only the count. `references` is walked by no cycle
    // check, so this is the door's own record of which refusal a self-loop
    // gets — the one thing about it a restore report carries at all.
    expect(result.edges_skipped_reasons).toMatchObject({ edge_cycle: 1 });
    expect(edgeCount).toBe(0);
  });

  it("refuses a second edge with the same triple under a fresh id", async () => {
    // The id-collision check catches a re-restore of the same row. It does
    // not catch this: a hand-edited archive naming the same relationship
    // twice under two ids lands a duplicate no API path can create.
    const { result, edgeCount } = await restoreEdges([
      edgeLine({
        id: "01912345-0000-7000-8000-0000000000e1",
        source_id: A,
        target_id: B,
        edge_type: "references",
      }),
      edgeLine({
        id: "01912345-0000-7000-8000-0000000000e2",
        source_id: A,
        target_id: B,
        edge_type: "references",
      }),
    ]);
    expect(result.edges_imported).toBe(1);
    expect(result.edges_skipped).toBe(1);
    expect(edgeCount).toBe(1);
  });

  it("refuses an endpoint whose type the edge does not allow", async () => {
    // `in-collection` names its permitted targets; a note is not one.
    const { result, edgeCount } = await restoreEdges([
      edgeLine({ source_id: A, target_id: B, edge_type: "in-collection" }),
    ]);
    expect(result.edges_imported).toBe(0);
    expect(result.edges_skipped).toBe(1);
    expect(edgeCount).toBe(0);
  });

  it("refuses the edge that would close a cycle", async () => {
    const { result, edgeCount } = await restoreEdges([
      edgeLine({ source_id: A, target_id: B, edge_type: "parent-of" }),
      edgeLine({ source_id: B, target_id: A, edge_type: "parent-of" }),
    ]);
    expect(result.edges_imported).toBe(1);
    expect(result.edges_skipped).toBe(1);
    expect(edgeCount).toBe(1);
  });

  it("refuses the edge that would break cardinality", async () => {
    // `supersedes` is one-to-one, so a second edge out of A violates it.
    const { result, edgeCount } = await restoreEdges([
      edgeLine({ source_id: A, target_id: B, edge_type: "supersedes" }),
      edgeLine({ source_id: A, target_id: C, edge_type: "supersedes" }),
    ]);
    expect(result.edges_imported).toBe(1);
    expect(result.edges_skipped).toBe(1);
    expect(edgeCount).toBe(1);
  });

  it("says why it skipped, not only how many", async () => {
    const { result } = await restoreEdges([
      edgeLine({ source_id: A, target_id: B, edge_type: "acme.invented" }),
      edgeLine({
        source_id: A,
        target_id: "01912345-0000-7000-8000-00000000dead",
        edge_type: "references",
      }),
    ]);
    // A silent skip and a refused one are different signals; a bare count
    // cannot tell an operator which they got.
    expect(result.edges_skipped).toBe(2);
    expect(result.edges_skipped_reasons).toEqual({
      edge_type_not_found: 1,
      endpoint_missing: 1,
    });
  });
});

describe("archive blob rows commit with the restored rows", () => {
  it("still restores blobs when the archive is accepted", async () => {
    const ctx = await newContext();
    const blob = blobOf(`accepted blob`);
    const archive = await buildArchive({
      itemLines: [noteLine(A, "a")],
      edgeLines: [],
      blobs: [blob],
    });

    const res = await restoreInto(ctx, archive);
    expect(res.status).toBe(200);
    const result = (await res.json()) as RestoreResult;
    expect(result.blobs_imported).toBe(1);
    expect(await ctx.storage.blobs.get(blob.hash)).not.toBeNull();
    expect(await ctx.blobs.disk.has(blob.hash)).not.toBeNull();
  });

  it("keeps no blobs when validation refuses the archive before writing", async () => {
    const ctx = await newContext();
    const blob = blobOf(`refused blob`);
    // A state the row's lifecycle cannot produce refuses the whole archive
    // before anything is written.
    const refused = JSON.stringify({
      item: {
        id: A,
        type: "system.folder",
        state: "trashed",
        properties: { title: "refused" },
        source: "strict",
        source_id: A,
      },
      metadata: { item_id: A, tags: [], extensions: {} },
    });
    const archive = await buildArchive({
      itemLines: [refused],
      edgeLines: [],
      blobs: [blob],
    });

    const res = await restoreInto(ctx, archive);
    expect(res.status).toBe(400);
    expect(await ctx.storage.items.getIncludingTrashed(A)).toBeNull();
    expect(await ctx.storage.blobs.get(blob.hash)).toBeNull();
    expect(await ctx.blobs.disk.has(blob.hash)).toBeNull();
  });

  it("rolls back blob registration with the restored rows, and takes back the bytes it placed", async () => {
    const ctx = await newContext();
    initEventLog(ctx.storage.eventLog);
    const kept = blobOf(`kept blob`);
    await ctx.blobs.disk.put(kept.hash, {
      stream: Readable.from([kept.data]),
      size_bytes: kept.data.length,
    });
    await ctx.storage.blobs.register(kept.hash, "text/plain", kept.data.length);
    const placed = blobOf(`placed and taken back`);
    const archive = await buildArchive({
      itemLines: [noteLine(A, "a"), noteLine(B, "b")],
      edgeLines: [
        edgeLine({ source_id: A, target_id: B, edge_type: "references" }),
        edgeLine({ source_id: B, target_id: A, edge_type: "references" }),
      ],
      blobs: [placed],
    });

    // The second edge fails the way an infrastructure error would, which
    // is the one failure the import does not skip and count.
    const store = ctx.storage.edges;
    const realCreate = store.createRaw.bind(store);
    let creates = 0;
    store.createRaw = async (input) => {
      creates += 1;
      if (creates === 2) throw new Error("simulated storage failure");
      return realCreate(input);
    };
    let res: Response;
    try {
      res = await restoreInto(ctx, archive);
    } finally {
      store.createRaw = realCreate;
    }
    expect(creates).toBe(2);
    expect(res.status).toBe(500);
    expect(await ctx.storage.items.getIncludingTrashed(A)).toBeNull();
    expect(await ctx.storage.items.getIncludingTrashed(B)).toBeNull();
    expect((await ctx.storage.edges.list()).data).toEqual([]);
    expect(await ctx.storage.eventLog.getAfter(0n, 100)).toEqual([]);
    expect(
      (await ctx.storage.audit.list({ action: "admin.restore_archive" })).data,
    ).toEqual([]);
    expect(
      (await ctx.storage.audit.list({ action: "admin.restore_archive.blobs" }))
        .data,
    ).toEqual([]);
    expect(await ctx.storage.blobs.get(placed.hash)).toBeNull();
    expect(await ctx.blobs.disk.has(placed.hash)).toBeNull();
    expect(await ctx.storage.blobs.get(kept.hash)).not.toBeNull();
    expect(await ctx.blobs.disk.has(kept.hash)).toEqual({
      size_bytes: kept.data.length,
    });

    // The accepted retry witnesses the rows, events and final audit whose
    // absence above proves rollback rather than an unwired event log.
    const accepted = await restoreInto(ctx, archive);
    expect(accepted.status).toBe(200);
    expect(await ctx.storage.items.getIncludingTrashed(A)).not.toBeNull();
    expect(await ctx.storage.items.getIncludingTrashed(B)).not.toBeNull();
    expect((await ctx.storage.edges.list()).data).toHaveLength(2);
    expect(await ctx.storage.eventLog.getAfter(0n, 100)).toHaveLength(4);
    expect(
      (await ctx.storage.audit.list({ action: "admin.restore_archive" })).data,
    ).toHaveLength(1);
    const registered = (
      await ctx.storage.audit.list({ action: "admin.restore_archive.blobs" })
    ).data;
    expect(registered).toHaveLength(1);
    expect(registered[0]?.details).toEqual({ hashes: [placed.hash] });
    expect(await ctx.storage.blobs.get(placed.hash)).toEqual({
      mime_type: "text/plain",
      size_bytes: placed.data.length,
    });
    expect(await ctx.blobs.disk.has(placed.hash)).toEqual({
      size_bytes: placed.data.length,
    });
  });
});
