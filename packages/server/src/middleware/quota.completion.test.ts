/**
 * Quota wiring completion — coverage beyond items + webhooks:
 *
 *   - `POST /blobs` enforces both `blobs` (count) and
 *     `storage_bytes` (sum-of-sizes) ceilings.
 *
 *   - The rate-limit middleware applies a per-space
 *     `rate_per_minute_limit` ceiling on top of the per-credential
 *     window — a noisy single credential is bounded by the
 *     credential cap, a space's collective fleet by the space cap.
 *
 *   - Space-less keys (the operator key, single-space self-hosts)
 *     bypass per-space rate enforcement entirely.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "./auth.js";

/**
 * `test-utils.request` hard-codes Content-Type: application/json and
 * JSON-stringifies the body. Blob uploads need raw bytes with a
 * different content-type, so we drop down to `app.request()` here.
 */
async function uploadBlob(
  ctx: TestContext,
  key: string,
  payload: string,
): Promise<Response> {
  return ctx.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/octet-stream",
    },
    body: payload,
  });
}

async function mintSpaceKey(
  ctx: TestContext,
  spaceId: string,
  label: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_quota_completion_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      default_tier: "library",
      type_permissions: { "*": "write" },
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

describe("quota wiring — POST /blobs", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("enforces blobs (count) quota — third upload over a cap of 2 returns 429", async () => {
    ctx = await createTestContext();
    const spaceId = `t-blobs-${Math.random().toString(36).slice(2, 10)}`;
    const key = await mintSpaceKey(ctx, spaceId, "ws-blobs");
    await ctx.storage.spaceQuotas.set(spaceId, { blobs_limit: 2 });

    const r1 = await uploadBlob(ctx, key, "payload-1-bytes");
    expect(r1.status).toBe(201);
    const r2 = await uploadBlob(ctx, key, "payload-2-bytes-different");
    expect(r2.status).toBe(201);
    const r3 = await uploadBlob(ctx, key, "payload-3-bytes-third");
    expect(r3.status).toBe(429);

    const body = (await r3.json()) as {
      error: {
        code: string;
        details?: { resource: string; limit: number; current: number };
      };
    };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details?.resource).toBe("blobs");
    expect(body.error.details?.limit).toBe(2);
  });

  it("enforces storage_bytes quota — second upload that pushes over cap returns 429", async () => {
    ctx = await createTestContext();
    const spaceId = `t-storage-${Math.random().toString(36).slice(2, 10)}`;
    const key = await mintSpaceKey(ctx, spaceId, "ws-storage");
    // Cap of 32 bytes. Two uploads of 20 bytes each — second
    // should fail because 20 + 20 = 40 > 32.
    await ctx.storage.spaceQuotas.set(spaceId, {
      storage_bytes_limit: 32,
    });

    const payload = "x".repeat(20);
    const r1 = await uploadBlob(ctx, key, payload);
    expect(r1.status).toBe(201);

    const r2 = await uploadBlob(ctx, key, payload + "different");
    expect(r2.status).toBe(429);
    const body = (await r2.json()) as {
      error: { code: string; details?: { resource: string } };
    };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.details?.resource).toBe("storage_bytes");
  });

  it("the operator key (no space_id) bypasses quota on POST /blobs", async () => {
    ctx = await createTestContext();
    // Set a quota row for the empty-string sentinel — if the bypass
    // weren't in place, space-less keys would hit it.
    await ctx.storage.spaceQuotas.set("", { blobs_limit: 0 });

    // ctx.adminKey has no space_id (the bootstrap credential) — bypass kicks
    // in.
    const r = await uploadBlob(ctx, ctx.adminKey, "any-content");
    expect(r.status).toBe(201);
  });
});

describe("quota wiring — per-space rate ceiling", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("enforces space rate_per_minute_limit on top of per-credential window", async () => {
    // Per-credential limit is high (default 1000); space cap is the
    // tighter gate. Two credentials in the same space share the cap.
    ctx = await createTestContext({
      rateLimitEnabled: true,
      rateLimitDefaultLimit: 1000,
      rateLimitWindowMs: 60_000,
    });
    const spaceId = `t-rate-${Math.random().toString(36).slice(2, 10)}`;
    // Set quota BEFORE minting keys / firing requests so the
    // middleware's first cache-fetch sees the new value. The cache
    // TTL is 60s; we don't try to invalidate mid-test.
    await ctx.storage.spaceQuotas.set(spaceId, {
      rate_per_minute_limit: 3,
    });
    const keyA = await mintSpaceKey(ctx, spaceId, "ws-rate-a");
    const keyB = await mintSpaceKey(ctx, spaceId, "ws-rate-b");

    // Burn the cap with a mix of A + B. The 4th request must 429.
    const r1 = await request(ctx.app, "GET", "/items", { key: keyA });
    expect(r1.status).toBe(200);
    const r2 = await request(ctx.app, "GET", "/items", { key: keyB });
    expect(r2.status).toBe(200);
    const r3 = await request(ctx.app, "GET", "/items", { key: keyA });
    expect(r3.status).toBe(200);
    const r4 = await request(ctx.app, "GET", "/items", { key: keyB });
    expect(r4.status).toBe(429);
    const body = (await r4.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("the space-less operator key bypasses space rate ceiling", async () => {
    ctx = await createTestContext({
      rateLimitEnabled: true,
      rateLimitDefaultLimit: 1000,
      rateLimitWindowMs: 60_000,
      defaultQuotaRatePerMinute: 2,
    });
    // ctx.adminKey has no space_id — should bypass the per-space
    // ceiling and only be subject to the per-credential cap (1000).
    for (let i = 0; i < 5; i++) {
      const r = await request(ctx.app, "GET", "/items", {
        key: ctx.adminKey,
      });
      expect(r.status).toBe(200);
    }
  });
});
