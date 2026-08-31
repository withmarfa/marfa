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
 * branch it is aiming at. In particular the "own space" case reads a job
 * created by a *different* credential, because a job the caller created
 * would be admitted by the creator branch and would prove nothing about
 * the admin branch.
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
let boundAdminA: string;
let boundAdminB: string;
let memberB: string;
let unboundPlainAdmin: string;

async function mintKey(opts: {
  label: string;
  role: "instance_admin" | "space_admin" | "member";
  spaceId?: string;
  isPlatform?: boolean;
}): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_job_scope_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      role: opts.role,
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      is_platform: opts.isPlatform ?? false,
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
  boundAdminA = await mintKey({
    label: "bound-admin-a",
    role: "instance_admin",
    spaceId: spaceA,
  });
  boundAdminB = await mintKey({
    label: "bound-admin-b",
    role: "instance_admin",
    spaceId: spaceB,
  });
  memberB = await mintKey({
    label: "member-b",
    role: "member",
    spaceId: spaceB,
  });
  // Unbound but NOT platform-flagged, so a check written against
  // `is_platform` instead of the space binding fails this suite.
  unboundPlainAdmin = await mintKey({
    label: "unbound-plain-admin",
    role: "instance_admin",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("bulk-action jobs — cross-space access", () => {
  it("cloaks another space's job as absent on read", async () => {
    const jobB = await queueJob(boundAdminB, "scope-read-b");

    const res = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: boundAdminA },
    );

    // 404, not 403: a cross-space probe must not confirm the id exists.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bulk_job_not_found");
  });

  it("cloaks another space's job as absent on cancel, and leaves it intact", async () => {
    const jobB = await queueJob(boundAdminB, "scope-cancel-b");

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: boundAdminA },
    );
    expect(res.status).toBe(404);

    // The refusal must be real, not cosmetic: the job is still cancellable
    // by someone allowed to, which proves it was never touched.
    const owner = await request(
      ctx.app,
      "DELETE",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: boundAdminB },
    );
    expect(owner.status).toBe(200);
    expect((await owner.json()) as { status: string }).toMatchObject({
      status: "cancelled",
    });
  });

  it("lets a space-bound admin reach a job another credential created in its space", async () => {
    // Created by the member, read by the admin. A job the admin created
    // would be admitted by the creator branch and prove nothing here.
    const jobB = await queueJob(memberB, "scope-sibling-b");
    expect(await readJob(boundAdminB, jobB)).toBe(200);
  });

  it("refuses a member reading a sibling credential's job in its own space", async () => {
    const jobB = await queueJob(boundAdminB, "scope-member-b");

    const res = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: memberB },
    );
    // 403 here, deliberately: inside one space the job's existence is
    // not a secret, only its contents.
    expect(res.status).toBe(403);
  });

  it("lets an unbound admin reach any space's job, without needing the platform flag", async () => {
    const jobB = await queueJob(boundAdminB, "scope-unbound-b");
    expect(await readJob(unboundPlainAdmin, jobB)).toBe(200);
  });
});

describe("bulk-action jobs — null-space jobs", () => {
  // The slice row-level security cannot fence. Every purge job lands here,
  // because purge is platform-gated and so always runs unbound.
  it("cloaks a null-space job from a space-bound admin", async () => {
    const jobNull = await queueJob(ctx.adminKey, "scope-nullspace");
    expect(await readJob(boundAdminA, jobNull)).toBe(404);
  });

  it("still lets an unbound admin reach a null-space job", async () => {
    const jobNull = await queueJob(ctx.adminKey, "scope-nullspace-owner");
    expect(await readJob(unboundPlainAdmin, jobNull)).toBe(200);
  });
});
