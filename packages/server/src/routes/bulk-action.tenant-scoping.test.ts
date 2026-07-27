/**
 * Bulk-action job access — tenant scoping.
 *
 * `GET` and `DELETE /items/bulk-actions/jobs/:id` look the job up by id
 * alone: `bulkActionJobs.getById` applies no tenant filter in either
 * dialect. Everything keeping one tenant out of another's jobs therefore
 * lives in the route's own auth check.
 *
 * The shape that matters is a credential with `role: "admin"` that is
 * bound to a tenant. `POST /admin/tenants/:id/keys` mints exactly that,
 * so it is a real credential rather than a contrived one, and the
 * hardened rule in `middleware/auth.ts` is explicit that the role alone
 * is not platform authority — only an admin with no tenant binding has
 * instance-wide reach.
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

const tenantA = `job-scope-a-${Math.random().toString(36).slice(2, 10)}`;
const tenantB = `job-scope-b-${Math.random().toString(36).slice(2, 10)}`;
let boundAdminA: string;
let boundAdminB: string;

/** A tenant-bound `role: "admin"` key, the shape the admin tenant-key
 *  route issues. Not a platform credential. */
async function mintBoundAdmin(
  label: string,
  tenantId: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_job_scope_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      role: "admin",
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      is_platform: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    tenantId,
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
  const body = (await res.json()) as { id: string };
  return body.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  boundAdminA = await mintBoundAdmin("bound-admin-a", tenantA);
  boundAdminB = await mintBoundAdmin("bound-admin-b", tenantB);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("bulk-action jobs — cross-tenant access", () => {
  it("refuses a tenant-bound admin reading another tenant's job", async () => {
    const jobB = await queueJob(boundAdminB, `scope-read-b`);

    const res = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: boundAdminA },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("refuses a tenant-bound admin cancelling another tenant's job", async () => {
    const jobB = await queueJob(boundAdminB, `scope-cancel-b`);

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: boundAdminA },
    );
    expect(res.status).toBe(403);

    // The refusal must be real, not cosmetic: the job is still cancellable
    // by someone who is allowed to, which proves it was never touched.
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

  it("still lets a tenant-bound admin reach its own tenant's job", async () => {
    const jobB = await queueJob(boundAdminB, `scope-own-b`);

    const res = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: boundAdminB },
    );
    expect(res.status).toBe(200);
  });

  it("still lets a platform admin reach any tenant's job", async () => {
    const jobB = await queueJob(boundAdminB, `scope-platform-b`);

    const res = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${jobB}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
  });
});
