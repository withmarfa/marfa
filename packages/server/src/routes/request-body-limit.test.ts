import { createHash, randomBytes } from "node:crypto";
import { createGzip } from "node:zlib";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as tar from "tar-stream";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// Global request-body cap is small here so an oversized JSON write is cheap
// to construct, and so a blob well over it is cheap too: a blob upload has
// no cap, an archive restore has none, and the exemptions are what this
// file shows.
const REQUEST_CAP = 2048;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    maxRequestBytes: REQUEST_CAP,
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("global request-body size cap", () => {
  it("accepts a normal small POST /items", async () => {
    const res = await ctx.app.request("/items", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "core.note",
        properties: { body: "Hello world", title: "Test" },
      }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects an oversized POST /items with 413 request_too_large", async () => {
    // A body comfortably over the cap. The string itself is well under the
    // per-field string cap (100k), so the body-size limit is what fires.
    const big = "x".repeat(REQUEST_CAP * 2);
    const res = await ctx.app.request("/items", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "core.note",
        properties: { body: big },
      }),
    });
    expect(res.status).toBe(413);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("request_too_large");
  });

  it("rejects based on a declared oversized Content-Length", async () => {
    const res = await ctx.app.request("/items", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/json",
        "Content-Length": String(REQUEST_CAP + 5000),
      },
      body: JSON.stringify({
        type: "core.note",
        properties: { body: "small" },
      }),
    });
    expect(res.status).toBe(413);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("request_too_large");
  });

  it("exempts blob uploads from the JSON cap", async () => {
    // Many times the JSON request cap: the global limit must not apply to
    // /blobs, and the handler takes the bytes as they are.
    const data = new Uint8Array(REQUEST_CAP * 64);
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { size_bytes: number };
    expect(body.size_bytes).toBe(data.length);
  });

  it("exempts the archive restore from the JSON cap: a blob many times the cap comes back byte for byte", async () => {
    // Random bytes, so the archive is as large as the blob and gzip cannot
    // bring it under the cap.
    const data = randomBytes(REQUEST_CAP * 64);
    const hash = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    const gzip = createGzip();
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.pipe(gzip);
    const manifest = Buffer.from(
      JSON.stringify({
        version: 0,
        format: "marfa-archive-v0",
        created_at: new Date().toISOString(),
        item_count: 1,
        blob_count: 1,
        blobs: {
          [hash]: {
            mime_type: "application/octet-stream",
            size_bytes: data.length,
          },
        },
      }),
    );
    pack.entry({ name: "manifest.json", size: manifest.length }, manifest);
    const items = Buffer.from(
      JSON.stringify({
        item: {
          type: "core.file",
          properties: { blob_ref: hash, mime_type: "application/octet-stream" },
          source: "body-limit",
          source_id: "large-archive",
        },
        // As an export writes a row whose reference lent its reach, so the
        // restored row lends the working key the bytes read back below.
        lending_blobs: [hash],
      }) + "\n",
    );
    pack.entry({ name: "items.ndjson", size: items.length }, items);
    pack.entry({ name: `blobs/${hash}`, size: data.length }, data);
    pack.finalize();
    await new Promise<void>((resolve) => gzip.on("end", resolve));
    const archive = Buffer.concat(chunks);
    expect(archive.length).toBeGreaterThan(REQUEST_CAP * 32);

    const res = await ctx.app.request("/admin/restore-archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      imported: number;
      blobs_imported: number;
    };
    expect(body).toMatchObject({ imported: 1, blobs_imported: 1 });

    const read = await ctx.app.request(`/blobs/${hash}`, {
      headers: { Authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer()).equals(data)).toBe(true);
  });

  it("exempts /items/bulk from the small global cap (bulk carries many items)", async () => {
    // A bulk body well over the tiny global request cap but trivially under
    // the bulk cap (16 MB default). The global cap must NOT apply to
    // /items/bulk, or legitimate large batches would 413.
    const items = Array.from({ length: 40 }, (_, i) => ({
      type: "core.note",
      properties: { body: "x".repeat(200), title: `n${String(i)}` },
    }));
    const body = JSON.stringify({ items });
    expect(body.length).toBeGreaterThan(REQUEST_CAP);
    const res = await ctx.app.request("/items/bulk", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/json",
      },
      body,
    });
    // The body-size cap must not fire on bulk; the request reaches the handler.
    expect(res.status).not.toBe(413);
  });

  it("holds a single edge write to the request cap and the edge bulk door to the bulk cap", async () => {
    // One body, two doors: the bulk door carries many rows and takes the
    // larger cap, and the single-write door beside it does not.
    const body = JSON.stringify({
      edges: [],
      source_id: "x",
      target_id: "y",
      edge_type: "about",
      properties: { note: "x".repeat(REQUEST_CAP * 2) },
    });
    const send = (path: string) =>
      ctx.app.request(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.workingKey}`,
          "Content-Type": "application/json",
        },
        body,
      });
    expect((await send("/edges")).status).toBe(413);
    expect((await send("/edges/bulk")).status).not.toBe(413);
  });
});
