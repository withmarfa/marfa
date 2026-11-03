import { describe, expect, it } from "vitest";
import { parseProcStatus, pickServerPid } from "./memory.js";

describe("reading /proc/<pid>/status", () => {
  it("returns resident and peak memory in megabytes", () => {
    const text = [
      "Name:\tnode",
      "VmPeak:\t 2000000 kB",
      "VmHWM:\t  307200 kB",
      "VmRSS:\t  204800 kB",
      "Threads:\t11",
    ].join("\n");
    expect(parseProcStatus(text)).toEqual({ rssMb: 200, peakMb: 300 });
  });

  it("returns null for a field the file lacks", () => {
    expect(parseProcStatus("VmRSS:\t1024 kB\n")).toEqual({
      rssMb: 1,
      peakMb: null,
    });
    expect(parseProcStatus("Name:\tnode\n")).toBeNull();
  });
});

describe("finding the server under its supervisor", () => {
  const ps = [
    "  100     1  20000",
    "  101   100 512000",
    "  102   101   9000",
    "  200     1 900000",
  ].join("\n");

  it("takes the supervisor's child, not the supervisor and not an unrelated process", () => {
    expect(pickServerPid(ps, 100)).toBe(101);
  });

  it("falls back to the pid itself when it has no child", () => {
    expect(pickServerPid(ps, 200)).toBe(200);
  });

  it("takes the largest when the supervisor has several children", () => {
    expect(pickServerPid(`${ps}\n  103   100 600000`, 100)).toBe(103);
  });

  it("ignores lines it cannot read", () => {
    expect(pickServerPid("garbage\n  101   100 5", 100)).toBe(101);
  });
});
