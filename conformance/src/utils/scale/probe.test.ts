import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readFragment, REPORTS_DIR } from "../../../scripts/scale/context.js";
import { MIN_PROBE_READINGS, PROBE_REFERENCE_MS } from "./figures.js";
import {
  cpuWork,
  diskWork,
  parseReadings,
  probeFragment,
  takeReading,
} from "./probe.js";
import { EXPECTED_STEPS, mergeFragments, verdictOf } from "./report.js";

const run = {
  commit: "abc1234",
  runId: "42",
  date: "2026-11-03T04:43:00.000Z",
  profile: "scale-250k",
};

const directory = mkdtempSync(join(tmpdir(), "scale-probe-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const small = { rounds: 1_000, writes: 2 };

describe("the probe's work", () => {
  it("does the same fixed work every time", () => {
    expect(cpuWork(1_000)).toBe(cpuWork(1_000));
    expect(cpuWork(1_000)).not.toBe(cpuWork(1_001));
  });

  it("times writes in the directory it is given and leaves nothing behind", () => {
    const perWrite = diskWork(directory, 3);
    expect(perWrite).toBeGreaterThan(0);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("stops at its limit and still answers per write", () => {
    const perWrite = diskWork(directory, 1_000_000, 20);
    expect(perWrite).toBeGreaterThan(0);
    expect(Number.isFinite(perWrite)).toBe(true);
  });

  it("refuses a directory that does not exist", () => {
    expect(() => diskWork(join(directory, "missing"), 1)).toThrow(/ENOENT/);
  });
});

describe("taking a reading", () => {
  it("adds a line that reads back", () => {
    const file = join(directory, "one.jsonl");
    takeReading("seed", directory, file, small);
    takeReading("reads", directory, file, small);
    const readings = parseReadings(readFileSync(file, "utf8"));
    expect(readings.map((reading) => reading.step)).toEqual(["seed", "reads"]);
    expect(readings[0]?.cpuMs).toBeGreaterThan(0);
    expect(readings[0]?.diskMs).toBeGreaterThan(0);
  });

  it("keeps the CPU reading when the disk cannot be written, and does not throw", () => {
    const file = join(directory, "no-state.jsonl");
    takeReading("seed", join(directory, "missing"), file, small);
    const [reading] = parseReadings(readFileSync(file, "utf8"));
    expect(reading?.cpuMs).toBeGreaterThan(0);
    expect(reading?.diskMs).toBeNull();
  });

  it("does not throw when the reading cannot be written", () => {
    const file = join(directory, "missing", "readings.jsonl");
    expect(() => takeReading("seed", directory, file, small)).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});

describe("reading the readings back", () => {
  it("skips a line a killed step cut off, and lines that are no reading", () => {
    const text = [
      JSON.stringify({ step: "seed", cpuMs: 800, diskMs: 3 }),
      "null",
      JSON.stringify({ step: 4, cpuMs: 800, diskMs: 3 }),
      JSON.stringify({ step: "reads", cpuMs: 810, diskMs: 3.1 }),
      '{"step":"bulk","cpuM',
    ].join("\n");
    expect(parseReadings(text).map((reading) => reading.step)).toEqual([
      "seed",
      "reads",
    ]);
  });

  it("drops a measure that is no positive number and keeps the other", () => {
    const [reading] = parseReadings(
      JSON.stringify({ step: "seed", cpuMs: -1, diskMs: 3 }),
    );
    expect(reading).toEqual({ step: "seed", cpuMs: null, diskMs: 3 });
  });
});

describe("the probe's fragment", () => {
  const readings = [1, 2, 3].map((times) => ({
    step: `step${times}`,
    cpuMs: PROBE_REFERENCE_MS.runner_cpu_probe * times,
    diskMs: PROBE_REFERENCE_MS.runner_disk_probe * times,
  }));
  const cpu = { model: "Some CPU 9000", count: 4 };

  it("records each measure with no ceiling, its median and the CPU model", () => {
    const { figures } = probeFragment(readings, cpu);
    expect(figures.map((figure) => figure.name)).toEqual([
      "runner_cpu_probe",
      "runner_disk_probe",
    ]);
    for (const figure of figures) {
      expect(figure.ceiling).toBeNull();
      expect(figure.passed).toBe(true);
      expect(figure.samples).toBe(3);
    }
    expect(figures[0]?.p50).toBe(PROBE_REFERENCE_MS.runner_cpu_probe * 2);
    expect(figures[0]?.note).toMatch(/Some CPU 9000, 4 CPUs/);
    expect(figures[0]?.note).toMatch(/median/);
  });

  it("leaves out a measure with no readings, so a crashed probe fails nothing", () => {
    const { figures } = probeFragment(
      readings.map((reading) => ({ ...reading, diskMs: null })),
      cpu,
    );
    expect(figures.map((figure) => figure.name)).toEqual(["runner_cpu_probe"]);
    const empty = probeFragment([], cpu);
    expect(empty.figures).toEqual([]);
    expect(verdictOf(mergeFragments([empty], run, [])).passed).toBe(true);
  });

  it("does not become a step the night expects", () => {
    const file = mergeFragments([probeFragment(readings, cpu)], run, ["seed"]);
    expect(file.missingSteps).toEqual(["seed"]);
    expect(file.figures).toHaveLength(2);
  });

  it("holds enough readings to judge when every measuring step took one", () => {
    expect(EXPECTED_STEPS.length).toBeGreaterThanOrEqual(MIN_PROBE_READINGS);
  });
});

describe("a fragment file left by a killed step", () => {
  const step = `killed-${process.pid}`;
  const file = (suffix: string) => join(REPORTS_DIR, `${step}${suffix}.json`);
  afterAll(() => {
    rmSync(file(""), { force: true });
    rmSync(file(".partial"), { force: true });
  });

  it("reads as no fragment, and the merge names the step instead of crashing", () => {
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(file(".partial"), '{"step":"killed","figures":[{"name":"rs');
    writeFileSync(file(""), "");
    const whole = readFragment(step);
    const partial = readFragment(step, true);
    expect(whole).toBeNull();
    expect(partial).toBeNull();

    const merged = mergeFragments([], run, [step], []);
    expect(merged.missingSteps).toEqual([step]);
    expect(verdictOf(merged).passed).toBe(false);
  });
});
