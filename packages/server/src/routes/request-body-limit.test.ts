import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// Global request-body cap is small here so an oversized JSON write is cheap
// to construct. The blob cap sits well above it so the exemption is testable:
// a blob between the two limits must still succeed.
const REQUEST_CAP = 2048;
const BLOB_CAP = 16 * 1024;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    maxRequestBytes: REQUEST_CAP,
    maxBlobSize: BLOB_CAP,
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
        Authorization: `Bearer ${ctx.spaceKey}`,
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
        Authorization: `Bearer ${ctx.spaceKey}`,
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
        Authorization: `Bearer ${ctx.spaceKey}`,
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

  it("exempts blob uploads between the JSON cap and maxBlobSize", async () => {
    // Larger than the JSON request cap but under the blob cap — the global
    // limit must NOT apply to /blobs, and the blob handler accepts it.
    const data = new Uint8Array(REQUEST_CAP * 3);
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.spaceKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(res.status).toBe(201);
  });

  it("still enforces maxBlobSize on blob uploads with blob_too_large", async () => {
    const data = new Uint8Array(BLOB_CAP + 1);
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.spaceKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_too_large");
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
        Authorization: `Bearer ${ctx.spaceKey}`,
        "Content-Type": "application/json",
      },
      body,
    });
    // The body-size cap must not fire on bulk; the request reaches the handler.
    expect(res.status).not.toBe(413);
  });
});
