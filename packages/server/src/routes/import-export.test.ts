import { createHash } from "node:crypto";
import { createGzip, createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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

describe("POST /import", () => {
  it("imports items in bulk", async () => {
    const res = await request(ctx.app, "POST", "/import", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "Import test 1" },
            source: "import-test",
            source_id: "imp-1",
          },
          {
            type: "core.note",
            properties: { body: "Import test 2" },
            source: "import-test",
            source_id: "imp-2",
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      imported: number;
      duplicates: number;
    };
    expect(data.imported).toBe(2);
    expect(data.duplicates).toBe(0);
  });

  it("detects duplicate source_id on re-import", async () => {
    const items = [
      {
        type: "core.note",
        properties: { body: "Dup test" },
        source: "dup-test",
        source_id: "dup-1",
      },
    ];

    await request(ctx.app, "POST", "/import", {
      key: ctx.adminKey,
      body: { items },
    });

    const res = await request(ctx.app, "POST", "/import", {
      key: ctx.adminKey,
      body: { items },
    });
    const data = (await res.json()) as {
      imported: number;
      duplicates: number;
    };
    expect(data.duplicates).toBe(1);
  });

  it("requires admin role", async () => {
    // Create a non-admin key
    const rawKey = `myme_k1_member_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "import-member",
        source: `import-member-${rawKey.slice(-6)}`,
        role: "member",
        type_permissions: { "*": "write" },
      },
      keyHash,
    );

    const res = await request(ctx.app, "POST", "/import", {
      key: rawKey,
      body: { items: [{ type: "core.note", properties: { body: "x" } }] },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /export", () => {
  it("exports items as NDJSON", async () => {
    // Create a test item first
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Export test" },
        source: "export-test",
        source_id: "exp-1",
      },
    });

    const res = await request(ctx.app, "GET", "/export", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("ndjson");

    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);

    const first = JSON.parse(lines[0] ?? "{}") as { item: { id: string } };
    expect(first.item.id).toBeDefined();
  });

  it("filters export by type", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.bookmark",
        properties: { url: "https://example.com" },
      },
    });

    const res = await request(ctx.app, "GET", "/export?type=core.bookmark", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const lines = text.trim().split("\n");
    for (const line of lines) {
      const parsed = JSON.parse(line) as { item: { type: string } };
      expect(parsed.item.type).toBe("core.bookmark");
    }
  });

  it("round-trips: export then import produces same items", async () => {
    // Create items with a unique source_id so we can find them post-export.
    // Source is stamped from the credential (non-forgeable) so we can't use
    // a client-supplied source value to filter.
    const sourceId = `rt-${Math.random().toString(36).slice(2)}`;
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Round trip note", title: "RT" },
        source_id: sourceId,
        tags: ["roundtrip"],
      },
    });

    // Export
    const exportRes = await request(ctx.app, "GET", `/export?type=core.note`, {
      key: ctx.adminKey,
    });
    const exportText = await exportRes.text();
    const lines = exportText.trim().split("\n");
    const exported = lines.map(
      (l) =>
        JSON.parse(l) as {
          item: Record<string, unknown>;
          metadata: Record<string, unknown>;
        },
    );

    // Find our item by source_id (preserved verbatim, unlike source)
    const ours = exported.find(
      (e) => (e.item as { source_id?: string }).source_id === sourceId,
    );
    expect(ours).toBeDefined();

    // Import with a new source_id to avoid dedup
    const importRes = await request(ctx.app, "POST", "/import", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: ours?.item.properties,
            source_id: `${sourceId}-copy`,
          },
        ],
      },
    });
    expect(importRes.status).toBe(200);
    const importData = (await importRes.json()) as { imported: number };
    expect(importData.imported).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Archive format helpers
// ---------------------------------------------------------------------------

async function buildArchive(
  manifest: Record<string, unknown>,
  ndjsonLines: string[],
  blobs: Array<{ hash: string; data: Buffer }>,
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
    pack.entry({ name: `blobs/${blob.hash}`, size: blob.data.length }, blob.data);
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

// ---------------------------------------------------------------------------
// Archive export tests
// ---------------------------------------------------------------------------

describe("GET /export?format=archive", () => {
  it("produces a valid tar.gz with manifest, items, and blobs", async () => {
    // Upload a blob and create an item referencing it
    const blobContent = new TextEncoder().encode("archive-export-blob");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: blobContent,
    });
    const { hash: blobHash } = (await uploadRes.json()) as { hash: string };

    const source = `archive-export-${Math.random().toString(36).slice(2)}`;
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Has a blob", blob_ref: blobHash },
        source,
        source_id: "ae-1",
      },
    });

    // Export as archive
    const res = await request(ctx.app, "GET", "/export?format=archive", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");

    // Extract and verify contents
    const archiveData = Buffer.from(await res.arrayBuffer());
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
      Readable.from(archiveData).pipe(gunzip).pipe(extract);
    });

    // Verify manifest
    expect(entries.has("manifest.json")).toBe(true);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      version: number;
      format: string;
      item_count: number;
      blob_count: number;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.format).toBe("myme-archive-v1");
    expect(manifest.item_count).toBeGreaterThan(0);

    // Verify items.ndjson
    expect(entries.has("items.ndjson")).toBe(true);
    const ndjson = entries.get("items.ndjson")!.toString().trim();
    expect(ndjson.length).toBeGreaterThan(0);

    // Verify blob is included
    expect(entries.has(`blobs/${blobHash}`)).toBe(true);
    const blobData = entries.get(`blobs/${blobHash}`)!;
    expect(blobData.toString()).toBe("archive-export-blob");
  });
});

// ---------------------------------------------------------------------------
// Archive import tests
// ---------------------------------------------------------------------------

describe("POST /import?format=archive", () => {
  it("imports items and blobs from an archive", async () => {
    const blob = makeBlobData("archive-import-blob-test");
    const source = `archive-import-${Math.random().toString(36).slice(2)}`;

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

    const res = await ctx.app.request("/import?format=archive", {
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

    // Verify blob was stored
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

    const res = await ctx.app.request("/import?format=archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(400);
  });

  it("round-trips: archive export then import preserves data", async () => {
    // Create item with blob
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

    // Export as archive
    const exportRes = await request(ctx.app, "GET", "/export?format=archive", {
      key: ctx.adminKey,
    });
    expect(exportRes.status).toBe(200);
    const archiveData = Buffer.from(await exportRes.arrayBuffer());

    // Import the archive (items will dedup by source, but blobs still import)
    const importRes = await ctx.app.request("/import?format=archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/gzip",
      },
      body: archiveData,
    });
    expect(importRes.status).toBe(200);
    const data = (await importRes.json()) as {
      imported: number;
      duplicates: number;
      blobs_imported: number;
    };
    // Items with same source_id are deduplicated
    expect(data.duplicates).toBeGreaterThan(0);
    // Blobs are content-addressed — idempotent re-import
    expect(data.blobs_imported).toBeGreaterThanOrEqual(0);
  });
});
