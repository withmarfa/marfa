/**
 * A bulk purge takes only rows that are in the trash when the job purges
 * them, as the single purge does. A row the filter matched that is not, an
 * active match or a row restored after the job was queued, is left
 * untouched and reported per row with the code the single door answers.
 */
import { itemWrites } from "../storage/item-writes.js";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { BulkActionWorker, runChunk } from "../bulk-actions/index.js";
import type { BulkActionJob } from "../bulk-actions/types.js";
import { resolveLiveCredential } from "../auth/live-credential.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createNote(tag: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "row" }, tags: [tag] },
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

describe("a bulk purge takes only trashed rows", () => {
  it("leaves an active match untouched and reports it invalid_transition", async () => {
    const tag = `purge-active-${Math.random().toString(36).slice(2, 8)}`;
    const trashed = await createNote(tag);
    await trash(trashed);
    const active = await createNote(tag);

    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      { action: "purge", confirm: "PURGE", filter: { tags: [tag] } },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);
    // The default filter state is active, so the active row is the match.
    expect(result?.matched).toBe(1);
    expect(result?.succeeded).toBe(0);
    expect(result?.errored).toBe(1);
    expect(result?.errors).toEqual([
      expect.objectContaining({ id: active, code: "invalid_transition" }),
    ]);
    const row = await ctx.storage.items.get(active);
    expect(row?.state).toBe("active");
    expect(await ctx.storage.items.getIncludingTrashed(trashed)).not.toBeNull();
  });

  it("purges every trashed match", async () => {
    const tag = `purge-trashed-${Math.random().toString(36).slice(2, 8)}`;
    const ids = [await createNote(tag), await createNote(tag)];
    for (const id of ids) await trash(id);

    const { result } = await runBulkActionAsync(
      ctx,
      {
        action: "purge",
        confirm: "PURGE",
        filter: { tags: [tag], state: "trashed" },
      },
      ctx.workingKey,
    );
    expect(result?.succeeded).toBe(2);
    expect(result?.errored).toBe(0);
    for (const id of ids) {
      expect(await ctx.storage.items.getIncludingTrashed(id)).toBeNull();
    }
  });

  it("does not purge a row restored after the job was queued", async () => {
    const tag = `purge-restored-${Math.random().toString(36).slice(2, 8)}`;
    const kept = await createNote(tag);
    const gone = await createNote(tag);
    await trash(kept);
    await trash(gone);

    const queued = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      body: {
        action: "purge",
        confirm: "PURGE",
        filter: { tags: [tag], state: "trashed" },
      },
    });
    expect(queued.status).toBe(202);
    const job = (await queued.json()) as BulkActionJob;
    expect(job.matched).toBe(2);

    const restored = await request(ctx.app, "POST", `/items/${kept}/restore`, {
      key: ctx.workingKey,
    });
    expect(restored.status).toBe(200);

    const worker = new BulkActionWorker({
      storage: ctx.storage,
      chunkSize: 100,
      pollIntervalMs: 1,
    });
    while (await worker.runOnce()) {
      /* keep draining */
    }
    const final = await request(
      ctx.app,
      "GET",
      `/items/bulk-actions/jobs/${job.id}`,
      { key: ctx.workingKey },
    );
    const done = (await final.json()) as BulkActionJob;
    expect(done.status).toBe("completed");
    expect(done.result?.succeeded).toBe(1);
    expect(done.result?.errors).toEqual([
      expect.objectContaining({ id: kept, code: "invalid_transition" }),
    ]);
    const row = await ctx.storage.items.get(kept);
    expect(row?.state).toBe("active");
    expect(await ctx.storage.items.getIncludingTrashed(gone)).toBeNull();
  });

  it("judges a type with its own soft-deleted state by that state", async () => {
    // A `system.*` row ends `revoked`, not `trashed`. The bulk door's
    // match leaves `system.*` rows out (`exclude_system_types`) unless the
    // operator key names them, so no job a working credential queues
    // reaches one; the chunk is run directly.
    async function connection(): Promise<string> {
      const item = await itemWrites(ctx.storage).create({
        type: "system.connection",
        properties: {
          kind: "app",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      });
      return item.id;
    }
    const revoked = await connection();
    await itemWrites(ctx.storage).delete(revoked);
    const active = await connection();
    expect((await ctx.storage.items.get(revoked))?.state).toBe("revoked");

    const current = await request(ctx.app, "GET", "/keys/current", {
      key: ctx.workingKey,
    });
    const credential = await resolveLiveCredential(
      ctx.storage,
      ((await current.json()) as { id: string }).id,
      { tokenOutlivesExpiry: true },
    );
    if (!credential) throw new Error("the working key does not resolve");
    const result = await runChunk({
      storage: ctx.storage,
      input: { action: "purge", confirm: "PURGE" },
      ids: [revoked, active],
      credential,
    });
    expect(result.succeeded).toEqual([revoked]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: active,
        code: "invalid_transition",
        message: "Only revoked items can be purged",
      }),
    ]);
    expect(await ctx.storage.items.getIncludingTrashed(revoked)).toBeNull();
    expect((await ctx.storage.items.get(active))?.state).toBe("active");
  });
});
