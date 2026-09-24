import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as tar from "tar-stream";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { ensureInstanceId } from "../storage/instance-id.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("GET /export", () => {
  it("exports items as NDJSON", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "Export test" },
        source_id: "exp-1",
      },
    });

    const res = await request(ctx.app, "GET", "/export", {
      key: ctx.workingKey,
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
      key: ctx.workingKey,
      body: {
        type: "core.bookmark",
        properties: { url: "https://example.com" },
      },
    });

    const res = await request(ctx.app, "GET", "/export?type=core.bookmark", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const lines = text.trim().split("\n");
    for (const line of lines) {
      // Edge lines ride behind the items — the type filter applies to items.
      const parsed = JSON.parse(line) as { item?: { type: string } };
      if (!parsed.item) continue;
      expect(parsed.item.type).toBe("core.bookmark");
    }
  });

  it("filters export by source", async () => {
    // Two keys writing under their own sources give two distinct item
    // sources.
    const tag = Math.random().toString(36).slice(2);
    const sourceA = `export-src-a-${tag}`;
    const sourceB = `export-src-b-${tag}`;

    const mintKey = async (source: string): Promise<string> => {
      const res = await request(ctx.app, "POST", "/keys", {
        key: ctx.workingKey,
        body: {
          label: source,
          source,
          type_permissions: { "*": "write" },
        },
      });
      return ((await res.json()) as { key: string }).key;
    };
    const keyA = await mintKey(sourceA);
    const keyB = await mintKey(sourceB);

    for (const [key, sid] of [
      [keyA, "a-1"],
      [keyA, "a-2"],
      [keyB, "b-1"],
    ] as const) {
      await request(ctx.app, "POST", "/items", {
        key,
        body: {
          type: "core.note",
          properties: { body: "source filter" },
          source_id: sid,
        },
      });
    }

    const res = await request(ctx.app, "GET", `/export?source=${sourceA}`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const parsedLines = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { item?: { source: string } });
    const itemLines = parsedLines.filter((p) => p.item !== undefined);
    expect(itemLines.length).toBe(2);
    for (const parsed of itemLines) {
      expect(parsed.item?.source).toBe(sourceA);
    }
  });

  it("round-trips: export then /items/bulk produces same items", async () => {
    // Round-trip via the new /items/bulk endpoint (replaces /import).
    // Use a new source_id on the bulk side so the insert doesn't dedupe.
    const sourceId = `rt-${Math.random().toString(36).slice(2)}`;
    await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "Round trip note", title: "RT" },
        source_id: sourceId,
        tags: ["roundtrip"],
      },
    });

    const exportRes = await request(ctx.app, "GET", `/export?type=core.note`, {
      key: ctx.workingKey,
    });
    const exportText = await exportRes.text();
    const lines = exportText.trim().split("\n");
    const exported = lines
      .map(
        (l) =>
          JSON.parse(l) as {
            item?: Record<string, unknown>;
            metadata?: Record<string, unknown>;
          },
      )
      .filter(
        (
          e,
        ): e is {
          item: Record<string, unknown>;
          metadata: Record<string, unknown>;
        } => e.item !== undefined,
      );

    const ours = exported.find(
      (e) => (e.item as { source_id?: string }).source_id === sourceId,
    );
    expect(ours).toBeDefined();

    const bulkRes = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: ours?.item.properties,
            source_id: `${sourceId}-copy`,
          },
        ],
        mode: "create_only",
      },
    });
    expect(bulkRes.status).toBe(200);
    const bulkData = (await bulkRes.json()) as {
      counts: { created: number };
    };
    expect(bulkData.counts.created).toBe(1);
  });
});

describe("GET /export?format=archive", () => {
  it("produces a valid tar.gz with manifest, items, and blobs", async () => {
    const blobContent = new TextEncoder().encode("archive-export-blob");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: blobContent,
    });
    const { hash: blobHash } = (await uploadRes.json()) as { hash: string };

    await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "Has a blob", blob_ref: blobHash },
        source_id: "ae-1",
      },
    });

    const res = await request(ctx.app, "GET", "/export?format=archive", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");

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

    expect(entries.has("manifest.json")).toBe(true);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      version: number;
      format: string;
      instance_id: string;
      item_count: number;
      blob_count: number;
      blobs: Record<string, { mime_type: string; size_bytes: number }>;
    };
    expect(manifest.version).toBe(2);
    expect(manifest.format).toBe("marfa-archive-v2");
    expect(manifest.item_count).toBeGreaterThan(0);
    // The instance that wrote it. Nothing on the read side consults this
    // either, for the reason the blob entry below gives, and it is asserted
    // against the store rather than against a shape so that an export which
    // invented a value rather than reading the instance's own would redden.
    expect(manifest.instance_id).toBe(
      await ensureInstanceId(ctx.storage.settings),
    );

    // The manifest's blob entry, pinned by key and by value. Nothing on the
    // read side consults it — a restore takes each blob's length from the tar
    // entry — so without this the writer could emit any key it liked, or any
    // number, and a full round trip would still pass.
    expect(manifest.blobs[blobHash]).toEqual({
      mime_type: "application/octet-stream",
      size_bytes: "archive-export-blob".length,
    });

    expect(entries.has("items.ndjson")).toBe(true);
    const ndjson = entries.get("items.ndjson")!.toString().trim();
    expect(ndjson.length).toBeGreaterThan(0);

    expect(entries.has(`blobs/${blobHash}`)).toBe(true);
    const blobData = entries.get(`blobs/${blobHash}`)!;
    expect(blobData.toString()).toBe("archive-export-blob");
  });
});
