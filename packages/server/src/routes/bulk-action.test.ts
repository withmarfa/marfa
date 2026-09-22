import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seed(
  type: string,
  count: number,
  extras?: Record<string, unknown>,
): Promise<string[]> {
  const ids: string[] = [];
  const suffix = Math.random().toString(36).slice(2, 8);
  for (let i = 0; i < count; i++) {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type,
        properties: {
          body: `seed-${suffix}-${String(i)}`,
          ...(extras?.properties as object),
        },
        source_id: `seed-${suffix}-${String(i)}`,
        ...(extras?.tags !== undefined && { tags: extras.tags }),
        ...(extras?.tier !== undefined && { tier: extras.tier }),
      },
    });
    const body = (await res.json()) as { item: { id: string } };
    ids.push(body.item.id);
  }
  return ids;
}

describe("POST /items/bulk-actions (async)", () => {
  it("dry_run stays synchronous and returns matched ids without mutating", async () => {
    const tag = `dryrun-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 3, { tags: [tag] });

    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "archived",
        filter: { type: "core.note", tags: [tag] },
        dry_run: true,
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(200);
    expect(result?.dry_run).toBe(true);
    expect(result?.matched).toBe(3);
    expect(result?.succeeded).toBe(0);
    expect(result?.ids?.sort()).toEqual(ids.slice().sort());

    // Confirm no state change happened
    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.workingKey,
    });
    const item = (await getRes.json()) as { item: { state: string } };
    expect(item.item.state).toBe("active");
  });

  it("transition action archives every match via the async worker", async () => {
    const tag = `trans-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 3, { tags: [tag] });

    const { initialStatus, job, result } = await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);
    expect(job?.status).toBe("completed");
    expect(result?.succeeded).toBe(3);
    expect(result?.errored).toBe(0);

    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.workingKey,
    });
    const item = (await getRes.json()) as { item: { state: string } };
    expect(item.item.state).toBe("archived");
  });

  it("purge action requires confirm=PURGE", async () => {
    const tag = `purge-confirm-${Math.random().toString(36).slice(2, 8)}`;
    await seed("core.note", 1, { tags: [tag] });

    const { initialStatus, errorResponse } = await runBulkActionAsync(
      ctx,
      {
        action: "purge",
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(400);
    expect(errorResponse?.error.code).toBe("bulk_confirmation_required");
  });

  it("purge action deletes matching items (with confirm)", async () => {
    const tag = `purge-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 3, { tags: [tag] });

    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      {
        action: "purge",
        confirm: "PURGE",
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);
    expect(result?.succeeded).toBe(3);
    expect(result?.blob_hashes_referenced).toBeDefined();

    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.workingKey,
    });
    expect(getRes.status).toBe(404);
  });

  it("purge action refuses a credential that is not the operator (hard 403)", async () => {
    // Not the operator key, which is what makes this a test rather than a
    // tautology. The wide type map is there so the refusal cannot be
    // mistaken for a narrow one.
    const rawKey = `marfa_k1_purge_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "purge-bounded",
        source: `purge-bounded-${rawKey.slice(-6)}`,
        type_permissions: { "*": "write" },
      },
      keyHash,
    );

    const { initialStatus } = await runBulkActionAsync(
      ctx,
      {
        action: "purge",
        confirm: "PURGE",
        filter: { type: "core.note" },
      },
      rawKey,
    );
    expect(initialStatus).toBe(403);
  });

  it("update_tags adds and removes", async () => {
    const tag = `tags-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 2, { tags: [tag] });

    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      {
        action: "update_tags",
        add: ["added-tag"],
        remove: [tag],
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);
    expect(result?.succeeded).toBe(2);

    const mdRes = await request(ctx.app, "GET", `/items/${ids[0]!}/metadata`, {
      key: ctx.workingKey,
    });
    const mdBody = (await mdRes.json()) as {
      metadata: { tags: string[] };
    };
    expect(mdBody.metadata.tags).toContain("added-tag");
    expect(mdBody.metadata.tags).not.toContain(tag);
  });

  it("update_tags rejects empty add AND remove", async () => {
    const { initialStatus } = await runBulkActionAsync(
      ctx,
      {
        action: "update_tags",
        filter: { type: "core.note" },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(400);
  });

  it("update_tier flips the tier", async () => {
    const tag = `lib-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 2, { tags: [tag], tier: "feed" });

    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      {
        action: "update_tier",
        tier: "library",
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);
    expect(result?.succeeded).toBe(2);

    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.workingKey,
    });
    const item = (await getRes.json()) as {
      item: { tier: "library" | "feed" };
    };
    expect(item.item.tier).toBe("library");
  });

  it("update_properties shallow-merges", async () => {
    const tag = `props-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 2, { tags: [tag] });

    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      {
        action: "update_properties",
        patch: { extra_field: "patched" },
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);
    expect(result?.succeeded).toBe(2);

    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.workingKey,
    });
    const item = (await getRes.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(item.item.properties.extra_field).toBe("patched");
    // Original field still present (shallow merge)
    expect(item.item.properties.body).toBeDefined();
  });

  it("update_occurred_at changes the item's own time", async () => {
    const tag = `ts-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 1, { tags: [tag] });
    const newTs = "2020-01-01T00:00:00.000Z";

    const { initialStatus } = await runBulkActionAsync(
      ctx,
      {
        action: "update_occurred_at",
        occurred_at: newTs,
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);

    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.workingKey,
    });
    const item = (await getRes.json()) as { item: { occurred_at: string } };
    expect(item.item.occurred_at).toBe(newTs);
  });

  it("update_occurred_at rejects non-ISO strings", async () => {
    const { initialStatus } = await runBulkActionAsync(
      ctx,
      {
        action: "update_occurred_at",
        occurred_at: "not a date",
        filter: { type: "core.note" },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(400);
  });

  it("max_items cap exceeded returns 400 bulk_cap_exceeded", async () => {
    const tag = `cap-${Math.random().toString(36).slice(2, 8)}`;
    await seed("core.note", 5, { tags: [tag] });

    const { initialStatus, errorResponse } = await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
        max_items: 2,
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(400);
    expect(errorResponse?.error.code).toBe("bulk_cap_exceeded");
  });

  it("filter grammar reuses the full DSL", async () => {
    // Exercise a moderately rich filter: type + tag + filter-DSL expression
    const tag = `dsl-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 3, {
      tags: [tag],
      properties: { body: "dsl-body" },
    });

    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "archived",
        filter: {
          type: "core.note",
          tags: [tag],
          filter: 'properties.body eq "dsl-body"',
        },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);
    expect(result?.succeeded).toBe(3);

    // Verify
    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.workingKey,
    });
    const item = (await getRes.json()) as { item: { state: string } };
    expect(item.item.state).toBe("archived");
  });

  it("writes one aggregate audit entry on job create", async () => {
    const tag = `audit-${Math.random().toString(36).slice(2, 8)}`;
    await seed("core.note", 3, { tags: [tag] });

    await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );

    // Audit insert is fire-and-forget — poll until our row lands.
    interface AuditDataShape {
      data: {
        action: string;
        resource_type: string;
        details?: Record<string, unknown>;
      }[];
    }
    const auditBody = await waitForAudit<AuditDataShape>(
      async () => {
        const auditRes = await request(
          ctx.app,
          "GET",
          "/audit?action=items.bulk_action&limit=50",
          { key: ctx.workingKey },
        );
        return (await auditRes.json()) as AuditDataShape;
      },
      (b) =>
        b.data.some(
          (e) =>
            (e.details as { sub_action?: string } | undefined)?.sub_action ===
              "transition" &&
            (e.details as { matched?: number } | undefined)?.matched === 3,
        ),
    );
    const mine = auditBody.data.find(
      (e) =>
        (e.details as { sub_action?: string } | undefined)?.sub_action ===
          "transition" &&
        (e.details as { matched?: number } | undefined)?.matched === 3,
    );
    expect(mine).toBeDefined();
    expect(mine?.resource_type).toBe("items.bulk_action");
    // The audit entry also carries the job id for traceability.
    expect(
      (mine?.details as { job_id?: string } | undefined)?.job_id,
    ).toBeDefined();
  });
});

describe("GET + DELETE /items/bulk-actions/jobs/:id", () => {
  it("GET returns the terminal job envelope after the worker runs", async () => {
    const tag = `get-${Math.random().toString(36).slice(2, 8)}`;
    await seed("core.note", 2, { tags: [tag] });

    const { job } = await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );

    expect(job).toBeDefined();
    expect(job?.status).toBe("completed");
    expect(job?.matched).toBe(2);
    expect(job?.succeeded).toBe(2);
    expect(job?.errored).toBe(0);
    expect(job?.started_at).toBeDefined();
    expect(job?.finished_at).toBeDefined();
  });

  it("GET 404s for an unknown job id", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items/bulk-actions/jobs/does-not-exist",
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bulk_job_not_found");
  });

  it("DELETE flips a queued job to canceled", async () => {
    const tag = `cancel-${Math.random().toString(36).slice(2, 8)}`;
    await seed("core.note", 2, { tags: [tag] });

    // POST without running the worker — the job sits in `queued`.
    const postRes = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      body: {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
    });
    expect(postRes.status).toBe(202);
    const queued = (await postRes.json()) as { id: string; status: string };
    expect(queued.status).toBe("queued");

    const delRes = await request(
      ctx.app,
      "DELETE",
      `/items/bulk-actions/jobs/${queued.id}`,
      { key: ctx.workingKey },
    );
    expect(delRes.status).toBe(200);
    const canceled = (await delRes.json()) as { status: string };
    expect(canceled.status).toBe("canceled");
  });

  it("DELETE sets a running job to canceled, which the door does itself", async () => {
    // The half of the door's description no caller can reach and so no
    // conformance fixture can hold: the worker takes a job the moment it
    // is queued, so only a test that claims the row by hand can present
    // the door with one that is running. What stops between chunks is the
    // work, not the write.
    const tag = `cancel-running-${Math.random().toString(36).slice(2, 8)}`;
    await seed("core.note", 2, { tags: [tag] });

    const postRes = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      body: {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
    });
    expect(postRes.status).toBe(202);
    const queued = (await postRes.json()) as { id: string; status: string };

    const claimed = await ctx.storage.bulkActionJobs.claimNext(
      "test-worker",
      new Date().toISOString(),
    );
    expect(claimed?.id).toBe(queued.id);
    expect(claimed?.status).toBe("in_progress");

    const delRes = await request(
      ctx.app,
      "DELETE",
      `/items/bulk-actions/jobs/${queued.id}`,
      { key: ctx.workingKey },
    );
    expect(delRes.status).toBe(200);
    const answered = (await delRes.json()) as { status: string };
    expect(answered.status).toBe("canceled");

    // And the row, not only the answer. A door that answered `canceled`
    // optimistically and wrote nothing would satisfy the line above, which
    // is the opposite of what this case claims: that the door does it.
    const stored = await ctx.storage.bulkActionJobs.getById(queued.id);
    expect(stored?.status).toBe("canceled");
  });

  it("DELETE 404s for an unknown job id", async () => {
    const res = await request(
      ctx.app,
      "DELETE",
      "/items/bulk-actions/jobs/does-not-exist",
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(404);
  });

  it("a credential that did not start the job is 403 on GET", async () => {
    // Two ordinary credentials, because that is the only shape the 403
    // branch has left: an operator key reaches every job, and no permission
    // a sibling can hold opens another credential's job to it.
    const ownerKey = `marfa_k1_owner_${Math.random().toString(36).slice(2)}`;
    await ctx.storage.keys.create(
      {
        label: "job-owner",
        source: `job-owner-${ownerKey.slice(-6)}`,
        type_permissions: { "*": "write" },
      },
      hashApiKey(ownerKey, "test-salt"),
    );

    const postRes = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ownerKey,
      body: {
        action: "transition",
        state: "archived",
        filter: { type: "core.note" },
      },
    });
    expect(postRes.status).toBe(202);
    const queued = (await postRes.json()) as { id: string };

    const rawKey = `marfa_k1_foreign_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "foreign-sibling",
        source: `foreign-${rawKey.slice(-6)}`,
        type_permissions: { "*": "read" },
      },
      keyHash,
    );

    const getRes = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${queued.id}`,
      { key: rawKey },
    );
    expect(getRes.status).toBe(403);
  });
});
