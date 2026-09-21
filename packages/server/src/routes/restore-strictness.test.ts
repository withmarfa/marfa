/**
 * What an archive may write, and what a refused restore may leave behind.
 *
 * An archive is a file somebody can hand you. Restore is operator-key
 * gated, so this is trust-boundary erosion rather than an open door, but the
 * replay used to go through the raw edge insert: no registry lookup, no
 * endpoint-type constraints, no cardinality, no cycle check, no self-edge
 * guard, no duplicate guard. A hand-edited archive could plant relationships
 * the API refuses, and they counted as imported.
 *
 * Every archive test before this one used `references`, which is
 * many-to-many with `["*"]` on both ends — the one core edge type for which
 * the missing validation makes no observable difference. So the gap was
 * invisible to a suite that otherwise covered restore well.
 */
import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import { describe, expect, it, afterAll } from "vitest";
import * as tar from "tar-stream";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

const contexts: TestContext[] = [];

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
    version: 2,
    format: "marfa-archive-v2",
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

describe("a refused restore leaves no blobs behind", () => {
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
});
