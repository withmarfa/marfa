/**
 * The runner's speed, read before each measuring step, so a slowness that comes
 * and goes across the job is seen and only one that lasts moves the median. The
 * readings stay in a file of their own, since no step owns them; `finish` makes
 * them a fragment.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import type { Fragment } from "../../src/utils/scale/figures.js";
import {
  parseReadings,
  probeFragment,
  takeReading,
} from "../../src/utils/scale/probe.js";
import { EXPECTED_STEPS } from "../../src/utils/scale/report.js";
import { log, REPORTS_DIR, stateDir } from "./context.js";

const READINGS_FILE = resolve(REPORTS_DIR, "probe-readings.jsonl");

/** One reading before `step`. Never throws: the step matters more than this. */
export function recordProbe(step: string): void {
  try {
    mkdirSync(REPORTS_DIR, { recursive: true });
    // The first step of a run, so a local run does not count an earlier one's.
    if (step === EXPECTED_STEPS[0]) rmSync(READINGS_FILE, { force: true });
    const { cpuMs, diskMs } = takeReading(step, stateDir(), READINGS_FILE);
    log(
      `probe before ${step}: CPU ${cpuMs?.toFixed(1) ?? "n/a"} ms, disk ${diskMs?.toFixed(1) ?? "n/a"} ms a synced write`,
    );
  } catch (error) {
    log(`no probe before ${step}: ${String(error)}`);
  }
}

export function probeFragmentOfTheNight(): Fragment {
  const readings = existsSync(READINGS_FILE)
    ? parseReadings(readFileSync(READINGS_FILE, "utf8"))
    : [];
  const all = cpus();
  return probeFragment(readings, {
    model: all[0]?.model ?? "unknown CPU",
    count: all.length,
  });
}
