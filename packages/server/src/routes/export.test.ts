import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as tar from "tar-stream";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
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
  it("sends its first record before reading the rest", async () => {
    const bulk = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: Array.from({ length: 60 }, (_, i) => ({
          type: "core.note",
          properties: { body: `Streamed ${String(i)}` },
        })),
        mode: "create_only",
      },
    });
    expect(bulk.status).toBe(200);

    const metadata = ctx.storage.metadata;
    const get = metadata.get.bind(metadata);
    let reads = 0;
    metadata.get = (id) => {
      reads += 1;
      return get(id);
    };

    // Over a real socket, because what holds a first byte back is when the
    // server gets to write it, which an in-process fetch never waits on.
    const server = serve({ fetch: ctx.app.fetch, port: 0 });
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(
        `http://127.0.0.1:${String(port)}/export?type=core.note`,
        { headers: { Authorization: `Bearer ${ctx.workingKey}` } },
      );
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();

      const first = await reader.read();
      expect(first.done).toBe(false);
      const readsAtFirstRecord = reads;
      let text = decoder.decode(first.value, { stream: true });
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      const itemLines = text
        .trim()
        .split("\n")
        .filter((line) => "item" in (JSON.parse(line) as object)).length;

      // The witness: every item line cost one counted read, so a body
      // built before its first byte was sent would show them all here.
      expect(reads).toBe(itemLines);
      expect(itemLines).toBeGreaterThanOrEqual(60);
      expect(readsAtFirstRecord).toBeLessThan(itemLines / 2);
    } finally {
      metadata.get = get;
      server.close();
    }
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
    expect(manifest.version).toBe(0);
    expect(manifest.format).toBe("marfa-archive-v0");
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

  it("carries a blob named only in the properties of an edge it carries, to a key that reads the edge", async () => {
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: new TextEncoder().encode("edge-property-blob"),
    });
    const { hash } = (await uploadRes.json()) as { hash: string };
    const ids: string[] = [];
    for (const source_id of ["ae-edge-1", "ae-edge-2"]) {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: "an end" }, source_id },
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { item: { id: string } }).item.id);
    }
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: {
        source_id: ids[0],
        target_id: ids[1],
        edge_type: "about",
        properties: { caption: `see ![it](${hash})` },
      },
    });
    expect(edge.status).toBe(201);

    const archived = async (key: string): Promise<Map<string, Buffer>> => {
      const res = await request(ctx.app, "GET", "/export?format=archive", {
        key,
      });
      expect(res.status).toBe(200);
      const archive = Buffer.from(await res.arrayBuffer());
      const entries = new Map<string, Buffer>();
      const extract = tar.extract();
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
        Readable.from(archive).pipe(createGunzip()).pipe(extract);
      });
      return entries;
    };

    // An archive carries what `GET /blobs/{hash}` would serve the key. A key
    // that reads the notes but not the edge's type is served nothing, and its
    // archive carries neither the edge nor the bytes.
    const blind = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
      edge_permissions: {},
    });
    expect((await archived(blind)).has(`blobs/${hash}`)).toBe(false);
    expect(
      (await archived(ctx.workingKey)).get(`blobs/${hash}`)?.toString(),
    ).toBe("edge-property-blob");
  });
});
