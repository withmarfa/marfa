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
  ReportFigures,
  TableCounts,
} from "./instance-figures.js";

function figures(
  overrides: Partial<TableCounts> = {},
  cpu: { user: number; system: number } = { user: 12.5, system: 3.25 },
): ReportFigures {
  return {
    process: {
      release: "v0.0.99",
      rss_bytes: 300_000_000,
      rss_peak_bytes: 400_000_000,
      heap_used_bytes: 50_000_000,
      heap_total_bytes: 80_000_000,
      cpu_user_seconds: cpu.user,
      cpu_system_seconds: cpu.system,
      uptime_seconds: 600,
    },
    files: { database_bytes: 2_000_000, wal_bytes: 0 },
    counts: {
      items: 10,
      versions: 20,
      event_log: 30,
      audit_log: 40,
      counted_at: "2026-11-03T10:00:00.000Z",
      ...overrides,
    },
    blobs: { count: 2, total_bytes: 999 },
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
      {
        ...figures({ versions: null }),
        files: { database_bytes: null, wal_bytes: 0 },
      },
      { user: 0, system: 0 },
    );
    expect(out).not.toHaveProperty("database_bytes");
    expect(out).not.toHaveProperty("versions_count");
    expect(out.wal_bytes).toBe(0);
  });

  it("copies nothing the figures carry beyond the list", () => {
    const loaded = figures();
    (loaded.files as unknown as Record<string, unknown>).path = "/secret";
    const { process: own } = loaded;
    (own as unknown as Record<string, unknown>).hostname = "h";
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

  const on = () => Promise.resolve(true);

  /** A keeper whose process has used more CPU at every read. */
  function keeper(cpuPerRead = { user: 0, system: 0 }): FiguresKeeper {
    let reads = 0;
    return {
      last: () => undefined,
      refreshInBackground: () => undefined,
      count: () => Promise.resolve(figures().counts),
      files: () => Promise.resolve(figures().files),
      reportFigures: () => {
        reads += 1;
        return Promise.resolve(
          figures(
            {},
            {
              user: 10 + cpuPerRead.user * reads,
              system: 1 + cpuPerRead.system * reads,
            },
          ),
        );
      },
    };
  }

  it("sends once after the start settles and then every 24 hours", async () => {
    const send = vi.fn(() => Promise.resolve());
    const report = startDailyReport({
      keeper: keeper(),
      enabled: on,
      send,
      warn: vi.fn(),
    });
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
    startDailyReport({
      keeper: keeper(),
      enabled: on,
      send,
      warn: vi.fn(),
    }).stop();
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });

  it("contains a failing send, warns once and tries again the next day", async () => {
    const send = vi
      .fn<(event: string, properties: object) => Promise<void>>()
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValue(undefined);
    const warn = vi.fn();
    const report = startDailyReport({
      keeper: keeper(),
      enabled: on,
      send,
      warn,
    });
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
      enabled: on,
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
      reportFigures: () => Promise.reject(new Error("disk gone")),
    };
    const report = startDailyReport({
      keeper: broken,
      enabled: on,
      send,
      warn,
    });
    await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS);
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    report.stop();
  });

  describe("CPU since the previous attempt", () => {
    const cpuOf = (send: { mock: { calls: unknown[][] } }, call: number) =>
      (send.mock.calls[call]?.[1] as { cpu_user_seconds: number })
        .cpu_user_seconds;

    it("reports the use since the last send", async () => {
      const send = vi.fn(() => Promise.resolve());
      const report = startDailyReport({
        keeper: keeper({ user: 5, system: 0 }),
        enabled: on,
        send,
        warn: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS);
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
      // The process reads 15 s then 20 s in total; the first report is the
      // whole 15 s from the start, the second only the 5 s since.
      expect(cpuOf(send, 0)).toBeCloseTo(15);
      expect(cpuOf(send, 1)).toBeCloseTo(5);
      report.stop();
    });

    it("loses a failed send's period instead of counting it twice", async () => {
      const send = vi
        .fn<(event: string, properties: object) => Promise<void>>()
        .mockRejectedValueOnce(new Error("refused"))
        .mockResolvedValue(undefined);
      const report = startDailyReport({
        keeper: keeper({ user: 5, system: 0 }),
        enabled: on,
        send,
        warn: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS);
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
      expect(cpuOf(send, 1)).toBeCloseTo(5);
      report.stop();
    });

    it("loses a timed-out send's period instead of counting it twice", async () => {
      const send = vi
        .fn<(event: string, properties: object) => Promise<void>>()
        .mockReturnValueOnce(new Promise(() => undefined))
        .mockResolvedValue(undefined);
      const report = startDailyReport({
        keeper: keeper({ user: 5, system: 0 }),
        enabled: on,
        send,
        warn: vi.fn(),
        sendTimeoutMs: 5000,
      });
      await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS + 5000);
      await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
      expect(cpuOf(send, 1)).toBeCloseTo(5);
      report.stop();
    });
  });

  it("with reporting off counts nothing, sends nothing and moves no baseline", async () => {
    let enabled = false;
    const send = vi.fn(() => Promise.resolve());
    const source = keeper({ user: 5, system: 0 });
    const read = vi.spyOn(source, "reportFigures");
    const report = startDailyReport({
      keeper: source,
      enabled: () => Promise.resolve(enabled),
      send,
      warn: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS);
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
    expect(read).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    enabled = true;
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
    // Nothing advanced while it was off: the first report is the whole use.
    expect(
      (
        send.mock.calls[0] as unknown as [string, { cpu_user_seconds: number }]
      )[1].cpu_user_seconds,
    ).toBeCloseTo(15);
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
      enabled: on,
      send: () => Promise.resolve(),
      warn: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(FIRST_REPORT_DELAY_MS);
    expect(timers.length).toBeGreaterThanOrEqual(2);
    expect(timers.filter((timer) => timer.hasRef())).toHaveLength(0);
    report.stop();
  });
});
