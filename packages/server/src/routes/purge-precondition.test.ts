/**
 * The preconditions a purge may carry: the version the caller read on the
 * single door, and the ids a dry run returned on the bulk one. A purge is
 * irrecoverable, so a change made after the person confirmed must be
 * refused or left alone rather than destroyed unseen.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createNote(tags?: string[]): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      properties: { body: "to purge" },
      ...(tags && { tags }),
    },
  });
  const body = (await res.json()) as { item: { id: string } };
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body.item.id;
}

async function trash(id: string): Promise<void> {
  const res = await request(ctx.app, "DELETE", `/items/${id}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
}

describe("DELETE /items/{id}/purge?version=", () => {
  it("trashing leaves the version where it was", async () => {
    const id = await createNote();
    const before = await ctx.storage.items.get(id);
    await trash(id);
    const after = await ctx.storage.items.getIncludingTrashed(id);
    expect(after?.state).toBe("trashed");
    expect(after?.version).toBe(before?.version);
  });

  it("refuses a stale version with version_conflict and purges nothing", async () => {
    const id = await createNote();
    const patched = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: { properties: { body: "changed" }, version: 1 },
    });
    expect(patched.status).toBe(200);
    await trash(id);

    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${id}/purge?version=1`,
      {
        key: ctx.workingKey,
      },
    );
    const body = (await res.json()) as {
      error: { code: string; status: number };
      current: { version: number; id: string };
    };
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(res.headers.get("X-Error-Code")).toBe("version_conflict");
    expect(body.error).toMatchObject({ code: "version_conflict", status: 409 });
    expect(body.current).toMatchObject({ id, version: 2 });

    const survivor = await ctx.storage.items.getIncludingTrashed(id);
    expect(survivor?.state).toBe("trashed");
  });

  it("purges at the version the row holds", async () => {
    const id = await createNote();
    await trash(id);
    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${id}/purge?version=1`,
      {
        key: ctx.workingKey,
      },
    );
    expect(res.status).toBe(200);
    expect(await ctx.storage.items.getIncludingTrashed(id)).toBeNull();
  });

  it("refuses a version that is not a whole number", async () => {
    const id = await createNote();
    await trash(id);
    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${id}/purge?version=one`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(400);
    expect(await ctx.storage.items.getIncludingTrashed(id)).not.toBeNull();
  });

  it("refuses a query parameter it does not declare rather than purging", async () => {
    const id = await createNote();
    await trash(id);
    const res = await request(
      ctx.app,
      "DELETE",
      `/items/${id}/purge?verison=1`,
      { key: ctx.workingKey },
    );
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(await ctx.storage.items.getIncludingTrashed(id)).not.toBeNull();
  });
});

describe("POST /items/bulk-actions purge with expected_ids", () => {
  it("purges only the rows the dry run returned, leaving a row trashed since", async () => {
    const tag = `expected-${Math.random().toString(36).slice(2, 8)}`;
    const first = await createNote([tag]);
    const second = await createNote([tag]);
    const late = await createNote([tag]);
    await trash(first);
    await trash(second);

    const filter = { tags: [tag], state: "trashed" };
    const dry = await runBulkActionAsync(
      ctx,
      { action: "purge", confirm: "PURGE", filter, dry_run: true },
      ctx.workingKey,
    );
    const seen = dry.result?.ids ?? [];
    expect(seen.slice().sort()).toEqual([first, second].sort());

    await trash(late);
    // The witness: the filter now reaches the late row.
    const now = await runBulkActionAsync(
      ctx,
      { action: "purge", confirm: "PURGE", filter, dry_run: true },
      ctx.workingKey,
    );
    expect(now.result?.ids).toContain(late);

    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      { action: "purge", confirm: "PURGE", filter, expected_ids: seen },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);
    expect(result?.matched).toBe(2);
    expect(result?.succeeded).toBe(2);
    expect(await ctx.storage.items.getIncludingTrashed(first)).toBeNull();
    expect(await ctx.storage.items.getIncludingTrashed(second)).toBeNull();
    const survivor = await ctx.storage.items.getIncludingTrashed(late);
    expect(survivor?.state).toBe("trashed");
  });

  it("purges no listed id the filter no longer matches", async () => {
    const tag = `expected-gone-${Math.random().toString(36).slice(2, 8)}`;
    const outside = await createNote();
    await trash(outside);
    const inside = await createNote([tag]);
    await trash(inside);

    const { result } = await runBulkActionAsync(
      ctx,
      {
        action: "purge",
        confirm: "PURGE",
        filter: { tags: [tag], state: "trashed" },
        expected_ids: [inside, outside],
      },
      ctx.workingKey,
    );
    expect(result?.matched).toBe(1);
    expect(await ctx.storage.items.getIncludingTrashed(inside)).toBeNull();
    expect(await ctx.storage.items.getIncludingTrashed(outside)).not.toBeNull();
  });

  it("refuses expected_ids on any action but purge", async () => {
    const tag = `expected-transition-${Math.random().toString(36).slice(2, 8)}`;
    const id = await createNote([tag]);
    const { initialStatus, errorResponse } = await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
        expected_ids: [id],
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(400);
    expect(errorResponse?.error.code).toBe("validation_error");
    const row = await ctx.storage.items.get(id);
    expect(row?.state).toBe("active");
  });
});
