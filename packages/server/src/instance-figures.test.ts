import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
    expect(p.rss_peak_bytes ?? 0).toBeGreaterThanOrEqual(
      (p.rss_bytes ?? 0) * 0.5,
    );
    expect(p.heap_used_bytes ?? 0).toBeLessThanOrEqual(p.heap_total_bytes ?? 0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("storage figures", () => {
  it("sizes the files and takes a missing log as zero", async () => {
    const dbPath = join(ctx.tmpDir, "test.db");
    rmSync(`${dbPath}-wal`, { force: true });
    const keeper = figuresFor({ ...ctx.storage }, dbPath, "v1");
    const before = await keeper.files();
    expect(before.database_bytes).toBeGreaterThan(0);
    expect(before.wal_bytes).toBeGreaterThanOrEqual(0);
    // A witness that the log size is read when the file exists.
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(4096));
    expect((await keeper.files()).wal_bytes).toBe(4096);
    rmSync(`${dbPath}-wal`, { force: true });
    expect((await keeper.files()).wal_bytes).toBe(0);
  });

  it("counts the rows each table holds, which grow as items are written and changed", async () => {
    const keeper = figuresFor(
      { ...ctx.storage },
      join(ctx.tmpDir, "test.db"),
      "v1",
    );
    const before = await keeper.count();
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
    const after = await keeper.count();
    expect(after.items).toBe((before.items ?? 0) + 1);
    expect(after.versions).toBeGreaterThan(before.versions ?? 0);
    expect(after.audit_log).toBeGreaterThanOrEqual(before.audit_log ?? 0);
    expect(keeper.last()).toBe(after);
  });

  it("leaves out a file it cannot find and a count that fails, keeping the rest", async () => {
    const failing = {
      ...ctx.storage,
      versions: { count: () => Promise.reject(new Error("boom")) },
    } as unknown as typeof ctx.storage;
    const keeper = figuresFor(failing, join(ctx.tmpDir, "absent.db"), "v1");
    const counts = await keeper.count();
    expect((await keeper.files()).database_bytes).toBeNull();
    expect(counts.versions).toBeNull();
    expect(typeof counts.event_log).toBe("number");
  });

  it("counts blobs and the files fresh for the report", async () => {
    const keeper = figuresFor(
      { ...ctx.storage },
      join(ctx.tmpDir, "test.db"),
      "v1",
    );
    const figures = await keeper.reportFigures();
    const { process: own } = figures;
    expect(own.release).toBe("v1");
    expect(typeof figures.blobs?.count).toBe("number");
    expect(figures.files.database_bytes).toBeGreaterThan(0);
    expect(figures.counts.counted_at).toBe(keeper.last()?.counted_at);
  });
});

describe("counting off the request path", () => {
  function freshKeeper() {
    return figuresFor({ ...ctx.storage }, join(ctx.tmpDir, "test.db"), "v1");
  }

  it("has no count and counts nothing until something asks", async () => {
    const spy = vi.spyOn(ctx.storage.versions, "count");
    const keeper = freshKeeper();
    expect(keeper.last()).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).not.toHaveBeenCalled();
  });

  it("starts the first count without waiting for it, and only one at a time", async () => {
    let release!: () => void;
    const held = new Promise<number>((resolve) => {
      release = () => {
        resolve(7);
      };
    });
    const spy = vi.spyOn(ctx.storage.versions, "count").mockReturnValue(held);
    const keeper = freshKeeper();
    keeper.refreshInBackground();
    keeper.refreshInBackground();
    keeper.refreshInBackground();
    // Returned while the count is still held, so nothing waited for it.
    expect(keeper.last()).toBeUndefined();
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    release();
    await vi.waitFor(() => {
      expect(keeper.last()?.versions).toBe(7);
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("recounts after an hour and not before, and sets no timer", async () => {
    let now = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timers = vi.spyOn(globalThis, "setInterval");
    const spy = vi.spyOn(ctx.storage.versions, "count");
    const keeper = freshKeeper();
    await keeper.count();
    spy.mockClear();
    now += 59 * 60 * 1000;
    keeper.refreshInBackground();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).not.toHaveBeenCalled();
    now += 2 * 60 * 1000;
    keeper.refreshInBackground();
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(timers).not.toHaveBeenCalled();
  });

  it("does not keep a count that read nothing as current, and retries after a minute", async () => {
    let now = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const fail = () => Promise.reject(new Error("busy"));
    const failing = {
      ...ctx.storage,
      items: { ...ctx.storage.items, stats: fail },
      versions: { count: fail },
      eventLog: { count: fail },
      audit: { count: fail },
    } as unknown as typeof ctx.storage;
    const spy = vi.spyOn(failing.versions, "count");
    const keeper = figuresFor(failing, join(ctx.tmpDir, "retry.db"), "v1");
    keeper.refreshInBackground();
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(keeper.last()).toBeUndefined();
    now += 30 * 1000;
    keeper.refreshInBackground();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).toHaveBeenCalledTimes(1);
    now += 31 * 1000;
    keeper.refreshInBackground();
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
