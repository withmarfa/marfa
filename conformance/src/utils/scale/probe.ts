/**
 * A fixed measure of the runner itself, using no Marfa code, so a night can
 * tell a slow host from a slow server. A figure alone cannot: both raise it.
 *
 * The CPU work is plain integer arithmetic over a table too large for a core's
 * private caches. A library hash would not do: SHA-256 runs several times
 * faster on a CPU with the SHA instructions, and hosted runners come with and
 * without them, so it would measure the model rather than the night.
 */
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  distribution,
  fragmentOf,
  PROBE_REFERENCE_MS,
  type Fragment,
} from "./figures.js";

export const CPU_ROUNDS = 10_000_000;
const TABLE_WORDS = 1 << 22;

/** The fixed work; the result is returned so that it cannot be optimized away. */
export function cpuWork(rounds: number = CPU_ROUNDS): number {
  const table = new Uint32Array(TABLE_WORDS);
  const mask = TABLE_WORDS - 1;
  let hash = 2166136261;
  for (let round = 0; round < rounds; round++) {
    const slot = (hash ^ round) & mask;
    hash = Math.imul(hash ^ (table[slot] as number), 16777619);
    table[slot] = hash;
  }
  return hash >>> 0;
}

export const DISK_WRITES = 200;
const DISK_LIMIT_MS = 5_000;
const BLOCK = Buffer.alloc(4_096, 0x5a);

/**
 * Milliseconds for one synced write of a block, in `directory`'s file system.
 * The answer is per write so that a disk slow enough to reach the limit still
 * reads on the same scale as any other night.
 */
export function diskWork(
  directory: string,
  writes: number = DISK_WRITES,
  limitMs: number = DISK_LIMIT_MS,
): number {
  const file = join(directory, `.scale-probe-${process.pid}`);
  const descriptor = openSync(file, "w");
  try {
    const start = performance.now();
    let done = 0;
    while (done < writes && performance.now() - start < limitMs) {
      writeSync(descriptor, BLOCK);
      fsyncSync(descriptor);
      done++;
    }
    return (performance.now() - start) / done;
  } finally {
    closeSync(descriptor);
    rmSync(file, { force: true });
  }
}

export interface ProbeReading {
  step: string;
  cpuMs: number | null;
  diskMs: number | null;
}

function attempt(work: () => number): number | null {
  try {
    return work();
  } catch (error) {
    console.log(`[scale] the probe could not measure: ${String(error)}`);
    return null;
  }
}

/** One line in `file`. Never throws: a probe that fails must not cost the step. */
export function takeReading(
  step: string,
  stateDirectory: string,
  file: string,
  work: { rounds?: number; writes?: number } = {},
): ProbeReading {
  const cpuMs = attempt(() => {
    const start = performance.now();
    cpuWork(work.rounds);
    return performance.now() - start;
  });
  const diskMs = attempt(() => diskWork(stateDirectory, work.writes));
  const reading = { step, cpuMs, diskMs };
  attempt(() => {
    appendFileSync(file, `${JSON.stringify(reading)}\n`);
    return 0;
  });
  return reading;
}

const measure = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

/** The readings in a file a killed step may have cut off mid-line. */
export function parseReadings(text: string): ProbeReading[] {
  const readings: ProbeReading[] = [];
  for (const line of text.split("\n")) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const { step, cpuMs, diskMs } = raw as Record<string, unknown>;
    if (typeof step !== "string") continue;
    readings.push({ step, cpuMs: measure(cpuMs), diskMs: measure(diskMs) });
  }
  return readings;
}

/**
 * The night's figures. A measure with no readings is left out, not recorded
 * empty: an empty figure fails the night, and a probe that crashed must only
 * leave the night judged as normal.
 */
export function probeFragment(
  readings: readonly ProbeReading[],
  cpu: { model: string; count: number },
): Fragment {
  const of = (
    name: keyof typeof PROBE_REFERENCE_MS,
    values: (number | null)[],
    what: string,
    suffix: string,
  ) => {
    const kept = values.filter((value): value is number => value !== null);
    if (kept.length === 0) return [];
    const figure = distribution(name, "ms", kept);
    const list = kept.map((value) => value.toFixed(1)).join(", ");
    return [
      {
        ...figure,
        note: `median ${figure.p50?.toFixed(1)} ms ${what} over ${kept.length} readings (${list}), reference ${PROBE_REFERENCE_MS[name]} ms${suffix}`,
      },
    ];
  };
  return fragmentOf("probe", [
    ...of(
      "runner_cpu_probe",
      readings.map((reading) => reading.cpuMs),
      "for the fixed loop",
      `; ${cpu.model}, ${cpu.count} CPUs`,
    ),
    ...of(
      "runner_disk_probe",
      readings.map((reading) => reading.diskMs),
      "a synced write",
      "",
    ),
  ]);
}
