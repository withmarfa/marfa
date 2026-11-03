/**
 * CPU time of a process and the children it started, read from `/proc` on
 * Linux or `ps` elsewhere. Pure parsing and bookkeeping, so a run on any
 * machine is judged the same way; the step reads the files.
 */

export interface StatReading {
  pid: number;
  ppid: number;
  /** User plus system time, in clock ticks. */
  ticks: number;
}

/**
 * One `/proc/<pid>/stat` line. The name in brackets can hold spaces and
 * brackets, so the fields are counted from its last closing bracket: the
 * state is first after it, then the parent, and the user and system times are
 * the 12th and 13th fields after the state (fields 14 and 15 of the line).
 */
export function parseProcStat(text: string): StatReading | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  const user = Number(rest[11]);
  const system = Number(rest[12]);
  if (![pid, ppid, user, system].every(Number.isFinite)) return null;
  return { pid, ppid, ticks: user + system };
}

/** `ps -o cputime=`: `M:SS.ss` on macOS, `[D-]HH:MM:SS` on Linux. */
export function parsePsCpuTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?(?:\.(\d+))?$/.exec(
    text.trim(),
  );
  if (match === null) return null;
  const [, days, a, b, c, fraction] = match;
  const seconds =
    c === undefined
      ? Number(a) * 60 + Number(b)
      : Number(a) * 3_600 + Number(b) * 60 + Number(c);
  return (
    Number(days ?? 0) * 86_400 +
    seconds +
    (fraction === undefined ? 0 : Number(`0.${fraction}`))
  );
}

/** Every process below `root`, however deep, in no particular order. */
export function descendantsOf(
  root: number,
  processes: readonly { pid: number; ppid: number }[],
): number[] {
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.pop() as number;
    for (const process of processes) {
      if (process.ppid === parent && !found.includes(process.pid)) {
        found.push(process.pid);
        queue.push(process.pid);
      }
    }
  }
  return found;
}

/**
 * The CPU a tree of processes used between its first reading and its last.
 * Each process counts for the most it was ever seen to have used, so a child
 * that ends between two readings keeps what it used, and one that starts
 * later counts from nothing.
 */
export class CpuMeter {
  private first = new Map<number, number>();
  private latest = new Map<number, number>();
  private reads = 0;

  /** Seconds used so far by each live process of the tree. */
  read(seconds: ReadonlyMap<number, number>): void {
    for (const [pid, used] of seconds) {
      if (this.reads === 0 && !this.first.has(pid)) this.first.set(pid, used);
      this.latest.set(pid, Math.max(this.latest.get(pid) ?? 0, used));
    }
    this.reads++;
  }

  usedSinceFirstRead(): number {
    if (this.reads < 2) return 0;
    let total = 0;
    for (const [pid, latest] of this.latest) {
      total += latest - (this.first.get(pid) ?? 0);
    }
    return total;
  }
}

export function cpuSecondsPerMinute(used: number, windowMs: number): number {
  return windowMs > 0 ? used / (windowMs / 60_000) : Number.NaN;
}
