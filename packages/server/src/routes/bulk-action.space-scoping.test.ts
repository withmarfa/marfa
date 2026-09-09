/**
 * Bulk-action job access — space scoping.
 *
 * `GET` and `DELETE /items/bulk-actions/jobs/:id` look the job up by id
 * alone: `bulkActionJobs.getById` applies no space filter in either
 * dialect. Everything keeping one space out of another's jobs therefore
 * lives in the route's own auth check.
 *
 * Postgres row-level security fences spaceed rows independently, so on
 * that dialect the route check is the second of two fences. It is the
 * only fence for two cases: SQLite, and **null-space jobs**, which RLS
 * admits by design. That slice is not an edge case — purge is
 * platform-gated, so every purge job is null-space, and its result
 * envelope can carry item ids from across the instance.
 *
 * The tests below are written so that each one can only pass through the
 * branch it is aiming at. In particular the operator cases read jobs a
 * *different* credential created, because a job the caller created would be
 * admitted by the creator branch and would prove nothing about the operator
 * one.
 *
 * Two branches remain, and there is deliberately no third: operator
 * authority, and the credential that started the job. Nothing in a space
 * reads another credential's job there, because no space permission says so
 * and inventing one to preserve a retired rank would be widening the model
 * to fit a line of code.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

const spaceA = `job-scope-a-${Math.random().toString(36).slice(2, 10)}`;
const spaceB = `job-scope-b-${Math.random().toString(36).slice(2, 10)}`;
let boundA: string;
let boundB: string;
let siblingB: string;
let operatorKey: string;

/**
 * A credential in a named space, or an operator key when no space is given.
 *
 * The two go together rather than being independent axes: the schema holds a
 * space-less key to `is_operator` and a space-bound key to the opposite, so
 * "unbound" and "operator" are one fact stated once.
 */
async function mintKey(opts: {
  label: string;
  spaceId?: string;
}): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_job_scope_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      is_operator: opts.spaceId === undefined,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    opts.spaceId,
  );
  return raw;
}

/** Queue a job without running the worker, so it stays cancellable. */
async function queueJob(key: string, tag: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items/bulk-actions", {
    key,
    body: { action: "transition", state: "archived", filter: { tags: [tag] } },
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { id: string }).id;
}

async function readJob(key: string, id: string): Promise<number> {
  const res = await request(ctx.app, "GET", `/items/bulk-actions/jobs/${id}`, {
    key,
  });
  return res.status;
}

beforeAll(async () => {
  ctx = await createTestContext();
  boundA = await mintKey({ label: "bound-a", spaceId: spaceA });
  boundB = await mintKey({ label: "bound-b", spaceId: spaceB });
  siblingB = await mintKey({ label: "sibling-b", spaceId: spaceB });
  // An operator key that created none of the jobs below, so whatever it
  // reaches it reaches on operator authority rather than on the creator arm.
  operatorKey = await mintKey({ label: "operator" });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("bulk-action jobs — cross-space access", () => {
  it("cloaks another space's job as absent on read", async () => {
    const jobB = await queueJob(boundB, "scope-read-b");

    const res = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: boundA },
    );

    // 404, not 403: a cross-space probe must not confirm the id exists.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bulk_job_not_found");
  });

  it("cloaks another space's job as absent on cancel, and leaves it intact", async () => {
    const jobB = await queueJob(boundB, "scope-cancel-b");

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: boundA },
    );
    expect(res.status).toBe(404);

    // The refusal must be real, not cosmetic: the job is still cancellable
    // by someone allowed to, which proves it was never touched.
    const owner = await request(
      ctx.app,
      "DELETE",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: boundB },
    );
    expect(owner.status).toBe(200);
    expect((await owner.json()) as { status: string }).toMatchObject({
      status: "cancelled",
    });
  });

  it("refuses a sibling credential reading a job in its own space", async () => {
    const jobB = await queueJob(boundB, "scope-sibling-b");

    const res = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: siblingB },
    );
    // 403 here, deliberately: inside one space the job's existence is
    // not a secret, only its contents. Every non-creator in the space gets
    // this answer now — there is no rank that reads a sibling's job.
    expect(res.status).toBe(403);
  });

  it("lets an operator key reach any space's job", async () => {
    const jobB = await queueJob(boundB, "scope-operator-b");
    expect(await readJob(operatorKey, jobB)).toBe(200);
  });
});

describe("bulk-action jobs — null-space jobs", () => {
  // The slice row-level security cannot fence. Every purge job lands here,
  // because purge is platform-gated and so always runs unbound.
  it("cloaks a null-space job from a space-bound credential", async () => {
    const jobNull = await queueJob(ctx.spaceKey, "scope-nullspace");
    expect(await readJob(boundA, jobNull)).toBe(404);
  });

  it("still lets an operator key reach a null-space job it did not create", async () => {
    const jobNull = await queueJob(ctx.spaceKey, "scope-nullspace-owner");
    expect(await readJob(operatorKey, jobNull)).toBe(200);
  });
});
