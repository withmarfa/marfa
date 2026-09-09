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
 * only fence for two cases: SQLite, and **null-space jobs**, where the row
 * carries no space for a policy to compare its GUC against and `getById` is
 * unscoped, so the route check is the whole of it.
 *
 * A null-space job is one the instance tier queued, and that is the slice, not
 * every purge job. This file said the second thing until purge moved from a
 * rank gate to `space.item_purge`: a space permission is held only by a
 * space-bound credential, so a purge job carries that credential's space like
 * any other row.
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
import { generateId } from "@withmarfa/shared";

let ctx: TestContext;

const spaceA = `job-scope-a-${Math.random().toString(36).slice(2, 10)}`;
const spaceB = `job-scope-b-${Math.random().toString(36).slice(2, 10)}`;
let boundA: string;
let boundB: string;
let siblingB: string;
let operatorKey: string;
let otherOperatorId: string;

/**
 * A credential in a named space, or the operator key when no space is given.
 *
 * The three facts go together rather than being independent axes: the schema
 * holds a space-less key to `is_operator`, a space-bound key to the opposite,
 * and a space-less key to no permission on any axis. So "unbound", "operator"
 * and "holds nothing" are one fact stated once, and the operator arm below
 * reaches what it reaches on operator authority alone.
 */
async function mintKey(opts: {
  label: string;
  spaceId?: string;
}): Promise<{ raw: string; id: string }> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_job_scope_${suffix}`;
  const isOperator = opts.spaceId === undefined;
  const created = await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      default_tier: "library",
      type_permissions: isOperator ? {} : { "*": "write" },
      edge_permissions: isOperator ? {} : { "*": "write" },
      is_operator: isOperator,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    opts.spaceId,
  );
  return { raw, id: created.id };
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
  boundA = (await mintKey({ label: "bound-a", spaceId: spaceA })).raw;
  boundB = (await mintKey({ label: "bound-b", spaceId: spaceB })).raw;
  siblingB = (await mintKey({ label: "sibling-b", spaceId: spaceB })).raw;
  // An operator key that created none of the jobs below, so whatever it
  // reaches it reaches on operator authority rather than on the creator arm.
  operatorKey = (await mintKey({ label: "operator" })).raw;
  // A second credential at the same tier, named as the creator of the
  // null-space jobs below. Only its id is wanted: it exists so those rows
  // belong to somebody other than the credential reading them.
  otherOperatorId = (await mintKey({ label: "other-operator" })).id;
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

/**
 * A job carrying no space at all, written through the store.
 *
 * `POST /items/bulk-actions` stamps the caller's space on the row, so every
 * job a space-bound credential queues there carries one and this block was
 * testing the cross-space arm again under a heading promising the other. The
 * slice belongs to the instance tier, which has no space to stamp, and the
 * store is the direct way to build one.
 *
 * `api_key_id` names a credential neither test reads as, so neither can pass
 * through the creator arm and call it the operator one.
 */
async function queueNullSpaceJob(tag: string): Promise<string> {
  const job = await ctx.storage.bulkActionJobs.create({
    id: generateId(),
    space_id: null,
    api_key_id: otherOperatorId,
    action: "transition",
    input: JSON.stringify({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    }),
    matched_ids: JSON.stringify([]),
    matched_count: 0,
    idempotency_key: null,
    created_at: new Date().toISOString(),
  });
  // The premise, asserted rather than assumed. A block named for the
  // null-space slice that quietly stopped producing null-space rows is the
  // exact failure this replaced.
  expect(job.space_id).toBeNull();
  return job.id;
}

describe("bulk-action jobs — null-space jobs", () => {
  // The slice row-level security cannot fence: no space on the row means no
  // space for a policy to compare against, so the route check stands alone
  // on both dialects.
  it("cloaks a null-space job from a space-bound credential", async () => {
    const jobNull = await queueNullSpaceJob("scope-nullspace");
    expect(await readJob(boundA, jobNull)).toBe(404);
  });

  it("still lets an operator key reach a null-space job it did not create", async () => {
    const jobNull = await queueNullSpaceJob("scope-nullspace-owner");
    expect(await readJob(operatorKey, jobNull)).toBe(200);
  });
});
