/**
 * The server's resident memory, read from outside it.
 *
 * The state directory's `server.pid` names the supervisor that
 * `scripts/marfa-server.ts` starts, not the server: the server is its child.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface Memory {
  rssMb: number;
  /** The most resident memory the process has held; only Linux reports it. */
  peakMb: number | null;
}

function kilobytes(text: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, "m").exec(text);
  return match?.[1] === undefined ? null : Number(match[1]) / 1024;
}

/** `/proc/<pid>/status` as megabytes. */
export function parseProcStatus(text: string): Memory | null {
  const rss = kilobytes(text, "VmRSS");
  if (rss === null) return null;
  return { rssMb: rss, peakMb: kilobytes(text, "VmHWM") };
}

/**
 * The server's pid, from `ps -A -o pid=,ppid=,rss=`: the largest child of the
 * supervisor, or the supervisor itself when it has none.
 */
export function pickServerPid(ps: string, supervisor: number): number {
  let best: { pid: number; rss: number } | undefined;
  for (const line of ps.split("\n")) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    if (
      pid === undefined ||
      ppid !== supervisor ||
      rss === undefined ||
      !Number.isFinite(pid) ||
      !Number.isFinite(rss)
    ) {
      continue;
    }
    if (best === undefined || rss > best.rss) best = { pid, rss };
  }
  return best?.pid ?? supervisor;
}

export function serverPid(supervisor: number): number {
  const ps = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], {
    encoding: "utf8",
  });
  return pickServerPid(ps, supervisor);
}

/** Reads the server's memory now. */
export function readServerMemory(supervisor: number): Memory {
  const pid = serverPid(supervisor);
  try {
    const parsed = parseProcStatus(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (parsed !== null) return parsed;
  } catch {
    // No /proc: macOS.
  }
  const rssKb = Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim(),
  );
  if (!Number.isFinite(rssKb)) {
    throw new Error(`could not read the memory of pid ${pid}`);
  }
  return { rssMb: rssKb / 1024, peakMb: null };
}
