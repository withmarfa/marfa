/**
 * The faults a conformance harness sets on a running server, held in memory.
 * They are set and cleared only through the routes in `test-routes.ts`, which
 * exist only under `MARFA_TEST_HOOKS`, so on every other server the table
 * stays empty and each fault point below returns at once.
 *
 * A fault is named for where it acts:
 *
 * - `hold:<point>` makes the server wait at the point until the fault is
 *   cleared. The points are `housekeeping:<job>`, the start of a run of that
 *   job, and `version-thinning:item`, between choosing to thin an item and
 *   removing anything from it.
 * - `deadline:<job>=<ms>` shortens the run deadline of that job.
 *
 * The routes refuse a name that answers to no point, and a job the scheduler
 * has not registered, so a typo cannot pass for an armed fault.
 *
 * Nothing persists: a restart starts with no fault.
 */

/** The shape a fault point may take. */
const HOLD_POINT = /^(?:housekeeping:[a-z][a-z0-9-]*|version-thinning:item)$/;
const DEADLINE_JOB = /^[a-z][a-z0-9-]*$/;
/** The longest delay a timer takes. */
const MAX_DEADLINE_MS = 2_147_483_647;

export interface ActiveFault {
  name: string;
  arg: string | null;
  /** How many callers are waiting at a `hold` fault now. */
  waiting: number;
}

interface Entry {
  arg: string | null;
  release: Set<() => void>;
}

const faults = new Map<string, Entry>();

function shapeProblem(name: string, arg: string | null): string | undefined {
  if (name.startsWith("hold:")) {
    if (!HOLD_POINT.test(name.slice(5)))
      return `no hold point is named ${name.slice(5)}`;
    return arg === null ? undefined : "a hold fault takes no argument";
  }
  if (name.startsWith("deadline:")) {
    if (!DEADLINE_JOB.test(name.slice(9)))
      return `${name.slice(9)} is not a job name`;
    const ms = arg === null ? Number.NaN : Number(arg);
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_DEADLINE_MS)
      return "a deadline fault takes a whole number of milliseconds from 1";
    return undefined;
  }
  return "a fault is named hold:<point> or deadline:<job>";
}

/**
 * Why a fault name or argument is refused, or `undefined` when it is armed.
 * `jobs` are the housekeeping jobs the scheduler has registered: a fault on
 * any other job would never act.
 */
export function faultProblem(
  name: string,
  arg: string | null,
  jobs: readonly string[],
): string | undefined {
  const problem = shapeProblem(name, arg);
  if (problem !== undefined) return problem;
  const job = name.startsWith("deadline:")
    ? name.slice(9)
    : name.startsWith("hold:housekeeping:")
      ? name.slice(18)
      : undefined;
  if (job !== undefined && !jobs.includes(job))
    return `no housekeeping job is named ${job}`;
  return undefined;
}

/** Arms a fault of a valid shape; the routes check the job. Setting a name again replaces its argument and keeps its waiters. */
export function setFault(name: string, arg: string | null): void {
  const problem = shapeProblem(name, arg);
  if (problem !== undefined) throw new RangeError(problem);
  const existing = faults.get(name);
  if (existing) existing.arg = arg;
  else faults.set(name, { arg, release: new Set() });
}

/** Clears one fault, or all when `name` is left out, and lets every waiter go. */
export function clearFaults(name?: string): void {
  for (const [key, entry] of [...faults]) {
    if (name !== undefined && key !== name) continue;
    faults.delete(key);
    for (const release of entry.release) release();
  }
}

export function activeFaults(): ActiveFault[] {
  return [...faults].map(([name, entry]) => ({
    name,
    arg: entry.arg,
    waiting: entry.release.size,
  }));
}

/**
 * Runs `step` at once, or after the fault is cleared when `hold:<point>` is
 * armed. `step` is told whether it was held, so a caller can refuse to start
 * work a shutdown released. Nothing is deferred when no fault holds the
 * point, so a server without the hooks starts `step` in the same turn it
 * always did.
 */
export function atPoint<T>(
  point: string,
  step: (held: boolean) => Promise<T>,
): Promise<T> {
  const entry = faults.get(`hold:${point}`);
  if (entry === undefined) return step(false);
  return new Promise<void>((resolve) => {
    const release = () => {
      entry.release.delete(release);
      resolve();
    };
    entry.release.add(release);
  }).then(() => step(true));
}

/** Waits here while `hold:<point>` is armed; returns at once otherwise. */
export async function holdAt(point: string): Promise<void> {
  await atPoint(point, () => Promise.resolve());
}

/** The deadline `deadline:<job>` sets for a run of `job`, if one is armed. */
export function deadlineFault(job: string): number | undefined {
  const arg = faults.get(`deadline:${job}`)?.arg;
  return arg === undefined || arg === null ? undefined : Number(arg);
}
