import { describe, expect, it } from "vitest";
import {
  CpuMeter,
  cpuSecondsPerMinute,
  descendantsOf,
  parseProcStat,
  parsePsCpuTime,
} from "./cpu.js";

// A /proc/<pid>/stat line: pid, (comm), state, ppid, ... utime (14), stime (15).
function statLine(
  pid: number,
  comm: string,
  ppid: number,
  utime: number,
  stime: number,
) {
  const fields = Array.from({ length: 49 }, () => "0");
  fields[0] = String(pid);
  fields[1] = `(${comm})`;
  fields[2] = "S";
  fields[3] = String(ppid);
  fields[13] = String(utime);
  fields[14] = String(stime);
  return `${fields.join(" ")}\n`;
}

describe("reading /proc/<pid>/stat", () => {
  it("takes the parent and the user and system time in ticks", () => {
    expect(parseProcStat(statLine(42, "marfa", 7, 300, 120))).toEqual({
      pid: 42,
      ppid: 7,
      ticks: 420,
    });
  });

  it("reads a name that holds spaces and brackets", () => {
    expect(parseProcStat(statLine(9, "my (odd) name", 1, 5, 5))).toEqual({
      pid: 9,
      ppid: 1,
      ticks: 10,
    });
  });

  it("answers null for a line that is not a stat line", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("garbage")).toBeNull();
  });
});

describe("reading ps cputime", () => {
  it.each([
    ["0:00.22", 0.22],
    ["1:02.50", 62.5],
    ["01:02:03", 3723],
    ["2-01:00:00", 2 * 86_400 + 3_600],
    ["  0:10 ", 10],
  ])("reads %s", (text, seconds) => {
    expect(parsePsCpuTime(text)).toBeCloseTo(seconds);
  });

  it("answers null for text it cannot read", () => {
    expect(parsePsCpuTime("n/a")).toBeNull();
  });
});

describe("a process and its children", () => {
  it("finds every descendant but not the others", () => {
    const processes = [
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 20, ppid: 1 },
    ];
    expect(descendantsOf(10, processes).sort()).toEqual([11, 12]);
    expect(descendantsOf(99, processes)).toEqual([]);
  });
});

describe("the CPU a process tree used", () => {
  it("sums the processes and counts only what was used since the first reading", () => {
    const meter = new CpuMeter();
    meter.read(
      new Map([
        [10, 5],
        [11, 1],
      ]),
    );
    meter.read(
      new Map([
        [10, 8],
        [11, 2],
      ]),
    );
    expect(meter.usedSinceFirstRead()).toBeCloseTo(4);
  });

  it("keeps the time of a child that ended between two readings", () => {
    const meter = new CpuMeter();
    meter.read(
      new Map([
        [10, 1],
        [11, 0],
      ]),
    );
    meter.read(
      new Map([
        [10, 2],
        [11, 3],
      ]),
    );
    // 11 is gone; its 3 s was used and must not leave the total.
    meter.read(new Map([[10, 3]]));
    expect(meter.usedSinceFirstRead()).toBeCloseTo(2 + 3);
  });

  it("counts a child that started after the first reading from nothing", () => {
    const meter = new CpuMeter();
    meter.read(new Map([[10, 1]]));
    meter.read(
      new Map([
        [10, 1],
        [30, 2.5],
      ]),
    );
    expect(meter.usedSinceFirstRead()).toBeCloseTo(2.5);
  });

  it("is zero before two readings", () => {
    const meter = new CpuMeter();
    expect(meter.usedSinceFirstRead()).toBe(0);
    meter.read(new Map([[10, 4]]));
    expect(meter.usedSinceFirstRead()).toBe(0);
  });

  it("reports seconds a minute over the window the readings cover", () => {
    expect(cpuSecondsPerMinute(5, 10 * 60_000)).toBeCloseTo(0.5);
    expect(cpuSecondsPerMinute(3, 30_000)).toBeCloseTo(6);
  });

  it("refuses a window that is not a time", () => {
    expect(Number.isNaN(cpuSecondsPerMinute(1, 0))).toBe(true);
  });
});
