import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// Separate file so the small-cap test context doesn't interfere with
// blobs.test.ts state. Each test file builds its own context.

const CAP = 1024;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({ maxBlobSize: CAP });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /blobs — size cap", () => {
  it("accepts a payload at exactly the cap", async () => {
    const data = new Uint8Array(CAP);
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(res.status).toBe(201);
  });

  it("rejects a payload exceeding the cap with 413 blob_too_large", async () => {
    const data = new Uint8Array(CAP + 1);
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_too_large");
  });

  it("rejects based on declared Content-Length before reading body", async () => {
    // Small body but oversized Content-Length header — the pre-read check
    // must reject before buffering.
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(CAP + 1000),
      },
      body: new Uint8Array(10),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_too_large");
  });
});
