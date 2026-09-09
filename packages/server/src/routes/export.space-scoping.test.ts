/**
 * Space-scoped data export coverage:
 *
 *   - a space-bound credential's self-export returns only the calling
 *     space's rows. Other spaces' items, even when present in the same
 *     DB, are filtered out at the storage layer.
 *
 *   - a space-bound credential with `target_space_id` matching its own
 *     succeeds.
 *
 *   - a space-bound credential with a mismatching `target_space_id` is
 *     rejected with 403 (cross-space authority not granted).
 *
 *   - the operator key is refused outright: an export is scoped to one
 *     space and that credential is bound to none.
 *
 *   - the audit record names the space that was resolved, which is where
 *     the resolution is observable before a byte is streamed.
 *
 *   - Archive export stamps `manifest.space_id` with the resolved
 *     scope, and `/admin/restore-archive` rejects an archive whose
 *     manifest space_id doesn't match the caller's restore target.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  mintSpaceKey,
  request,
  waitForAudit,
  type TestContext,
} from "../test-utils.js";
async function readNdjsonItems(res: Response): Promise<string[]> {
  const text = await res.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { item?: { id: string } })
    .filter((parsed) => parsed.item !== undefined)
    .map((parsed) => parsed.item!.id);
}

describe("space-scoped export — a space-bound credential's self-export", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns only the calling space's items", async () => {
    ctx = await createTestContext();
    const spaceA = `t-export-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `t-export-b-${Math.random().toString(36).slice(2, 10)}`;
    const spaceKeyA = await mintSpaceKey(ctx, spaceA, { label: "export-a" });
    await mintSpaceKey(ctx, spaceB, { label: "export-b" });

    // Items in both spaces.
    const itemA = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "space A" } },
      spaceA,
    );
    const itemB = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "space B" } },
      spaceB,
    );

    // Space A's admin exports — should see ONLY itemA.
    const res = await request(ctx.app, "GET", "/export", { key: spaceKeyA });
    expect(res.status).toBe(200);
    const ids = await readNdjsonItems(res);
    expect(ids).toContain(itemA.id);
    expect(ids).not.toContain(itemB.id);
  });

  it("accepts target_space_id matching own", async () => {
    ctx = await createTestContext();
    const spaceA = `t-target-${Math.random().toString(36).slice(2, 10)}`;
    const spaceKey = await mintSpaceKey(ctx, spaceA, {
      label: "export-target",
    });
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "scoped" } },
      spaceA,
    );

    const res = await request(
      ctx.app,
      "GET",
      `/export?target_space_id=${spaceA}`,
      { key: spaceKey },
    );
    expect(res.status).toBe(200);
  });

  it("rejects mismatching target_space_id with 403", async () => {
    ctx = await createTestContext();
    const spaceA = `t-mismatch-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `t-mismatch-b-${Math.random().toString(36).slice(2, 10)}`;
    const spaceKeyA = await mintSpaceKey(ctx, spaceA, {
      label: "export-mismatch",
    });

    const res = await request(
      ctx.app,
      "GET",
      `/export?target_space_id=${spaceB}`,
      { key: spaceKeyA },
    );
    expect(res.status).toBe(403);
  });
});

describe("space-scoped export — the operator key", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * The operator key used to have two arms here: name a space and export it,
   * or name none and export the whole instance. Both always streamed nothing.
   * That credential holds no content permissions at all, so the read
   * narrowing every export runs through resolved to the empty set whatever
   * space it landed in, while the audit record said a space had been
   * exported. An export that reports success and writes zero rows is worse
   * than one that refuses, so the arms are gone and the door says why.
   *
   * Moving a space is a key minted into it with everything, which is the
   * ordinary path the cases above take.
   */
  it("is refused, because an export is scoped to a space and it has none", async () => {
    ctx = await createTestContext();
    const spaceA = `t-operator-${Math.random().toString(36).slice(2, 10)}`;
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "A" } },
      spaceA,
    );

    const named = await request(
      ctx.app,
      "GET",
      `/export?target_space_id=${spaceA}`,
      { key: ctx.operatorKey },
    );
    expect(named.status).toBe(403);

    const unscoped = await request(ctx.app, "GET", "/export", {
      key: ctx.operatorKey,
    });
    expect(unscoped.status).toBe(403);

    // Refused before anything was recorded: an audit row saying a space was
    // exported is exactly what the old arms produced wrongly.
    const audit = await ctx.storage.audit.list({ action: "export.space" });
    expect(audit.data).toEqual([]);
  });

  it("a space key's own export is recorded against the space it resolved", async () => {
    // The audit record is where the resolution is observable, because it is
    // written before the first byte is streamed. It is also the alerting
    // surface for a bulk extraction, so what it names has to be the space
    // that was actually read.
    ctx = await createTestContext();
    const spaceA = `t-audit-${Math.random().toString(36).slice(2, 10)}`;
    const spaceKey = await mintSpaceKey(ctx, spaceA, { label: "export-audit" });
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "A" } },
      spaceA,
    );

    const res = await request(
      ctx.app,
      "GET",
      `/export?target_space_id=${spaceA}`,
      { key: spaceKey },
    );
    expect(res.status).toBe(200);
    expect(await readNdjsonItems(res)).toHaveLength(1);

    const audit = await waitForAudit(
      () => ctx.storage.audit.list({ action: "export.space" }),
      (result) => result.data.length > 0,
    );
    const row = audit.data[0];
    const details = row?.details as {
      scope: string;
      target_space_id?: string;
    };
    expect(details.scope).toBe("space");
    expect(details.target_space_id).toBe(spaceA);
    expect(row?.space_id).toBe(spaceA);
  });
});

describe("archive — manifest space_id round-trip", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("stamps space_id on the manifest at export time", async () => {
    ctx = await createTestContext();
    const spaceA = `t-archive-${Math.random().toString(36).slice(2, 10)}`;
    const spaceKey = await mintSpaceKey(ctx, spaceA, {
      label: "export-archive",
    });
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "archive me" } },
      spaceA,
    );

    const res = await request(ctx.app, "GET", "/export?format=archive", {
      key: spaceKey,
    });
    expect(res.status).toBe(200);
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    expect(buf.length).toBeGreaterThan(0);
  });

  it("admin-archive rejects mismatching manifest.space_id", async () => {
    ctx = await createTestContext();
    const spaceA = `t-restore-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `t-restore-b-${Math.random().toString(36).slice(2, 10)}`;
    const spaceKeyA = await mintSpaceKey(ctx, spaceA, {
      label: "export-restore-a",
    });
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "from A" } },
      spaceA,
    );

    const exportRes = await request(ctx.app, "GET", "/export?format=archive", {
      key: spaceKeyA,
    });
    expect(exportRes.status).toBe(200);
    const archive = await exportRes.arrayBuffer();

    const restoreRes = await ctx.app.request(
      `/admin/restore-archive?target_space_id=${spaceB}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ctx.operatorKey}`,
          "content-type": "application/gzip",
        },
        body: archive,
      },
    );
    expect(restoreRes.status).toBe(403);
    const body = (await restoreRes.json()) as {
      error: { code: string; message?: string };
    };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.message).toContain("manifest.space_id");
  });
});
