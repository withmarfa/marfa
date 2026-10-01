import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { BulkActionWorker } from "../bulk-actions/index.js";
import type { BulkActionJob, BulkActionResult } from "../bulk-actions/types.js";

/**
 * A bulk-action job acts on what the credential that queued it holds when
 * each chunk runs, not on what it held when the job was queued.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function marker(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function mintKey(
  tag: string,
  body: Record<string, unknown>,
): Promise<{ id: string; key: string }> {
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: {
      label: tag,
      source: tag,
      default_tier: "feed",
      extension_permissions: {},
      edge_permissions: {},
      ...body,
    },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string };
}

async function seed(
  tag: string,
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type, properties, tags: [tag] },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function queue(key: string, body: Record<string, unknown>) {
  const res = await request(ctx.app, "POST", "/items/bulk-actions", {
    key,
    body,
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as BulkActionJob).id;
}

/** Raw SQL against the test database, for states no door writes. */
async function sql(statement: string, params: unknown[]): Promise<void> {
  const run = (
    ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun;
  await run(statement, params);
}

/** Drain the queue, then read the job as stored. */
async function runQueued(
  jobId: string,
  chunkSize = 100,
): Promise<{
  status: string;
  error: string | null;
  result: BulkActionResult | null;
}> {
  const worker = new BulkActionWorker({
    storage: ctx.storage,
    chunkSize,
    pollIntervalMs: 1,
  });
  while (await worker.runOnce()) {
    /* drain */
  }
  const row = await ctx.storage.bulkActionJobs.getById(jobId);
  expect(row).not.toBeNull();
  return {
    status: row!.status,
    error: row!.error,
    result: row!.result ? (JSON.parse(row!.result) as BulkActionResult) : null,
  };
}

async function tierOf(id: string): Promise<string | null> {
  const res = await request(ctx.app, "GET", `/items/${id}`, {
    key: ctx.workingKey,
  });
  if (res.status !== 200) return null;
  return ((await res.json()) as { item: { tier: string } }).item.tier;
}

describe("a bulk-action job asks after its credential when it runs", () => {
  it("runs for a key that still stands", async () => {
    // The witness for the cases below: the same job, unrevoked, writes.
    const tag = marker("bacred-ok");
    const note = await seed(tag, "core.note", { body: "n" });
    const { key } = await mintKey(tag, {
      type_permissions: { "core.note": "write" },
    });
    const job = await queue(key, {
      action: "update_tier",
      tier: "library",
      filter: { tags: [tag] },
    });
    const done = await runQueued(job);
    expect(done.status).toBe("completed");
    expect(done.result?.succeeded).toBe(1);
    expect(await tierOf(note)).toBe("library");
  });

  it("writes nothing once the key that queued it is revoked", async () => {
    const tag = marker("bacred-revoked");
    const note = await seed(tag, "core.note", { body: "n" });
    const { id, key } = await mintKey(tag, {
      type_permissions: { "core.note": "write" },
    });
    const before = await tierOf(note);
    const job = await queue(key, {
      action: "update_tier",
      tier: before === "library" ? "feed" : "library",
      filter: { tags: [tag] },
    });
    const revoked = await request(ctx.app, "DELETE", `/keys/${id}`, {
      key: ctx.workingKey,
    });
    expect(revoked.status).toBeLessThan(300);

    const done = await runQueued(job);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/no longer/i);
    expect(await tierOf(note)).toBe(before);
  });

  it("asks before every chunk, and keeps what earlier chunks wrote", async () => {
    const tag = marker("bacred-chunks");
    const notes = [
      await seed(tag, "core.note", { body: "a" }),
      await seed(tag, "core.note", { body: "b" }),
    ];
    const { id, key } = await mintKey(tag, {
      type_permissions: { "core.note": "write" },
    });
    const before = await tierOf(notes[0]!);
    const target = before === "library" ? "feed" : "library";
    const job = await queue(key, {
      action: "update_tier",
      tier: target,
      filter: { tags: [tag] },
    });

    // The key is revoked once the first chunk has run, so only a worker
    // that asks again before the second chunk stops.
    const jobs = ctx.storage.bulkActionJobs;
    const updateProgress = jobs.updateProgress.bind(jobs);
    jobs.updateProgress = async (jobId, progress, heartbeatAt) => {
      await updateProgress(jobId, progress, heartbeatAt);
      jobs.updateProgress = updateProgress;
      const revoked = await request(ctx.app, "DELETE", `/keys/${id}`, {
        key: ctx.workingKey,
      });
      expect(revoked.status).toBeLessThan(300);
    };
    let done: Awaited<ReturnType<typeof runQueued>>;
    try {
      done = await runQueued(job, 1);
    } finally {
      jobs.updateProgress = updateProgress;
    }

    expect(done.status).toBe("failed");
    const tiers = [await tierOf(notes[0]!), await tierOf(notes[1]!)];
    expect(tiers.filter((t) => t === target)).toHaveLength(1);
    const written = notes[tiers.indexOf(target)];
    expect(done.result?.succeeded).toBe(1);
    expect(done.result?.ids).toEqual([written]);
  });

  it("writes nothing once the key that queued it is past its expiry", async () => {
    const tag = marker("bacred-expired");
    const note = await seed(tag, "core.note", { body: "n" });
    const { id, key } = await mintKey(tag, {
      type_permissions: { "core.note": "write" },
    });
    const before = await tierOf(note);
    const job = await queue(key, {
      action: "update_tier",
      tier: before === "library" ? "feed" : "library",
      filter: { tags: [tag] },
    });
    await sql("UPDATE api_keys SET expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      id,
    ]);

    const done = await runQueued(job);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/no longer/i);
    expect(await tierOf(note)).toBe(before);
  });

  it("writes nothing once the key that queued it is deleted", async () => {
    const tag = marker("bacred-deleted");
    const note = await seed(tag, "core.note", { body: "n" });
    const { id, key } = await mintKey(tag, {
      type_permissions: { "core.note": "write" },
    });
    const before = await tierOf(note);
    const job = await queue(key, {
      action: "update_tier",
      tier: before === "library" ? "feed" : "library",
      filter: { tags: [tag] },
    });
    await sql("DELETE FROM api_keys WHERE id = ?", [id]);

    const done = await runQueued(job);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/no longer/i);
    expect(await tierOf(note)).toBe(before);
  });

  it("refuses the rows of a type the key may no longer write, and writes the rest", async () => {
    const tag = marker("bacred-narrowed");
    const note = await seed(tag, "core.note", { body: "n" });
    const bookmark = await seed(tag, "core.bookmark", {
      url: "https://example.com/narrowed",
    });
    const { id, key } = await mintKey(tag, {
      type_permissions: { "core.note": "write", "core.bookmark": "write" },
    });
    const noteBefore = await tierOf(note);
    const target = noteBefore === "library" ? "feed" : "library";
    const job = await queue(key, {
      action: "update_tier",
      tier: target,
      filter: { tags: [tag] },
    });
    const narrowed = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.workingKey,
      body: {
        type_permissions: { "core.note": "read", "core.bookmark": "write" },
      },
    });
    expect(narrowed.status).toBe(200);

    const done = await runQueued(job);
    expect(done.status).toBe("completed");
    expect(done.result?.succeeded).toBe(1);
    expect(done.result?.errors).toEqual([
      expect.objectContaining({ id: note, code: "type_not_permitted" }),
    ]);
    expect(await tierOf(note)).toBe(noteBefore);
    expect(await tierOf(bookmark)).toBe(target);
  });

  it("answers a row of a type the key may no longer read as not found, without naming the type", async () => {
    const tag = marker("bacred-unreadable");
    const note = await seed(tag, "core.note", { body: "n" });
    const bookmark = await seed(tag, "core.bookmark", {
      url: "https://example.com/unreadable",
    });
    const { id, key } = await mintKey(tag, {
      type_permissions: { "core.note": "write", "core.bookmark": "write" },
    });
    const noteBefore = await tierOf(note);
    const target = noteBefore === "library" ? "feed" : "library";
    const job = await queue(key, {
      action: "update_tier",
      tier: target,
      filter: { tags: [tag] },
    });
    const narrowed = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.workingKey,
      body: { type_permissions: { "core.bookmark": "write" } },
    });
    expect(narrowed.status).toBe(200);

    const done = await runQueued(job);
    expect(done.status).toBe("completed");
    expect(done.result?.succeeded).toBe(1);
    expect(done.result?.errors).toEqual([
      { id: note, code: "item_not_found", message: "Item not found" },
    ]);
    expect(await tierOf(note)).toBe(noteBefore);
    expect(await tierOf(bookmark)).toBe(target);
  });

  it("purges nothing once the key no longer holds items.purge", async () => {
    const tag = marker("bacred-purge");
    const note = await seed(tag, "core.note", { body: "n" });
    const trashed = await request(ctx.app, "DELETE", `/items/${note}`, {
      key: ctx.workingKey,
    });
    expect(trashed.status).toBeLessThan(300);
    const { id, key } = await mintKey(tag, {
      permissions: ["items.purge"],
      type_permissions: { "core.note": "write" },
    });
    const job = await queue(key, {
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag], state: "trashed" },
    });
    const narrowed = await request(ctx.app, "PATCH", `/keys/${id}`, {
      key: ctx.workingKey,
      body: { permissions: [] },
    });
    expect(narrowed.status).toBe(200);

    const done = await runQueued(job);
    expect(done.status).toBe("failed");
    expect(await ctx.storage.items.getIncludingTrashed(note)).not.toBeNull();
  });

  it("writes nothing once the grant behind a sign-in is revoked, and runs while it stands", async () => {
    const standing = await seedOauthBearer(ctx.storage, ["core.note:write"]);
    const tagOk = marker("bacred-oauth-ok");
    const ok = await seed(tagOk, "core.note", { body: "n" });
    const okJob = await queue(standing.token, {
      action: "update_tier",
      tier: "library",
      filter: { tags: [tagOk] },
    });
    const okDone = await runQueued(okJob);
    expect(okDone.status).toBe("completed");
    expect(await tierOf(ok)).toBe("library");

    const revoking = await seedOauthBearer(ctx.storage, ["core.note:write"]);
    const grant = await ctx.storage.items.get(revoking.grantId);
    const authUserId = grant!.properties.user_id as string;
    const tag = marker("bacred-oauth");
    const note = await seed(tag, "core.note", { body: "n" });
    const before = await tierOf(note);
    const job = await queue(revoking.token, {
      action: "update_tier",
      tier: before === "library" ? "feed" : "library",
      filter: { tags: [tag] },
    });
    await ctx.storage.oauthProvider!.revokeTokensForGrant(
      revoking.clientId,
      authUserId,
    );

    const done = await runQueued(job);
    expect(done.status).toBe("failed");
    expect(await tierOf(note)).toBe(before);
  });

  it("runs on once a sign-in's token reaches its ordinary expiry while the grant stands", async () => {
    const signedIn = await seedOauthBearer(ctx.storage, ["core.note:write"]);
    const tag = marker("bacred-oauth-expired");
    const note = await seed(tag, "core.note", { body: "n" });
    const before = await tierOf(note);
    const target = before === "library" ? "feed" : "library";
    const job = await queue(signedIn.token, {
      action: "update_tier",
      tier: target,
      filter: { tags: [tag] },
    });
    const row = await ctx.storage.bulkActionJobs.getById(job);
    await sql(
      "UPDATE auth_oauth_access_token SET expires_at = ? WHERE id = ?",
      [Math.floor((Date.now() - 60_000) / 1000), row!.api_key_id],
    );
    // The token itself no longer authenticates a request.
    const refused = await request(ctx.app, "GET", "/items", {
      key: signedIn.token,
    });
    expect(refused.status).toBe(401);

    const done = await runQueued(job);
    expect(done.status).toBe("completed");
    expect(await tierOf(note)).toBe(target);
  });
});
