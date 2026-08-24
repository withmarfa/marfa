/**
 * `/admin/runtime/dead-letters` operator route tests.
 *
 * Covers the platform-admin gate (anonymous 401, space-bound key 403),
 * the listing and replay happy paths, error propagation from the ops
 * layer (404 unknown job, 409 not-failed), the malformed-id 400, and
 * the 503 a deployment without the local substrate answers.
 *
 * The ops layer is stubbed here — the real pg-boss-backed ops are
 * exercised against a live queue in
 * `integrations/local-runtime/dead-letters.test.ts` (PG-gated).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import type {
  DeadLetterOps,
  DeadLetterJob,
} from "../integrations/local-runtime/dead-letters.js";

const JOB_ID = "8b2f2f6e-3f0a-4dfb-9f6e-0a4a6a9b1c2d";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";

const sampleJob: DeadLetterJob = {
  id: JOB_ID,
  integration: "rss-watcher",
  connection_id: "conn-123",
  kind: "schedule",
  reason: "retryable: upstream 500",
  attempts: 4,
  created_at: "2026-08-20T10:00:00.000Z",
  failed_at: "2026-08-20T10:05:00.000Z",
};

function stubOps(): DeadLetterOps & {
  replayed: string[];
  limits: number[];
} {
  const replayed: string[] = [];
  const limits: number[] = [];
  return {
    replayed,
    limits,
    list(limit: number) {
      limits.push(limit);
      return Promise.resolve([sampleJob].slice(0, limit));
    },
    count() {
      return Promise.resolve(1);
    },
    replay(id: string) {
      if (id !== JOB_ID) {
        throw new MarfaError(ErrorCode.NOT_FOUND, `No dispatch job ${id}`);
      }
      if (replayed.includes(id)) {
        throw new MarfaError(
          ErrorCode.CONFLICT,
          `Job ${id} is retry, not failed`,
          { state: "retry" },
        );
      }
      replayed.push(id);
      return Promise.resolve({ replayed: true as const, id });
    },
  };
}

describe("admin runtime dead-letter routes", () => {
  let ctx: TestContext;
  let ops: ReturnType<typeof stubOps>;
  let spaceKey: string;

  beforeAll(async () => {
    ops = stubOps();
    ctx = await createTestContext(undefined, undefined, ops);

    const suffix = Math.random().toString(36).slice(2, 10);
    spaceKey = `marfa_k1_test_space_admin_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `test-space-admin-${suffix}`,
        source: `test-space-admin-${suffix}`,
        role: "space_admin",
        type_permissions: { "*": "write" },
        default_tier: "library",
      },
      hashApiKey(spaceKey, TEST_API_KEY_SALT),
      `space-${suffix}`,
    );
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("rejects anonymous callers with 401", async () => {
    const res = await request(ctx.app, "GET", "/admin/runtime/dead-letters");
    expect(res.status).toBe(401);
  });

  it("rejects space-bound credentials with 403 on both routes", async () => {
    const listRes = await request(
      ctx.app,
      "GET",
      "/admin/runtime/dead-letters",
      { key: spaceKey },
    );
    expect(listRes.status).toBe(403);

    const replayRes = await request(
      ctx.app,
      "POST",
      `/admin/runtime/dead-letters/${JOB_ID}/replay`,
      { key: spaceKey },
    );
    expect(replayRes.status).toBe(403);
  });

  it("lists dead-lettered dispatches for a platform admin", async () => {
    const res = await request(ctx.app, "GET", "/admin/runtime/dead-letters", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: DeadLetterJob[] };
    expect(body.jobs).toEqual([sampleJob]);
  });

  it("threads the limit to the ops layer, defaulting to 50", async () => {
    // The listing happy path above ran with no limit param — the schema
    // default must have reached the ops layer.
    expect(ops.limits).toContain(50);

    const res = await request(
      ctx.app,
      "GET",
      "/admin/runtime/dead-letters?limit=7",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    expect(ops.limits).toContain(7);

    // Below the schema's minimum — clean validation error, ops untouched.
    const invalid = await request(
      ctx.app,
      "GET",
      "/admin/runtime/dead-letters?limit=0",
      { key: ctx.adminKey },
    );
    expect(invalid.status).toBe(400);
    expect(ops.limits).not.toContain(0);
  });

  it("replays a job once and refuses the second replay with 409", async () => {
    const first = await request(
      ctx.app,
      "POST",
      `/admin/runtime/dead-letters/${JOB_ID}/replay`,
      { key: ctx.adminKey },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ replayed: true, id: JOB_ID });
    expect(ops.replayed).toEqual([JOB_ID]);

    const second = await request(
      ctx.app,
      "POST",
      `/admin/runtime/dead-letters/${JOB_ID}/replay`,
      { key: ctx.adminKey },
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
    // The stub recorded exactly one replay — the refusal ran nothing.
    expect(ops.replayed).toEqual([JOB_ID]);
  });

  it("answers 404 for an unknown job id", async () => {
    const res = await request(
      ctx.app,
      "POST",
      `/admin/runtime/dead-letters/${OTHER_ID}/replay`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a malformed (non-uuid) job id with 400", async () => {
    const res = await request(
      ctx.app,
      "POST",
      "/admin/runtime/dead-letters/not-a-uuid/replay",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
  });
});

describe("without the local substrate", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("answers 503 local_runtime_not_available on both routes", async () => {
    const listRes = await request(
      ctx.app,
      "GET",
      "/admin/runtime/dead-letters",
      { key: ctx.adminKey },
    );
    expect(listRes.status).toBe(503);
    const body = (await listRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe("local_runtime_not_available");

    const replayRes = await request(
      ctx.app,
      "POST",
      `/admin/runtime/dead-letters/${JOB_ID}/replay`,
      { key: ctx.adminKey },
    );
    expect(replayRes.status).toBe(503);
  });
});
