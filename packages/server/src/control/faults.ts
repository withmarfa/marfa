/**
 * The faults a conformance harness sets on a running server, held in memory.
 * They are set and cleared only through the routes in `test-routes.ts`, which
 * exist only under `MARFA_TEST_HOOKS`, so on every other server the table
 * stays empty and each fault point below returns at once, after one read of
 * the table's size.
 *
 * A fault is named for what it does and where it acts, and every point a
 * fault may name is declared once, in {@link POINTS}:
 *
 * - `hold:<point>` makes the server wait at the point until the fault is
 *   cleared.
 * - `fail:<point>` makes the server fail at the point, once: on the nth time
 *   the point is reached after the fault was set (the first, unless the
 *   argument says another). The fault stays in the table afterwards with its
 *   `fired` count, so a fixture can tell that it acted, and is cleared like
 *   any other. A write point may name the audit action of the write it
 *   counts, as `items.bulk@2`, so a request that makes other writes first
 *   does not shift the count.
 * - `deadline:<job>=<ms>` shortens the run deadline of that job.
 * - `free:<volume>=<bytes>` makes the server read that many bytes of free
 *   space on the volume (`database` or `blobs`) from now until the fault is
 *   cleared or set again. Setting it again while a body streams in is how
 *   a volume fills as the bytes arrive.
 * - `unfold-deadline=<ms>` shortens the time one series may take to unfold.
 * - `resolve:<hostname>=<answers>` makes an outbound webhook delivery resolve
 *   that name to scripted addresses. `<answers>` is one answer per lookup,
 *   separated by `;`, each a list of addresses separated by `,`; the last
 *   answer repeats, and `fired` counts the lookups answered. The delivery
 *   checks the addresses an answer names as it does a real answer. An
 *   address may be written `<checked>><connected>`: the check judges the
 *   first, and the socket connects to the second, so a fixture can have a
 *   public address reach a receiver on loopback.
 *
 * The routes refuse a name that answers to no point, an argument the point
 * does not take, and a job the scheduler has not registered, so a typo cannot
 * pass for an armed fault.
 *
 * Nothing persists: a restart starts with no fault.
 */

import ipaddr from "ipaddr.js";

/** What follows `=` in the name of a fault, by the point it is set on. */
type ArgShape =
  /** No argument. */
  | "none"
  /** `<n>`: the nth time the point is reached. */
  | "nth"
  /** `<n>`, `<action>` or `<action>@<n>`: the nth write that records the audit action. */
  | "write";

interface Point {
  /** The text after `hold:` or `fail:`; `<job>` stands for a housekeeping job's name. */
  name: string;
  arg: ArgShape;
}

/** Every point a fault may name. */
export const POINTS: {
  hold: readonly Point[];
  fail: readonly Point[];
} = {
  hold: [
    { name: "housekeeping:<job>", arg: "none" },
    { name: "version-thinning:item", arg: "none" },
    { name: "blob-orphans:purge", arg: "none" },
    { name: "restore:before-commit", arg: "none" },
    { name: "stream-open", arg: "none" },
    { name: "stream-head", arg: "none" },
    { name: "stream-replay", arg: "none" },
    { name: "stream-drain", arg: "none" },
    { name: "announce", arg: "none" },
    { name: "read-snapshot", arg: "none" },
    { name: "webhook-schedule:queued", arg: "none" },
  ],
  fail: [
    { name: "lock", arg: "nth" },
    { name: "audit", arg: "write" },
    { name: "commit", arg: "write" },
    { name: "commit-full", arg: "write" },
    { name: "commit-ack", arg: "write" },
    { name: "inbound-receipt", arg: "nth" },
    { name: "inbound-cleanup", arg: "nth" },
    { name: "export-read", arg: "nth" },
    { name: "blob-read", arg: "nth" },
    { name: "blob-read-short", arg: "nth" },
    { name: "blob-write", arg: "nth" },
    { name: "blob-delete", arg: "nth" },
    { name: "housekeeping:<job>", arg: "nth" },
    { name: "job-row", arg: "nth" },
    { name: "stream-head", arg: "nth" },
    { name: "stream-replay", arg: "nth" },
    { name: "stream-credential", arg: "nth" },
    { name: "stream-replay-row", arg: "nth" },
    { name: "edge-source-type", arg: "nth" },
  ],
};

/**
 * Housekeeping jobs that run no database statement, so a `fail` fault on one
 * could only be counted and never act.
 */
const JOBS_WITHOUT_STATEMENTS: readonly string[] = ["heartbeat"];

/** The volumes a `free` fault may name. */
const VOLUMES = ["database", "blobs"] as const;
export type Volume = (typeof VOLUMES)[number];

const JOB_SLOT = "<job>";
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const JOB_NAME = /^[a-z][a-z0-9-]*$/;
const ACTION = /^[a-z][a-z0-9_.-]*$/;
/** The longest delay a timer takes. */
const MAX_DEADLINE_MS = 2_147_483_647;
const MAX_NTH = 1_000_000;

export interface ActiveFault {
  name: string;
  arg: string | null;
  /** How many callers are waiting at a `hold` fault now. */
  waiting: number;
  /** How many times a `fail` fault has acted. */
  fired: number;
}

/** Which reach of a `fail` point acts. */
interface Target {
  action: string | undefined;
  nth: number;
}

interface Entry {
  arg: string | null;
  release: Set<() => void>;
  /** For a `fail` fault: how it is aimed, and how many reaches it has counted. */
  target: Target | undefined;
  seen: number;
  fired: number;
}

const faults = new Map<string, Entry>();

/** The point a name addresses, and the job it names if it names one. */
function declared(
  kind: "hold" | "fail",
  text: string,
): { point: Point; job: string | undefined } | undefined {
  for (const point of POINTS[kind]) {
    if (!point.name.endsWith(JOB_SLOT)) {
      if (point.name === text) return { point, job: undefined };
    } else {
      const stem = point.name.slice(0, -JOB_SLOT.length);
      if (text.startsWith(stem) && JOB_NAME.test(text.slice(stem.length)))
        return { point, job: text.slice(stem.length) };
    }
  }
  return undefined;
}

function nth(text: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(text)) return undefined;
  const value = Number(text);
  return value <= MAX_NTH ? value : undefined;
}

/** How a `fail` fault is aimed, or why its argument is refused. */
function aim(point: Point, arg: string | null): Target | string {
  if (arg === null) return { action: undefined, nth: 1 };
  if (point.arg === "none") return `${point.name} takes no argument`;
  const whole = nth(arg);
  if (whole !== undefined) return { action: undefined, nth: whole };
  if (point.arg !== "write")
    return `${point.name} takes the number of the time it acts, from 1`;
  const at = arg.lastIndexOf("@");
  const action = at < 0 ? arg : arg.slice(0, at);
  const count = at < 0 ? 1 : nth(arg.slice(at + 1));
  if (!ACTION.test(action) || count === undefined)
    return `${point.name} takes <n>, <action> or <action>@<n>`;
  return { action, nth: count };
}

/** An address a `resolve` fault may script. */
function isAddress(text: string): boolean {
  return ipaddr.IPv4.isValidFourPartDecimal(text) || ipaddr.IPv6.isValid(text);
}

/** What one lookup of a scripted name is answered with. */
export interface ScriptedAnswer {
  /** The addresses the delivery's check judges. */
  checked: string[];
  /** The addresses its socket connects to; the checked ones unless scripted. */
  connected: string[];
}

/** The answers a `resolve` argument scripts, or undefined where it is not one. */
function answers(arg: string | null): ScriptedAnswer[] | undefined {
  if (arg === null || arg === "") return undefined;
  const steps: ScriptedAnswer[] = [];
  for (const step of arg.split(";")) {
    const answer: ScriptedAnswer = { checked: [], connected: [] };
    for (const item of step.split(",")) {
      const [checked, connected, ...extra] = item.split(">");
      if (
        extra.length > 0 ||
        checked === undefined ||
        !isAddress(checked) ||
        (connected !== undefined && !isAddress(connected))
      )
        return undefined;
      answer.checked.push(checked);
      answer.connected.push(connected ?? checked);
    }
    steps.push(answer);
  }
  return steps;
}

function shapeProblem(name: string, arg: string | null): string | undefined {
  const colon = name.indexOf(":");
  const kind = colon < 0 ? name : name.slice(0, colon);
  const rest = colon < 0 ? "" : name.slice(colon + 1);
  if (kind === "hold" || kind === "fail") {
    const found = declared(kind, rest);
    if (found === undefined) return `no ${kind} point is named ${rest}`;
    if (kind === "hold")
      return arg === null ? undefined : "a hold fault takes no argument";
    const target = aim(found.point, arg);
    return typeof target === "string" ? target : undefined;
  }
  if (kind === "deadline") {
    if (!JOB_NAME.test(rest)) return `${rest} is not a job name`;
    const ms = arg === null ? Number.NaN : Number(arg);
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_DEADLINE_MS)
      return "a deadline fault takes a whole number of milliseconds from 1";
    return undefined;
  }
  if (kind === "free") {
    if (!VOLUMES.includes(rest as Volume))
      return `${rest} is not a volume: ${VOLUMES.join(" or ")}`;
    const bytes = arg === null ? Number.NaN : Number(arg);
    if (!/^[0-9]+$/.test(arg ?? "") || !Number.isSafeInteger(bytes))
      return "a free fault takes a whole number of bytes";
    return undefined;
  }
  if (name === "unfold-deadline") {
    const ms = arg === null ? Number.NaN : Number(arg);
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_DEADLINE_MS)
      return "an unfold-deadline fault takes a whole number of milliseconds from 1";
    return undefined;
  }
  if (kind === "resolve") {
    if (!HOST_NAME.test(rest)) return `${rest} is not a host name`;
    return answers(arg) === undefined
      ? "a resolve fault takes addresses: one answer per lookup, separated by ;, each a list of addresses separated by ,"
      : undefined;
  }
  return "a fault is named hold:<point>, fail:<point>, deadline:<job>, free:<volume>, unfold-deadline or resolve:<hostname>";
}

/**
 * Why a fault name or argument is refused, or `undefined` when it is valid.
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
  if (name === "unfold-deadline") return undefined;
  const colon = name.indexOf(":");
  const kind = name.slice(0, colon);
  const rest = name.slice(colon + 1);
  const job =
    kind === "deadline"
      ? rest
      : kind === "hold" || kind === "fail"
        ? declared(kind, rest)?.job
        : undefined;
  if (job !== undefined && !jobs.includes(job))
    return `no housekeeping job is named ${job}`;
  if (
    kind === "fail" &&
    job !== undefined &&
    JOBS_WITHOUT_STATEMENTS.includes(job)
  )
    return `the ${job} job runs no database statement to fail`;
  return undefined;
}

/** Arms a fault of a valid shape; the routes check the job. Setting a name again replaces its argument and keeps its waiters. */
export function setFault(name: string, arg: string | null): void {
  const problem = shapeProblem(name, arg);
  if (problem !== undefined) throw new RangeError(problem);
  const point = name.startsWith("fail:")
    ? declared("fail", name.slice(5))?.point
    : undefined;
  const target = point === undefined ? undefined : aim(point, arg);
  const aimed = typeof target === "object" ? target : undefined;
  const existing = faults.get(name);
  if (existing) {
    existing.arg = arg;
    existing.target = aimed;
    existing.seen = 0;
    existing.fired = 0;
  } else
    faults.set(name, {
      arg,
      release: new Set(),
      target: aimed,
      seen: 0,
      fired: 0,
    });
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
    fired: entry.fired,
  }));
}

/** Whether any fault is set. A server without the hooks never has one. */
export function faultsArmed(): boolean {
  return faults.size > 0;
}

/**
 * Whether `hold:<point>` is armed. For a caller that would otherwise add an
 * await or a queued task of its own to reach {@link holdAt}, so that a fault
 * set on another point does not change the order of its work.
 */
export function holdArmed(point: string): boolean {
  return faults.size > 0 && faults.has(`hold:${point}`);
}

/**
 * Whether `fail:<point>` acts now. Each call counts one reach of the point
 * for a fault set on it, and the fault acts on the reach it is aimed at, and
 * on no other. A fault aimed at an audit action counts only the reaches made
 * with that action. A reach made with `counted` false does not add to
 * `fired`; the caller does that with {@link recordFired} when the failure
 * happens.
 */
export function failAt(
  point: string,
  action?: string,
  counted = true,
): boolean {
  if (faults.size === 0) return false;
  const entry = faults.get(`fail:${point}`);
  if (entry?.target === undefined) return false;
  if (entry.target.action !== undefined && entry.target.action !== action)
    return false;
  entry.seen += 1;
  if (entry.seen !== entry.target.nth) return false;
  if (counted) entry.fired += 1;
  return true;
}

/**
 * Takes back the reach of a statement fault whose scope ran no statement, so
 * the fault waits for a reach that can fail instead of passing for one that
 * did. The count of what acted is {@link recordFired}'s.
 */
export function forgetReach(point: string): void {
  const entry = faults.get(`fail:${point}`);
  if (entry !== undefined && entry.seen > 0) entry.seen -= 1;
}

/** See {@link forgetReach}. */
export function recordFired(point: string): void {
  const entry = faults.get(`fail:${point}`);
  if (entry !== undefined) entry.fired += 1;
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

/** The free space `free:<volume>` makes the server read, if one is armed. */
export function freeFault(volume: Volume): number | undefined {
  if (faults.size === 0) return undefined;
  const arg = faults.get(`free:${volume}`)?.arg;
  return arg === undefined || arg === null ? undefined : Number(arg);
}

/** The time `unfold-deadline` allows one series to unfold, if it is armed. */
export function unfoldDeadlineFault(): number | undefined {
  const arg = faults.get("unfold-deadline")?.arg;
  return arg === undefined || arg === null ? undefined : Number(arg);
}

/**
 * The answer the next lookup of `hostname` is to be given, if a `resolve`
 * fault scripts it. Each call takes the next answer, and the last repeats.
 */
export function scriptedAnswer(hostname: string): ScriptedAnswer | undefined {
  if (faults.size === 0) return undefined;
  const entry = faults.get(`resolve:${hostname.toLowerCase()}`);
  const steps = entry === undefined ? undefined : answers(entry.arg);
  if (entry === undefined || steps === undefined) return undefined;
  const answer = steps[Math.min(entry.fired, steps.length - 1)];
  entry.fired += 1;
  return answer;
}
