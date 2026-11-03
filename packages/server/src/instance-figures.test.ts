import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestContext, request, type TestContext } from "./test-utils.js";
import { figuresFor, readProcessFigures } from "./instance-figures.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

describe("process figures", () => {
  it("reads memory, CPU and uptime as plain numbers", () => {
    const p = readProcessFigures("v1");
    expect(p.release).toBe("v1");
    for (const key of [
      "rss_bytes",
      "rss_peak_bytes",
      "heap_used_bytes",
      "heap_total_bytes",
      "cpu_user_seconds",
      "cpu_system_seconds",
      "uptime_seconds",
    ] as const) {
      expect(Number.isFinite(p[key]), key).toBe(true);
    }
    expect(p.rss_bytes).toBeGreaterThan(10_000_000);
    expect(p.rss_peak_bytes).toBeGreaterThanOrEqual(p.rss_bytes * 0.5);
    expect(p.heap_used_bytes).toBeLessThanOrEqual(p.heap_total_bytes);
  });
});

describe("storage figures", () => {
  it("counts the tables, sizes the files and takes a missing log as zero", async () => {
    const dbPath = join(ctx.tmpDir, "test.db");
    rmSync(`${dbPath}-wal`, { force: true });
    const keeper = figuresFor({ ...ctx.storage }, dbPath, "v1");
    const { storage: s } = await keeper.read();
    expect(s.database_bytes).toBeGreaterThan(0);
    expect(s.wal_bytes).toBeGreaterThanOrEqual(0);
    // A witness that the log size is read when the file exists.
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(4096));
    const again = await keeper.refresh();
    expect(again.wal_bytes).toBe(4096);
    rmSync(`${dbPath}-wal`, { force: true });
    expect((await keeper.refresh()).wal_bytes).toBe(0);
    for (const key of [
      "items",
      "versions",
      "event_log",
      "audit_log",
    ] as const) {
      expect(typeof s[key], key).toBe("number");
    }
    expect(s.blobs).toBe(0);
  });

  it("counts the rows each table holds, which grow as items are written and changed", async () => {
    const keeper = figuresFor(
      { ...ctx.storage },
      join(ctx.tmpDir, "test.db"),
      "v1",
    );
    const before = await keeper.refresh();
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "one" } },
    });
    const { item } = (await created.json()) as { item: { id: string } };
    const patched = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.workingKey,
      body: { version: 1, properties: { body: "two" } },
    });
    expect(patched.status).toBe(200);
    const after = await keeper.refresh();
    expect(after.items).toBe((before.items ?? 0) + 1);
    expect(after.versions).toBeGreaterThan(before.versions ?? 0);
    expect(after.audit_log).toBeGreaterThanOrEqual(before.audit_log ?? 0);
  });

  it("leaves out a file it cannot find and a count that fails, keeping the rest", async () => {
    const failing = {
      ...ctx.storage,
      versions: { count: () => Promise.reject(new Error("boom")) },
    } as unknown as typeof ctx.storage;
    const keeper = figuresFor(failing, join(ctx.tmpDir, "absent.db"), "v1");
    const { storage: s } = await keeper.read();
    expect(s.database_bytes).toBeNull();
    expect(s.versions).toBeNull();
    expect(typeof s.event_log).toBe("number");
  });

  it("serves the last count without counting again, and counts once for callers together", async () => {
    const spy = vi.spyOn(ctx.storage.versions, "count");
    const keeper = figuresFor(
      { ...ctx.storage },
      join(ctx.tmpDir, "test.db"),
      "v1",
    );
    spy.mockClear();
    await Promise.all([keeper.read(), keeper.read()]);
    await keeper.read();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
