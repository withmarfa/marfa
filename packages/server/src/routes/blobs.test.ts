import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

describe("POST /blobs", () => {
  it("uploads a binary blob and returns hash", async () => {
    const data = new TextEncoder().encode("Hello, blob world!");
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      hash: string;
      mime_type: string;
      size: number;
    };
    expect(body.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.mime_type).toBe("application/octet-stream");
    expect(body.size).toBe(data.length);
  });

  it("deduplicates identical content", async () => {
    const data = new TextEncoder().encode("duplicate content test");
    const res1 = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "text/plain",
      },
      body: data,
    });
    const res2 = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "text/plain",
      },
      body: data,
    });
    const body1 = (await res1.json()) as { hash: string };
    const body2 = (await res2.json()) as { hash: string };
    expect(body1.hash).toBe(body2.hash);
  });

  it("rejects empty blob", async () => {
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const data = new TextEncoder().encode("no auth");
    const res = await ctx.app.request("/blobs", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: data,
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /blobs/:hash", () => {
  it("downloads a previously uploaded blob", async () => {
    const original = new TextEncoder().encode("round-trip test data");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "text/plain",
      },
      body: original,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    const downloadRes = await request(ctx.app, "GET", `/blobs/${hash}`, {
      key: ctx.adminKey,
    });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("Content-Type")).toBe("text/plain");

    const downloaded = new Uint8Array(await downloadRes.arrayBuffer());
    expect(downloaded).toEqual(original);
  });

  it("returns 404 for unknown hash", async () => {
    const fakeHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const res = await request(ctx.app, "GET", `/blobs/${fakeHash}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(404);
  });
});

describe("HEAD /blobs/:hash", () => {
  it("returns 200 with headers for existing blob", async () => {
    const data = new TextEncoder().encode("head check data");
    const uploadRes = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "text/plain",
      },
      body: data,
    });
    const { hash } = (await uploadRes.json()) as { hash: string };

    const headRes = await request(ctx.app, "HEAD", `/blobs/${hash}`, {
      key: ctx.adminKey,
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("Content-Type")).toBe("text/plain");
    expect(headRes.headers.get("Content-Length")).toBe(String(data.length));
  });

  it("returns 404 for unknown hash", async () => {
    const fakeHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const headRes = await request(ctx.app, "HEAD", `/blobs/${fakeHash}`, {
      key: ctx.adminKey,
    });
    expect(headRes.status).toBe(404);
  });

  it("returns 400 for invalid hash format", async () => {
    const headRes = await request(ctx.app, "HEAD", "/blobs/sha256:invalid", {
      key: ctx.adminKey,
    });
    expect(headRes.status).toBe(400);
  });

  it("requires authentication", async () => {
    const fakeHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const headRes = await ctx.app.request(`/blobs/${fakeHash}`, {
      method: "HEAD",
    });
    expect(headRes.status).toBe(401);
  });
});
