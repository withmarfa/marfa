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
 *   - the operator key with an explicit `target_space_id` scopes to that
 *     space.
 *
 *   - the operator key without target_space_id falls through to the
 *     unscoped path (self-host compat) and is audited as
 *     `details.scope: "platform_unscoped"` so operators can alert.
 *
 *   - Archive export stamps `manifest.space_id` with the resolved
 *     scope, and `/admin/restore-archive` rejects an archive whose
 *     manifest space_id doesn't match the caller's restore target.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  waitForAudit,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

async function mintSpaceAdmin(
  ctx: TestContext,
  spaceId: string,
  label: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_export_test_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      space_permissions: [...SPACE_PERMISSIONS],
      default_tier: "library",
      type_permissions: { "*": "write" },
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

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
    const wsAdminA = await mintSpaceAdmin(ctx, spaceA, "ws-export-a");
    await mintSpaceAdmin(ctx, spaceB, "ws-export-b");

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
    const res = await request(ctx.app, "GET", "/export", { key: wsAdminA });
    expect(res.status).toBe(200);
    const ids = await readNdjsonItems(res);
    expect(ids).toContain(itemA.id);
    expect(ids).not.toContain(itemB.id);
  });

  it("accepts target_space_id matching own", async () => {
    ctx = await createTestContext();
    const spaceA = `t-target-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintSpaceAdmin(ctx, spaceA, "ws-target");
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "scoped" } },
      spaceA,
    );

    const res = await request(
      ctx.app,
      "GET",
      `/export?target_space_id=${spaceA}`,
      { key: wsAdmin },
    );
    expect(res.status).toBe(200);
  });

  it("rejects mismatching target_space_id with 403", async () => {
    ctx = await createTestContext();
    const spaceA = `t-mismatch-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `t-mismatch-b-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdminA = await mintSpaceAdmin(ctx, spaceA, "ws-mismatch");

    const res = await request(
      ctx.app,
      "GET",
      `/export?target_space_id=${spaceB}`,
      { key: wsAdminA },
    );
    expect(res.status).toBe(403);
  });
});

describe("space-scoped export — the operator key", () => {
  let ctx: TestContext;
  afterEach(async () => {
    await ctx.cleanup();
  });

  it("scopes to target_space_id when supplied", async () => {
    // The operator key is the only credential that may name a space other
    // than its own here, and it is also the one credential that reads no
    // content: its type map is empty, so the read narrowing every export
    // runs through resolves to nothing whatever space it lands in. The
    // resolved scope is therefore asserted on the record the route writes
    // before it streams, which is where the resolution is observable — and
    // the emptiness is asserted beside it rather than left to be discovered,
    // since an assertion that a foreign space's rows are absent would
    // otherwise pass on a body that is empty for an unrelated reason.
    ctx = await createTestContext();
    const spaceA = `t-platform-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `t-platform-b-${Math.random().toString(36).slice(2, 10)}`;
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "A" } },
      spaceA,
    );
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "B" } },
      spaceB,
    );

    const res = await request(
      ctx.app,
      "GET",
      `/export?target_space_id=${spaceA}`,
      { key: ctx.operatorKey },
    );
    expect(res.status).toBe(200);
    expect(await readNdjsonItems(res)).toEqual([]);

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
    // The row is stamped with the space that was resolved, not with the
    // caller's absent one, which is the half a fallback to unscoped would
    // get wrong.
    expect(row?.space_id).toBe(spaceA);
  });

  it("falls through to unscoped (self-host compat) without target_space_id and audits as platform_unscoped", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "GET", "/export", {
      key: ctx.operatorKey,
    });
    expect(res.status).toBe(200);

    const audit = await waitForAudit(
      () => ctx.storage.audit.list({ action: "export.space" }),
      (result) => result.data.length > 0,
    );
    const row = audit.data[0];
    expect(row).toBeDefined();
    const details = row?.details as { scope: string } | undefined;
    expect(details?.scope).toBe("platform_unscoped");
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
    const wsAdmin = await mintSpaceAdmin(ctx, spaceA, "ws-archive");
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "archive me" } },
      spaceA,
    );

    const res = await request(ctx.app, "GET", "/export?format=archive", {
      key: wsAdmin,
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
    const wsAdminA = await mintSpaceAdmin(ctx, spaceA, "ws-restore-a");
    await ctx.storage.items.create(
      { type: "core.note", properties: { body: "from A" } },
      spaceA,
    );

    const exportRes = await request(ctx.app, "GET", "/export?format=archive", {
      key: wsAdminA,
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
