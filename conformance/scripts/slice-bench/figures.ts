/**
 * The file one run writes: the figures, the machine and the load it ran
 * under. It is rewritten after every figure, so a run that crashes keeps what
 * it had measured.
 */
import { writeFileSync } from "node:fs";
import { arch, cpus, loadavg, platform, release, totalmem } from "node:os";
import { percentile } from "../../src/utils/timing.js";

export type Unit = "ms" | "s" | "MB" | "per_s" | "count" | "bytes";

export interface Figure {
  name: string;
  /** What was measured, for the table. */
  label: string;
  unit: Unit;
  /** Which way is better, so the table can say which server won. */
  better: "lower" | "higher" | "neither";
  /** False when the server lacks the door, or answered it wrongly. */
  available: boolean;
  /** The median of a distribution, else the one measurement. */
  value: number | null;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  samples: number | null;
  errors: number;
  note: string | null;
}

export interface Run {
  harness: "slice-bench";
  label: string;
  items_target: number;
  started_at: string;
  finished_at: string | null;
  machine: {
    platform: string;
    release: string;
    arch: string;
    cpu: string;
    cpus: number;
    memory_gb: number;
    node: string;
    load_at_start: number[];
    load_at_end: number[] | null;
  };
  figures: Figure[];
  /** Per SQLite file: its tables, their rows and, where SQLite can say, bytes. */
  storage: Record<string, unknown>;
  notes: string[];
}

export function newRun(label: string, items: number): Run {
  const cpu = cpus();
  return {
    harness: "slice-bench",
    label,
    items_target: items,
    started_at: new Date().toISOString(),
    finished_at: null,
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpu[0]?.model ?? "unknown",
      cpus: cpu.length,
      memory_gb: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      load_at_start: loadavg(),
      load_at_end: null,
    },
    figures: [],
    storage: {},
    notes: [],
  };
}

interface Describe {
  name: string;
  label: string;
  unit: Unit;
  better?: Figure["better"];
  errors?: number;
  note?: string;
}

export function scalar(describe: Describe, value: number): Figure {
  return {
    name: describe.name,
    label: describe.label,
    unit: describe.unit,
    better: describe.better ?? "lower",
    available: true,
    value,
    p50: null,
    p95: null,
    min: null,
    max: null,
    samples: null,
    errors: describe.errors ?? 0,
    note: describe.note ?? null,
  };
}

export function distribution(describe: Describe, times: number[]): Figure {
  if (times.length === 0) {
    return {
      ...scalar(describe, 0),
      value: null,
      samples: 0,
      note: describe.note ?? "no request succeeded",
    };
  }
  const sorted = [...times].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  return {
    ...scalar(describe, p50),
    p50,
    p95: percentile(sorted, 95),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    samples: sorted.length,
  };
}

export function unavailable(describe: Describe, why: string): Figure {
  return {
    ...scalar(describe, 0),
    available: false,
    value: null,
    note: why,
  };
}

export class Recorder {
  constructor(
    readonly run: Run,
    private readonly out: string,
  ) {
    this.save();
  }

  add(figure: Figure): void {
    this.run.figures.push(figure);
    this.save();
    const shown = !figure.available
      ? `not available (${figure.note ?? ""})`
      : figure.p95 === null
        ? `${format(figure.value)} ${figure.unit}`
        : `p50 ${format(figure.p50)} p95 ${format(figure.p95)} ${figure.unit} over ${figure.samples}`;
    log(
      `${figure.name}: ${shown}${figure.errors > 0 ? `, ${figure.errors} errors` : ""}`,
    );
  }

  note(text: string): void {
    this.run.notes.push(text);
    this.save();
    log(`note: ${text}`);
  }

  save(): void {
    writeFileSync(this.out, `${JSON.stringify(this.run, null, 2)}\n`);
  }

  finish(): void {
    this.run.finished_at = new Date().toISOString();
    this.run.machine.load_at_end = loadavg();
    this.save();
  }
}

export function format(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  const magnitude = Math.abs(value);
  const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function log(message: string): void {
  console.log(`[slice-bench ${new Date().toISOString()}] ${message}`);
}
