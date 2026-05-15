/**
 * T-130 phase 2 — server-side `extensions['sync-agent']` →
 * `extensions['sync']` migration tests.
 *
 * Covers: happy-path migrate, dry-run leaves data alone, idempotency
 * (re-run = zero migrated), collision detection (both namespaces
 * present — left for the agent's dual-read merge), no-legacy items
 * counted as skipped, multi-tenant cross-tenant scope, page-size paging.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { migrateSyncExtensionNamespace } from "./migrate-sync-extension-namespace.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.cleanup();
});

interface SeedOpts {
  legacy?: Record<string, unknown>;
  current?: Record<string, unknown>;
  tenantId?: string;
}

async function seedNote(opts: SeedOpts = {}): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "core.note",
      properties: {
        title: `seed-${Math.random().toString(36).slice(2, 8)}`,
        body: "test seed body",
      },
      source: "test/migrate-sync-ns",
    },
    opts.tenantId,
  );
  if (opts.legacy) {
    await ctx.storage.metadata.setExtension(item.id, "sync-agent", opts.legacy);
  }
  if (opts.current) {
    await ctx.storage.metadata.setExtension(item.id, "sync", opts.current);
  }
  return item.id;
}

describe("migrateSyncExtensionNamespace — T-130 phase 2", () => {
  it("copies legacy namespace to current namespace and clears legacy on a fresh item", async () => {
    const id = await seedNote({
      legacy: { tier: "library", inserted_at: "2026-04-01T00:00:00Z" },
    });

    const report = await migrateSyncExtensionNamespace(ctx.storage, {
      log: () => undefined,
    });

    expect(report.scanned).toBe(1);
    expect(report.migrated).toBe(1);
    expect(report.collisions).toBe(0);
    expect(report.failed).toBe(0);

    const ext = await ctx.storage.metadata.getExtensions(id);
    expect(ext.sync).toEqual({
      tier: "library",
      inserted_at: "2026-04-01T00:00:00Z",
    });
    expect(ext["sync-agent"]).toBeUndefined();
  });

  it("dry-run leaves the database untouched and reports the same counts as a live run", async () => {
    const id = await seedNote({ legacy: { tier: "library", a: 1 } });

    const dryReport = await migrateSyncExtensionNamespace(ctx.storage, {
      dryRun: true,
      log: () => undefined,
    });
    expect(dryReport.migrated).toBe(1);

    // Database is untouched — legacy still present, no `sync` key.
    const ext = await ctx.storage.metadata.getExtensions(id);
    expect(ext["sync-agent"]).toEqual({ tier: "library", a: 1 });
    expect(ext.sync).toBeUndefined();

    // Live run now produces the same migrated count.
    const liveReport = await migrateSyncExtensionNamespace(ctx.storage, {
      log: () => undefined,
    });
    expect(liveReport.migrated).toBe(1);
    expect(liveReport.collisions).toBe(0);
  });

  it("is idempotent — second run over a migrated DB reports zero migrations", async () => {
    await seedNote({ legacy: { foo: "bar" } });
    await seedNote({ legacy: { baz: 42 } });

    const first = await migrateSyncExtensionNamespace(ctx.storage, {
      log: () => undefined,
    });
    expect(first.migrated).toBe(2);

    const second = await migrateSyncExtensionNamespace(ctx.storage, {
      log: () => undefined,
    });
    expect(second.migrated).toBe(0);
    expect(second.collisions).toBe(0);
    expect(second.skipped_no_legacy).toBeGreaterThanOrEqual(2);
  });

  it("leaves both namespaces in place on collision (agent dual-read merges them)", async () => {
    const id = await seedNote({
      legacy: { tier: "feed", legacyOnly: "L" },
      current: { tier: "library", newOnly: "N" },
    });

    const warnings: string[] = [];
    const report = await migrateSyncExtensionNamespace(ctx.storage, {
      log: (level, msg) => {
        if (level === "warn") warnings.push(msg);
      },
    });

    expect(report.collisions).toBe(1);
    expect(report.migrated).toBe(0);
    expect(warnings.some((w: string) => w.includes(id))).toBe(true);

    // Both namespaces survive — sync wins per-key on the agent's
    // dual-read merge, and legacyOnly is still reachable.
    const ext = await ctx.storage.metadata.getExtensions(id);
    expect(ext["sync-agent"]).toEqual({ tier: "feed", legacyOnly: "L" });
    expect(ext.sync).toEqual({ tier: "library", newOnly: "N" });
  });

  it("counts items without the legacy namespace as skipped_no_legacy", async () => {
    await seedNote(); // no extensions at all
    await seedNote({ current: { only: "newer-write" } });
    await seedNote({ legacy: { migrate: "me" } });

    const report = await migrateSyncExtensionNamespace(ctx.storage, {
      log: () => undefined,
    });

    expect(report.scanned).toBe(3);
    expect(report.migrated).toBe(1);
    expect(report.skipped_no_legacy).toBe(2);
  });

  it("crosses tenants — every tenant's items are scanned", async () => {
    if (!ctx.storage.tenants) return; // self-host test path
    const tenantA = await ctx.storage.tenants.create("ns-migrate-a");
    const tenantB = await ctx.storage.tenants.create("ns-migrate-b");

    await seedNote({ legacy: { from: "a" }, tenantId: tenantA.id });
    await seedNote({ legacy: { from: "b" }, tenantId: tenantB.id });
    await seedNote({ legacy: { from: "no-tenant" } });

    const report = await migrateSyncExtensionNamespace(ctx.storage, {
      log: () => undefined,
    });

    expect(report.migrated).toBe(3);
  });

  it("paginates correctly when item count exceeds page size", async () => {
    for (let i = 0; i < 7; i++) {
      await seedNote({ legacy: { i } });
    }

    const report = await migrateSyncExtensionNamespace(ctx.storage, {
      pageSize: 3,
      log: () => undefined,
    });

    expect(report.scanned).toBe(7);
    expect(report.migrated).toBe(7);
  });

  it("emits start/done log lines", async () => {
    await seedNote({ legacy: { v: 1 } });
    const log = vi.fn();
    await migrateSyncExtensionNamespace(ctx.storage, { log });

    const calls = log.mock.calls.map((c) => c[1] as string);
    expect(calls.some((m) => m.includes("starting"))).toBe(true);
    expect(calls.some((m) => /done.*scanned=1.*migrated=1/.test(m))).toBe(true);
  });

  it("surfaces dry-run in start + done log lines", async () => {
    await seedNote({ legacy: { v: 1 } });
    const log = vi.fn();
    await migrateSyncExtensionNamespace(ctx.storage, { dryRun: true, log });

    const calls = log.mock.calls.map((c) => c[1] as string);
    expect(calls.some((m) => m.includes("DRY RUN"))).toBe(true);
  });
});
