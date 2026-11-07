/**
 * The server's memory and CPU, read from outside it with `ps`.
 *
 * `<state>/server.pid` names the process the adapter spawned. Today that is
 * the adapter's own supervisor (`run-server.mjs`), a Node process that only
 * waits for the server and records how it ended; the server is its child.
 * Two readings are kept: the whole tree under the pid, and the tree without
 * that supervisor, which is what a deployment runs.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The adapter's supervisor, which no deployment runs. */
const SUPERVISOR = "run-server.mjs";

interface Row {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuS: number;
  command: string;
}

export interface Reading {
  /** Every process under the pid file's, that one included. */
  treeMb: number;
  /** The same without the adapter's supervisor. */
  serverMb: number;
  /** User and system CPU of the server processes since they started. */
  serverCpuS: number;
  processes: { pid: number; rssMb: number; command: string }[];
}

export function readPid(state: string): number {
  const pid = Number(readFileSync(resolve(state, "server.pid"), "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`${state}/server.pid names no process`);
  }
  return pid;
}

/** `ps` CPU time: `[[dd-]hh:]mm:ss[.ss]`. */
export function parseCpuTime(text: string): number {
  const [days, rest] = text.includes("-")
    ? [Number(text.split("-")[0]), text.slice(text.indexOf("-") + 1)]
    : [0, text];
  const seconds = rest
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
  return days * 86_400 + seconds;
}

export function parsePs(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      cpuS: parseCpuTime(match[4] as string),
      command: match[5] as string,
    });
  }
  return rows;
}

export function readingOf(rows: Row[], root: number): Reading {
  const children = new Map<number, Row[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const tree: Row[] = [];
  const top = rows.find((row) => row.pid === root);
  const queue = top === undefined ? [] : [top];
  while (queue.length > 0) {
    const row = queue.shift() as Row;
    tree.push(row);
    queue.push(...(children.get(row.pid) ?? []));
  }
  const server = tree.filter(
    (row) => !(row.pid === root && row.command.includes(SUPERVISOR)),
  );
  const mb = (list: Row[]) =>
    list.reduce((sum, row) => sum + row.rssKb, 0) / 1024;
  return {
    treeMb: mb(tree),
    serverMb: mb(server),
    serverCpuS: server.reduce((sum, row) => sum + row.cpuS, 0),
    processes: tree.map((row) => ({
      pid: row.pid,
      rssMb: row.rssKb / 1024,
      command: row.command.slice(0, 160),
    })),
  };
}

/** Asynchronous, so a sampler does not hold up the requests it runs beside. */
export async function readProcesses(state: string): Promise<Reading> {
  const { stdout } = await run("ps", [
    "-A",
    "-o",
    "pid=,ppid=,rss=,time=,command=",
  ]);
  const reading = readingOf(parsePs(stdout), readPid(state));
  if (reading.processes.length === 0) {
    throw new Error(`no process under ${state}/server.pid is running`);
  }
  return reading;
}

/** Reads the processes every `everyMs` until stopped, and keeps the peaks. */
export class Sampler {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  peakServerMb = 0;
  peakTreeMb = 0;
  samples = 0;

  constructor(
    private readonly state: string,
    private readonly everyMs = 250,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      readProcesses(this.state)
        .then((reading) => {
          this.samples++;
          this.peakServerMb = Math.max(this.peakServerMb, reading.serverMb);
          this.peakTreeMb = Math.max(this.peakTreeMb, reading.treeMb);
        })
        .catch(() => undefined)
        .finally(() => {
          this.busy = false;
        });
    }, this.everyMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }
}
