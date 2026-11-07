/**
 * What every step of the nightly scale benchmark shares: where the booted
 * server's state is, how to talk to it, and how a step records its figures.
 *
 * A step never reads the URL from the job's environment: a restart can move
 * the server to another port, so each call reads the state directory's env
 * file again.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseEnvFile } from "../../src/utils/target.js";
import {
  fragmentOf,
  type Figure,
  type Fragment,
} from "../../src/utils/scale/figures.js";
import { parseFragment } from "../../src/utils/scale/report.js";

/**
 * The size of the instance. 250,000 items is what the budgets were set at in
 * the scale test of 2 November 2026, and it is the size people reach, so a
 * budget that holds there holds for them. `MARFA_SCALE_ITEMS` shrinks it for a
 * local run, and every figure then carries the size it was measured at.
 */
export const DEFAULT_ITEMS = 250_000;

export function targetItems(): number {
  const raw = process.env.MARFA_SCALE_ITEMS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ITEMS;
  const items = Number(raw);
  if (!Number.isSafeInteger(items) || items < 1_000) {
    throw new Error(
      `MARFA_SCALE_ITEMS is ${raw}; it needs a whole number of at least 1,000`,
    );
  }
  return items;
}

export function stateDir(): string {
  const state = process.env.MARFA_SCALE_STATE;
  if (state === undefined || state === "") {
    throw new Error(
      "MARFA_SCALE_STATE names the state directory of the booted server",
    );
  }
  return resolve(state);
}

/** Where fragments and the merged file go, under the conformance folder. */
export const REPORTS_DIR = resolve("reports", "scale");

export function log(message: string): void {
  console.log(`[scale ${new Date().toISOString()}] ${message}`);
}

export const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

export interface Connection {
  url: string;
  key: string;
}

export function connect(): Connection {
  const file = resolve(stateDir(), "env");
  const env = parseEnvFile(readFileSync(file, "utf8"));
  const url = env.MARFA_API_URL;
  const key = env.MARFA_API_KEY;
  if (!url || !key) throw new Error(`${file} names no server and key`);
  return { url: url.replace(/\/$/, ""), key };
}

export interface Answer {
  status: number;
  /** Milliseconds from sending the request to the whole body read. */
  ms: number;
  text: string;
  json: () => unknown;
}

/**
 * One request. A 429 is waited out and retried, since it says the server is
 * fine and asks for time; any other answer, or a failure to answer, is
 * returned for the caller to count. A network failure is status 0. The clock
 * starts once, before the first try, so the time a retry waited is in the
 * answer's `ms` and a limiter cannot make a request look quick.
 */
export async function api(
  method: "GET" | "POST",
  path: string,
  body?: string | object,
  connection: Connection = connect(),
): Promise<Answer> {
  const payload =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const start = performance.now();
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let text = "";
    try {
      const response = await fetch(`${connection.url}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${connection.key}`,
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body: payload,
        signal: AbortSignal.timeout(900_000),
      });
      status = response.status;
      text = await response.text();
      if (status === 429 && attempt < 8) {
        await sleep(Number(response.headers.get("retry-after") ?? "5") * 1000);
        continue;
      }
    } catch (error) {
      text = String(error);
    }
    return {
      status,
      ms: performance.now() - start,
      text,
      json: () => JSON.parse(text) as unknown,
    };
  }
}

export const ok = (answer: Answer) =>
  answer.status >= 200 && answer.status < 300;

/** Items the seed step kept for the later steps to read and write against. */
export interface Sample {
  /** Ids spread across the whole instance. */
  ids: string[];
  /** Ids of items that have a parent, so deep in a tree. */
  childIds: string[];
}

export function sampleFile(): string {
  return resolve(stateDir(), "scale-sample.json");
}

export function readSample(): Sample {
  if (!existsSync(sampleFile())) {
    throw new Error("the seed step left no sample of ids; it did not finish");
  }
  return JSON.parse(readFileSync(sampleFile(), "utf8")) as Sample;
}

function fragmentPath(step: string, partial: boolean): string {
  return resolve(REPORTS_DIR, `${step}${partial ? ".partial" : ""}.json`);
}

export function readFragment(step: string, partial = false): Fragment | null {
  const file = fragmentPath(step, partial);
  if (!existsSync(file)) return null;
  const fragment = parseFragment(readFileSync(file, "utf8"));
  if (fragment === null) log(`${file} is not a whole fragment; it is ignored`);
  return fragment;
}

/**
 * A step's figures. Each one is written to a partial file at once, so a step
 * that crashes or times out later keeps what it had measured; `finish` makes
 * the fragment whole, which is what tells the merge the step completed.
 */
export class Recorder {
  private figures: Figure[] = [];
  private items: number | undefined;

  constructor(readonly step: string) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    rmSync(fragmentPath(step, false), { force: true });
    this.save();
  }

  add(figure: Figure): Figure {
    this.figures.push(figure);
    this.save();
    const verdict = figure.passed ? "ok" : "MISSED";
    log(
      `${figure.name} = ${figure.value.toFixed(2)} ${figure.unit}` +
        `${figure.ceiling === null ? "" : ` (ceiling ${figure.ceiling})`} ${verdict}`,
    );
    return figure;
  }

  learnedItems(items: number): void {
    this.items = items;
    this.save();
  }

  private fragment(): Fragment {
    return fragmentOf(
      this.step,
      this.figures,
      this.items === undefined ? {} : { items: this.items },
    );
  }

  private save(): void {
    writeFileSync(
      fragmentPath(this.step, true),
      JSON.stringify(this.fragment(), null, 2),
    );
  }

  finish(): void {
    writeFileSync(
      fragmentPath(this.step, false),
      JSON.stringify(this.fragment(), null, 2),
    );
    rmSync(fragmentPath(this.step, true), { force: true });
  }
}

export function supervisorPid(): number {
  const pid = Number(
    readFileSync(resolve(stateDir(), "server.pid"), "utf8").trim(),
  );
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error("server.pid names no process");
  return pid;
}
