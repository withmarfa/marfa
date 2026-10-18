import { expect } from "vitest";
import { MarfaClient } from "../client/api.js";
import type { HousekeepingJobRow, HousekeepingRun } from "../client/types.js";
import type { FreshServer } from "./fresh-server.js";

/**
 * What a fixture that moves a server's clock shares: clients over a fresh
 * server's current address, a housekeeping run that waits out the scheduler,
 * and the settings that keep the scheduler from running a job the fixture
 * did not ask for.
 */

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** An interval no clock a fixture reaches gets past. */
const NEVER_MS = "3153600000000";

/**
 * Every cleanup job's own interval set past reach. Moving the clock makes a
 * job whose schedule has passed due, and the scheduler would then run it
 * beside the fixture's own run, so each job is run once at the start
 * (`quiet`) and its next run is set from that.
 */
export const QUIET_SCHEDULE: Record<string, string> = {
  AUDIT_CLEANUP_INTERVAL_MS: NEVER_MS,
  TRASH_PURGE_INTERVAL_MS: NEVER_MS,
  MARFA_EVENT_LOG_CLEANUP_INTERVAL_MS: NEVER_MS,
  MARFA_INBOUND_CLEANUP_INTERVAL_MS: NEVER_MS,
  VERSION_THINNING_INTERVAL_MS: NEVER_MS,
  FEED_EXPIRY_INTERVAL_MS: NEVER_MS,
};

export const operatorOf = (server: FreshServer): MarfaClient =>
  new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.managementKey });

export const writerOf = (server: FreshServer): MarfaClient =>
  new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });

/**
 * Runs a housekeeping job with the operator's key and answers the run.
 * A job the scheduler has started is refused `409 housekeeping_job_running`,
 * so the request is made again until the earlier run has ended.
 */
export async function runJob(
  server: FreshServer,
  name: string,
  budgetMs = 60_000,
): Promise<HousekeepingRun> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const run = await operatorOf(server).runHousekeeping(name);
    if (run.status === 200) return run.data;
    expect(run.error?.error.code, `${name}: ${JSON.stringify(run.error)}`).toBe(
      "housekeeping_job_running",
    );
    if (Date.now() > deadline) {
      throw new Error(`${name} was still running ${String(budgetMs)}ms on`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Runs each job once and waits until its next run is out of reach. A run
 * asked for ahead of schedule leaves the schedule where it was (the job's
 * first run is some seconds after boot), so the scheduler still makes that
 * first run itself, and only after it is the next run an interval away.
 */
export async function quiet(
  server: FreshServer,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    expect((await runJob(server, name)).outcome, name).toBe("ok");
  }
  const deadline = Date.now() + 60_000;
  for (;;) {
    const listed = await jobs(server);
    const due = names.filter(
      (name) =>
        Date.parse(listed[name]?.next_run_at ?? "") < Date.now() + DAY_MS,
    );
    if (due.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${due.join(", ")} still due within a day after a minute`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The housekeeping listing, by job name. */
export async function jobs(
  server: FreshServer,
): Promise<Record<string, HousekeepingJobRow>> {
  const listed = await operatorOf(server).listHousekeeping();
  expect(listed.status).toBe(200);
  return Object.fromEntries(listed.data.data.map((row) => [row.name, row]));
}

/**
 * Tracks the server's clock for a fixture that has moved it, so the fixture
 * can say what time the server reads. The offset is the sum of the steps;
 * it is exact to the milliseconds the two clocks differ by, which on one
 * machine is none.
 */
export function movedClock(server: FreshServer): {
  advance(ms: number): Promise<void>;
  now(): number;
} {
  let offset = 0;
  return {
    async advance(ms) {
      await server.advanceClock(ms);
      offset += ms;
    },
    now: () => Date.now() + offset,
  };
}

/** Something done at a time, given as how long before the end of the
 *  timeline it happens. */
export interface Moment {
  before: number;
  run(): Promise<void>;
}

/**
 * Plays a history out on a server whose clock only goes forward: each moment
 * is run once the clock stands `before` ms short of the end, the earliest
 * first, and the clock is then moved to the end, the instant the job under
 * test runs. A moment's `before` is the age it has at the end, so a fixture
 * writes the ages it means rather than the steps between them.
 *
 * Real time passes between steps and the clock follows it, so each age is a
 * little more than the one written. A fixture that stamps a record "at" a
 * retention relies on that: it is past the retention when the job runs.
 */
export async function playOut(
  clock: ReturnType<typeof movedClock>,
  moments: readonly Moment[],
): Promise<void> {
  const ordered = [...moments].sort((a, b) => b.before - a.before);
  let at = ordered[0]?.before ?? 0;
  for (const moment of ordered) {
    if (at > moment.before) await clock.advance(at - moment.before);
    at = moment.before;
    await moment.run();
  }
  if (at > 0) await clock.advance(at);
}
