import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as tar from "tar-stream";
import {
  createTestContext,
  request,
  collectEdgeEvents,
  settle,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function buildArchive(
  manifest: Record<string, unknown>,
  ndjsonLines: string[],
  blobs: { hash: string; data: Buffer }[],
  /** Lines for `edges.ndjson`. Omitted entirely when empty, so an archive
   *  without edges keeps the shape every existing case builds. */
  edgeLines: string[] = [],
): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];

  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));

  pack.pipe(gzip);

  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  pack.entry({ name: "manifest.json", size: manifestBuf.length }, manifestBuf);

  const ndjsonBuf = Buffer.from(ndjsonLines.join("\n") + "\n");
  pack.entry({ name: "items.ndjson", size: ndjsonBuf.length }, ndjsonBuf);

  if (edgeLines.length > 0) {
    const edgesBuf = Buffer.from(edgeLines.join("\n") + "\n");
    pack.entry({ name: "edges.ndjson", size: edgesBuf.length }, edgesBuf);
  }

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

function makeBlobData(content: string): {
  hash: string;
  data: Buffer;
} {
  const data = Buffer.from(content);
  const hex = createHash("sha256").update(data).digest("hex");
  return { hash: `sha256:${hex}`, data };
}

describe("POST /admin/restore-archive", () => {
  it("imports items and blobs from an archive", async () => {
    const blob = makeBlobData("archive-import-blob-test");
    const source = `archive-restore-${Math.random().toString(36).slice(2)}`;

    const archive = await buildArchive(
      {
        version: 1,
        format: "marfa-archive-v1",
        created_at: new Date().toISOString(),
        item_count: 1,
        blob_count: 1,
        blobs: {
          [blob.hash]: { mime_type: "text/plain", size: blob.data.length },
        },
      },
      [
        JSON.stringify({
          item: {
            type: "core.note",
            properties: { body: "From archive", blob_ref: blob.hash },
            source,
            source_id: "ai-1",
          },
        }),
      ],
      [blob],
    );

    const res = await ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      duplicates: number;
      blobs_imported: number;
    };
    expect(data.imported).toBe(1);
    expect(data.blobs_imported).toBe(1);

    const blobRes = await request(ctx.app, "GET", `/blobs/${blob.hash}`, {
      key: ctx.adminKey,
    });
    expect(blobRes.status).toBe(200);
    const blobContent = Buffer.from(await blobRes.arrayBuffer());
    expect(blobContent.toString()).toBe("archive-import-blob-test");
  });

  it("rejects archives with unsupported version", async () => {
    const archive = await buildArchive(
      { version: 99, format: "marfa-archive-v99" },
      [],
      [],
    );

    const res = await ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty bodies", async () => {
    const res = await ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/gzip",
      },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
  });

  it("requires admin role", async () => {
    const rawKey = `marfa_k1_member_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "restore-member",
        source: `restore-member-${rawKey.slice(-6)}`,
        role: "member",
        type_permissions: { "*": "write" },
      },
      keyHash,
    );

    const archive = await buildArchive(
      {
        version: 1,
        format: "marfa-archive-v1",
        created_at: new Date().toISOString(),
        item_count: 0,
        blob_count: 0,
        blobs: {},
      },
      [],
      [],
    );

    const res = await ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(403);
  });

  it("round-trips: archive export then restore preserves blobs", async () => {
    const blobContent = new TextEncoder().encode("roundtrip-archive-blob");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "text/plain",
      },
      body: blobContent,
    });
    const { hash: blobHash } = (await uploadRes.json()) as { hash: string };

    const source = `rt-archive-${Math.random().toString(36).slice(2)}`;
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Roundtrip", blob_ref: blobHash },
        source,
        source_id: "rta-1",
      },
    });

    const exportRes = await request(ctx.app, "GET", "/export?format=archive", {
      key: ctx.adminKey,
    });
    expect(exportRes.status).toBe(200);
    const archiveData = Buffer.from(await exportRes.arrayBuffer());

    const restoreRes = await ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/gzip",
      },
      body: archiveData,
    });
    expect(restoreRes.status).toBe(200);
    const data = (await restoreRes.json()) as {
      imported: number;
      duplicates: number;
      blobs_imported: number;
    };
    // Items with same source_id are deduplicated
    expect(data.duplicates).toBeGreaterThan(0);
    expect(data.blobs_imported).toBeGreaterThanOrEqual(0);
  });
});

describe("POST /admin/restore-archive — quota", () => {
  async function buildTwoBlobArchive(spaceId: string): Promise<{
    archive: Buffer;
    blobs: { hash: string; data: Buffer }[];
  }> {
    const blobs = [
      makeBlobData(`quota-blob-one-${spaceId}`),
      makeBlobData(`quota-blob-two-${spaceId}`),
    ];
    const archive = await buildArchive(
      {
        version: 1,
        exported_at: new Date().toISOString(),
        space_id: spaceId,
        item_count: 2,
        blob_count: 2,
        blobs: Object.fromEntries(
          blobs.map((b) => [
            b.hash,
            { mime_type: "text/plain", size: b.data.length },
          ]),
        ),
      },
      blobs.map((b, i) =>
        JSON.stringify({
          item: {
            type: "core.file",
            properties: {
              title: `f${String(i)}`,
              blob_ref: b.hash,
              mime_type: "text/plain",
            },
          },
        }),
      ),
      blobs,
    );
    return { archive, blobs };
  }

  it("refuses past the blob ceiling, names it, and leaves nothing behind", async () => {
    if (!ctx.storage.spaces) throw new Error("space store expected");
    const space = await ctx.storage.spaces.create("quota-restore-space");
    const quotaRes = await request(
      ctx.app,
      "PUT",
      `/spaces/${space.id}/quotas`,
      {
        key: ctx.adminKey,
        body: { blobs_limit: 1 },
      },
    );
    expect(quotaRes.status).toBe(200);

    const { archive, blobs } = await buildTwoBlobArchive(space.id);
    const res = await ctx.app.request(
      `/admin/restore-archive?target_space_id=${space.id}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.adminKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      },
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: { code: string; details?: { resource?: string; limit?: number } };
    };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details?.resource).toBe("blobs");
    expect(body.error.details?.limit).toBe(1);

    // No rows and no bytes behind: the refusal is indistinguishable from
    // the restore never having been attempted.
    for (const blob of blobs) {
      expect(await ctx.storage.blobs.get(blob.hash, space.id)).toBeNull();
      expect(await ctx.storage.blobs.getAcrossSpaces(blob.hash)).toBeNull();
      expect(await ctx.blobBackend.exists(blob.hash)).toBe(false);
    }

    // Room made, the same archive lands.
    await request(ctx.app, "PUT", `/spaces/${space.id}/quotas`, {
      key: ctx.adminKey,
      body: { blobs_limit: 10 },
    });
    const retry = await ctx.app.request(
      `/admin/restore-archive?target_space_id=${space.id}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.adminKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      },
    );
    expect(retry.status, await retry.clone().text()).toBe(200);
    for (const blob of blobs) {
      expect(await ctx.storage.blobs.get(blob.hash, space.id)).not.toBeNull();
    }
  });

  it("refuses past the storage-byte ceiling the same way", async () => {
    if (!ctx.storage.spaces) throw new Error("space store expected");
    const space = await ctx.storage.spaces.create("quota-restore-bytes");
    await request(ctx.app, "PUT", `/spaces/${space.id}/quotas`, {
      key: ctx.adminKey,
      body: { storage_bytes_limit: 8 },
    });

    const { archive, blobs } = await buildTwoBlobArchive(space.id);
    const res = await ctx.app.request(
      `/admin/restore-archive?target_space_id=${space.id}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.adminKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      },
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: { code: string; details?: { resource?: string } };
    };
    expect(body.error.details?.resource).toBe("storage_bytes");
    for (const blob of blobs) {
      expect(await ctx.blobBackend.exists(blob.hash)).toBe(false);
    }
  });
});

describe("POST /admin/restore-archive — the edges it writes", () => {
  /**
   * A restore is a write like any other from a subscriber's side. A client
   * connected while an archive is restored would otherwise receive the
   * items and none of the graph between them, and nothing later repairs
   * it: the edges already exist server-side, so no re-sync rewrites them.
   */
  it("announces each restored edge", async () => {
    const source = `archive-edges-${Math.random().toString(36).slice(2, 8)}`;
    const sourceId = "019537a0-7b80-7000-8000-0000000000e1";
    const targetId = "019537a0-7b80-7000-8000-0000000000e2";
    const edgeId = "019537a0-7b80-7000-8000-0000000000e3";

    const archive = await buildArchive(
      {
        version: 1,
        format: "marfa-archive-v1",
        created_at: new Date().toISOString(),
        item_count: 2,
        blob_count: 0,
        blobs: {},
      },
      [
        JSON.stringify({
          item: {
            id: sourceId,
            type: "core.note",
            properties: { body: "archived source" },
            source,
            source_id: "ae-1",
          },
        }),
        JSON.stringify({
          item: {
            id: targetId,
            type: "core.note",
            properties: { body: "archived target" },
            source,
            source_id: "ae-2",
          },
        }),
      ],
      [],
      [
        JSON.stringify({
          edge: {
            id: edgeId,
            source_id: sourceId,
            target_id: targetId,
            edge_type: "references",
            properties: {},
          },
        }),
      ],
    );

    const controller = new AbortController();
    const { events, done } = collectEdgeEvents(controller.signal);
    await settle();

    const res = await ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/gzip",
      },
      body: new Uint8Array(archive),
    });
    expect(res.status).toBe(200);
    await settle();
    controller.abort();
    await done;

    expect(
      events.filter((e) => e.type === "edge_created" && e.edge.id === edgeId),
    ).toHaveLength(1);
  });

  it("announces nothing when a later edge rolls the restore back", async () => {
    // The restore runs in one transaction. Announcing from inside it sent
    // `edge.created` for edges a later failure then undid — and the
    // `event_log` append rolls back with them, so a replay cannot repair
    // what a live subscriber already received.
    const source = `archive-rollback-${Math.random().toString(36).slice(2, 8)}`;
    const sourceId = "019537a0-7b80-7000-8000-0000000000f1";
    const targetId = "019537a0-7b80-7000-8000-0000000000f2";
    const goodEdgeId = "019537a0-7b80-7000-8000-0000000000f3";

    const archive = await buildArchive(
      {
        version: 1,
        format: "marfa-archive-v1",
        created_at: new Date().toISOString(),
        item_count: 2,
        blob_count: 0,
        blobs: {},
      },
      [
        JSON.stringify({
          item: {
            id: sourceId,
            type: "core.note",
            properties: { body: "rollback source" },
            source,
            source_id: "ar-1",
          },
        }),
        JSON.stringify({
          item: {
            id: targetId,
            type: "core.note",
            properties: { body: "rollback target" },
            source,
            source_id: "ar-2",
          },
        }),
      ],
      [],
      [
        // Lands first.
        JSON.stringify({
          edge: {
            id: goodEdgeId,
            source_id: sourceId,
            target_id: targetId,
            edge_type: "references",
            properties: {},
          },
        }),
        // A second, valid edge. The failure is injected below rather
        // than expressed in the archive, because this import skips every
        // edge-shaped problem it can name — malformed, endpoint missing,
        // already present, constraint violation — and carries on. Only a
        // failure it cannot classify aborts the transaction, and that is
        // an infrastructure error, which is what the stub simulates.
        JSON.stringify({
          edge: {
            id: "019537a0-7b80-7000-8000-0000000000f4",
            source_id: targetId,
            target_id: sourceId,
            edge_type: "references",
            properties: {},
          },
        }),
      ],
    );

    const controller = new AbortController();
    const { events, done } = collectEdgeEvents(controller.signal);
    await settle();

    // The first edge lands, the second fails the way an infrastructure
    // error would. Everything before it is already written.
    const store = ctx.storage.edges;
    const realCreate = store.createRaw.bind(store);
    let creates = 0;
    store.createRaw = async (input, space) => {
      creates += 1;
      if (creates === 2) throw new Error("simulated storage failure");
      return realCreate(input, space);
    };
    let res: Response;
    try {
      res = await ctx.app.request("/admin/restore-archive", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.adminKey}`,
          "Content-Type": "application/gzip",
        },
        body: new Uint8Array(archive),
      });
    } finally {
      store.createRaw = realCreate;
    }
    // The stub was reached, so the test is about the rollback rather than
    // about an import that never got that far.
    expect(creates).toBe(2);
    await settle();
    controller.abort();
    await done;

    // Either the import refused the batch or it skipped the bad edge; the
    // assertion below holds only in the first case, so the test states
    // which it is rather than passing on either.
    expect(res.status).not.toBe(200);
    expect(
      events.filter(
        (e) => e.type === "edge_created" && e.edge.id === goodEdgeId,
      ),
    ).toHaveLength(0);
    // And the edge really is absent, so this is a rollback rather than a
    // late event.
    expect(await ctx.storage.edges.get(goodEdgeId)).toBeNull();
  });
});
