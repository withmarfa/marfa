/**
 * A read of a blob's bytes, by key or through a signed link, waits on each
 * store that holds them only until it opens the bytes, then asks the next,
 * and answers `blob_store_unavailable` when none does.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BlobReplicator } from "../housekeeping/blob-replicate.js";
import { storeChecks } from "../storage/blob-layer.js";
import type { BlobStore } from "../storage/blob-store.js";
import {
  closeTestContexts,
  createTestContext,
  request,
  withSecondStore,
  type TestContext,
} from "../test-utils.js";

const contexts: TestContext[] = [];
const timeout = storeChecks.timeoutMs;
afterEach(() => {
  storeChecks.timeoutMs = timeout;
});
afterAll(() => closeTestContexts(contexts));

async function holding(content: string): Promise<{
  ctx: TestContext;
  hash: string;
}> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  const bytes = new TextEncoder().encode(content);
  const uploaded = await ctx.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      "Content-Type": "text/plain",
    },
    body: bytes,
  });
  expect(uploaded.status).toBe(201);
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  // Named by an item, so the working key may read the blob.
  const named = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.file",
      properties: { blob_ref: hash, mime_type: "text/plain" },
    },
  });
  expect(named.status).toBe(201);
  return { ctx, hash };
}

/** Make `store.get` wait until its caller gives up, and count the calls. */
function silence(store: BlobStore): { calls: number } {
  const seen = { calls: 0 };
  store.get = (_hash, _range, signal) => {
    seen.calls++;
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => {
        reject(new Error("the read was given up"));
      });
    });
  };
  return seen;
}

async function read(ctx: TestContext, hash: string) {
  return request(ctx.app, "GET", `/blobs/${hash}`, { key: ctx.workingKey });
}

async function link(ctx: TestContext, hash: string): Promise<string> {
  const res = await request(ctx.app, "GET", `/blobs/${hash}/url`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  const url = new URL(((await res.json()) as { url: string }).url);
  return url.pathname + url.search;
}

/** Settle within `ms`, or fail rather than hang the run. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`still waiting after ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("a read of bytes a store does not open", () => {
  it("answers 503 blob_store_unavailable when the only store holding them does not answer", async () => {
    const { ctx, hash } = await holding("a store that never opens");
    const signed = await link(ctx, hash);
    // The witness: both doors serve the bytes while the store answers.
    expect((await read(ctx, hash)).status).toBe(200);
    expect((await ctx.app.request(signed)).status).toBe(200);

    const disk = silence(ctx.blobs.disk);
    storeChecks.timeoutMs = 50;
    const res = await within(read(ctx, hash), 5_000);
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Error-Code")).toBe("blob_store_unavailable");
    const fetched = await within(
      Promise.resolve(ctx.app.request(signed)),
      5_000,
    );
    expect(fetched.status).toBe(503);
    expect(fetched.headers.get("X-Error-Code")).toBe("blob_store_unavailable");
    expect(disk.calls).toBe(2);
  });

  it("serves the bytes from another store that holds them", async () => {
    const content = "a second store that answers";
    const { ctx, hash } = await holding(content);
    const { stores, second } = await withSecondStore(ctx);
    expect(
      await new BlobReplicator(ctx.storage, stores, {
        maxBlobs: 10,
        maxBytes: 1024 * 1024,
      }).runOnce(),
    ).toMatchObject({ copied: 1 });
    const signed = await link(ctx, hash);

    const disk = silence(ctx.blobs.disk);
    storeChecks.timeoutMs = 50;
    const res = await within(read(ctx, hash), 5_000);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
    const fetched = await within(
      Promise.resolve(ctx.app.request(signed)),
      5_000,
    );
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe(content);
    // Asked first and passed over, not skipped: the second store answered.
    expect(disk.calls).toBe(2);
    expect((await second.has(hash)) !== null).toBe(true);
  });
});
