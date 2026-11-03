import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_REPORT_DELAY_MS,
  REPORT_INTERVAL_MS,
  REPORT_KEYS,
  reportProperties,
  startDailyReport,
} from "./daily-report.js";
import type {
  FiguresKeeper,
  InstanceFigures,
  StorageFigures,
} from "./instance-figures.js";

function figures(overrides: Partial<StorageFigures> = {}): InstanceFigures {
  return {
    process: {
      release: "v0.0.99",
      rss_bytes: 300_000_000,
      rss_peak_bytes: 400_000_000,
      heap_used_bytes: 50_000_000,
      heap_total_bytes: 80_000_000,
      cpu_user_seconds: 12.5,
      cpu_system_seconds: 3.25,
      uptime_seconds: 600,
    },
    storage: {
      database_bytes: 2_000_000,
      wal_bytes: 0,
      items: 10,
      versions: 20,
      event_log: 30,
      audit_log: 40,
      blobs: 2,
      blob_bytes: 999,
      items_by_state: { active: 10 },
      counted_at: "2026-11-03T10:00:00.000Z",
      ...overrides,
    },
  };
}

describe("reportProperties", () => {
  it("carries exactly the closed list, and no string but the release", () => {
    const out = reportProperties(figures(), { user: 0, system: 0 });
    expect(Object.keys(out).sort()).toEqual([...REPORT_KEYS].sort());
    for (const [key, value] of Object.entries(out)) {
      if (key === "release") expect(value).toBe("v0.0.99");
      else expect(typeof value, key).toBe("number");
    }
  });

  it("reports CPU used since the last report", () => {
    const out = reportProperties(figures(), { user: 10, system: 3 });
    expect(out.cpu_user_seconds).toBeCloseTo(2.5);
    expect(out.cpu_system_seconds).toBeCloseTo(0.25);
  });

  it("leaves out a figure that could not be read and keeps a zero log size", () => {
    const out = reportProperties(
      figures({ database_bytes: null, versions: null }),
      { user: 0, system: 0 },
    );
    expect(out).not.toHaveProperty("database_bytes");
    expect(out).not.toHaveProperty("versions_count");
    expect(out.wal_bytes).toBe(0);
  });

  it("copies nothing the figures carry beyond the list", () => {
    const loaded = figures();
    (loaded.storage as unknown as Record<string, unknown>).path = "/secret";
    (loaded.process as unknown as Record<string, unknown>).hostname = "h";
    const out = reportProperties(loaded, { user: 0, system: 0 });
    expect(Object.keys(out).sort()).toEqual([...REPORT_KEYS].sort());
  });
});

describe("startDailyReport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function keeper(): FiguresKeeper {
    return {
      read: () => Promise.resolve(figures()),
      refresh: () => Promise.resolve(figures().storage),
      start: () => undefined,
      stop: () => undefined,
    };
  }

  it("sends once after the start settles and then every 24 hours", async () => {
    const send = vi.fn(() => Promise.resolve());
    const report = startDailyReport({ keeper: keeper(), send, warn: vi.fn() });
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(
      "marfa server report",
      expect.objectContaining({ release: "v0.0.99" }),
    );
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS - 1000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    report.stop();
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS * 3);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends nothing once stopped before the first report", async () => {
    const send = vi.fn(() => Promise.resolve());
    startDailyReport({ keeper: keeper(), send, warn: vi.fn() }).stop();
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });

  it("contains a failing send, warns once and tries again the next day", async () => {
    const send = vi
      .fn<(event: string, properties: object) => Promise<void>>()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValue(undefined);
    const warn = vi.fn();
    const report = startDailyReport({ keeper: keeper(), send, warn });
    await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    report.stop();
  });

  it("gives up on a send that never answers, and a later report still goes", async () => {
    const send = vi
      .fn<(event: string, properties: object) => Promise<void>>()
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue(undefined);
    const warn = vi.fn();
    const report = startDailyReport({
      keeper: keeper(),
      send,
      warn,
      sendTimeoutMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS + 5000);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    report.stop();
  });

  it("contains a figure read that throws", async () => {
    const send = vi.fn(() => Promise.resolve());
    const warn = vi.fn();
    const broken: FiguresKeeper = {
      ...keeper(),
      refresh: () => Promise.reject(new Error("disk gone")),
    };
    const report = startDailyReport({ keeper: broken, send, warn });
    await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS);
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    report.stop();
  });

  it("holds no timer that keeps the process alive", async () => {
    const timers: { hasRef(): boolean }[] = [];
    const realTimeout = globalThis.setTimeout;
    const realInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = realTimeout(...args);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const timer = realInterval(...args);
      timers.push(timer);
      return timer;
    }) as typeof setInterval);
    const report = startDailyReport({
      keeper: keeper(),
      send: () => Promise.resolve(),
      warn: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS);
    expect(timers.length).toBeGreaterThanOrEqual(2);
    expect(timers.filter((timer) => timer.hasRef())).toHaveLength(0);
    report.stop();
  });
});
