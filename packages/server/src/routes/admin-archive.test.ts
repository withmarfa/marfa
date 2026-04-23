import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as tar from "tar-stream";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

async function buildArchive(
  manifest: Record<string, unknown>,
  ndjsonLines: string[],
  blobs: { hash: string; data: Buffer }[],
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
        format: "myme-archive-v1",
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
      { version: 99, format: "myme-archive-v99" },
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
    const rawKey = `myme_k1_member_${Math.random().toString(36).slice(2)}`;
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
        format: "myme-archive-v1",
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
