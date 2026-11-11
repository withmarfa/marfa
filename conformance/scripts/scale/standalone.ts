/**
 * What the steps that boot servers of their own share: one connector's calls
 * through the public API, the state directory's env file, and the table of
 * figures against goals that each prints at the end.
 */
import { readFileSync, statSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "../../src/utils/target.js";
import { type Figure } from "../../src/utils/scale/figures.js";
import { timedAnswer } from "../../src/utils/scale/answer.js";
import { percentile } from "../../src/utils/timing.js";
import { log, type Answer, type Connection, type Recorder } from "./context.js";

// A refusal is counted, never retried, so it cannot pass as a slow answer.
export async function send(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body: string | object | undefined,
  connection: Connection,
): Promise<Answer> {
  const payload =
    body === undefined || typeof body === "string"
      ? body
      : JSON.stringify(body);
  return timedAnswer(() =>
    fetch(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.key}`,
        ...(payload === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: payload,
      signal: AbortSignal.timeout(900_000),
    }),
  );
}

export function connectionOf(
  state: string,
  key: "MARFA_API_KEY" | "MARFA_MANAGEMENT_KEY",
): Connection {
  const env = parseEnvFile(readFileSync(join(state, "env"), "utf8"));
  const url = env.MARFA_API_URL;
  const secret = env[key];
  if (!url || !secret)
    throw new Error(`${state}/env names no server and ${key}`);
  return { url: url.replace(/\/$/, ""), key: secret };
}

export const supervisor = (state: string) =>
  Number(readFileSync(join(state, "server.pid"), "utf8").trim());

export const megabytes = (path: string) => {
  try {
    return statSync(path).size / 1_048_576;
  } catch {
    return 0;
  }
};

export function mustOk(
  what: string,
  answer: { status: number; text: string },
  status = 200,
): void {
  if (answer.status !== status) {
    throw new Error(
      `${what} answered ${answer.status}: ${answer.text.slice(0, 300)}`,
    );
  }
}

interface WriteAnswer {
  batch: string | null;
  last_activity_at?: string | null;
  results: { id: string; outcome: string }[];
}

/** What a rows write created, and why not every row of it was. */
export function judgeWrite(
  answer: { status: number; text: string; json: () => unknown },
  size: number,
) {
  if (answer.status !== 200) {
    return {
      written: [] as string[],
      batch: null,
      lastActivity: null as string | null,
      errors: size,
      note: `${answer.status}: ${answer.text.slice(0, 160)}`,
    };
  }
  const parsed = answer.json() as WriteAnswer;
  const created = parsed.results.filter((r) => r.outcome === "created");
  return {
    written: created.map((r) => r.id),
    batch: parsed.batch,
    lastActivity: parsed.last_activity_at ?? null,
    errors: size - created.length,
    note: null as string | null,
  };
}

export function whole(name: string, raw: string, least: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < least) {
    throw new Error(
      `--${name} is ${raw}; it needs a whole number of ${least} or more`,
    );
  }
  return value;
}

export interface Goal {
  text: string;
  verdict: (figure: Figure) => boolean | null;
}

export const upTo = (text: string): Goal => ({
  text,
  verdict: (f) => f.passed,
});

export const recordedOnly = (text: string): Goal => ({
  text,
  verdict: () => null,
});

/** A step's figures with the goal each is judged by, and the machine's load while it ran. */
export class Scoreboard {
  readonly figures: Figure[] = [];
  private readonly goals = new Map<string, Goal>();
  private readonly loads: number[] = [];
  private sampler: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly recorder: Recorder) {}

  add(figure: Figure, goal: Goal): void {
    this.figures.push(this.recorder.add(figure));
    this.goals.set(figure.name, goal);
  }

  startLoad(): void {
    const sample = () => this.loads.push(loadavg()[0] ?? 0);
    sample();
    this.sampler = setInterval(sample, 10_000);
    log(
      `load average at the start: ${loadavg()
        .map((n) => n.toFixed(2))
        .join(" ")} on ${cpus().length} cores`,
    );
  }

  stopLoad(): void {
    if (this.sampler !== null) clearInterval(this.sampler);
  }

  /** Prints each figure against its goal; a figure with errors fails the process. */
  report(): void {
    const sorted = [...this.loads].sort((a, b) => a - b);
    console.log("");
    console.log(
      `load average (1 minute) while it ran: mean ${(this.loads.reduce((a, b) => a + b, 0) / this.loads.length).toFixed(1)}, p95 ${percentile(sorted, 95).toFixed(1)}, max ${(sorted.at(-1) ?? 0).toFixed(1)} on ${cpus().length} cores`,
    );
    console.log(
      "| figure | p50 | value (p95 for a distribution) | goal | verdict |",
    );
    console.log("|---|---|---|---|---|");
    for (const figure of this.figures) {
      const goal = this.goals.get(figure.name);
      const verdict = goal?.verdict(figure);
      const text =
        figure.errors > 0
          ? `ERRORS ${figure.errors}`
          : verdict === null || verdict === undefined
            ? "recorded"
            : verdict
              ? "met"
              : "MISSED";
      console.log(
        `| ${figure.name} | ${figure.p50 === null ? "" : figure.p50.toFixed(2)} | ${figure.value.toFixed(2)} ${figure.unit} | ${goal?.text ?? ""} | ${text}${figure.note === null ? "" : ` (${figure.note})`} |`,
      );
    }
    if (this.figures.some((figure) => figure.errors > 0)) process.exitCode = 1;
  }
}
