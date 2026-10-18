import { afterAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  jobs,
  movedClock,
  operatorOf,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";

/**
 * What the schedule does across a restart and what a run that does not finish
 * leaves behind. A restart is the target interface's `restart`; a run held
 * open and a shortened deadline are its faults.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

/** A job that does nothing of consequence on a fresh instance, and whose
 *  first run is a minute after boot, so the scheduler leaves it to the case. */
const PROBE = "bulk-action-gc";
const OTHER_PROBE = "blob-integrity";

const HELD = (name: string) => `hold:housekeeping:${name}`;

/** Starts a run the fixture does not wait on: the answer, if it comes, is
 *  the job's record. */
function startRun(server: FreshServer, name: string): Promise<Response> {
  return fetch(`${server.apiUrl}/housekeeping/${name}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.managementKey}` },
  });
}

describe("the schedule across a restart", () => {
  it(
    "does not move a job's next_run_at later than it was",
    async () => {
      const server = await bootFreshServer("housekeeping-restart");
      try {
        // One job has run, so its schedule is an interval from its finish; the
        // rest have not, so theirs is a delay from the first boot.
        expect((await runJob(server, OTHER_PROBE)).outcome).toBe("ok");
        for (const signal of ["SIGTERM", "SIGKILL"] as const) {
          const before = await jobs(server);
          await server.restart({ signal });
          const after = await jobs(server);

          let compared = 0;
          for (const [name, row] of Object.entries(before)) {
            const now = after[name];
            // A job that ran in between has a schedule of its own.
            if (
              now === undefined ||
              now.last_finished_at !== row.last_finished_at
            )
              continue;
            compared += 1;
            expect(
              Date.parse(now.next_run_at),
              `${name} after a ${signal} restart`,
            ).toBeLessThanOrEqual(Date.parse(row.next_run_at));
          }
          // The witness: the comparison covered the job that ran and the
          // jobs that had not.
          expect(compared).toBeGreaterThanOrEqual(10);
          expect(before[OTHER_PROBE]?.last_finished_at).not.toBeNull();
          expect(after[OTHER_PROBE]?.last_finished_at).toBe(
            before[OTHER_PROBE]?.last_finished_at,
          );
        }
      } finally {
        await server.stop();
      }
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a run the last process left unfinished", () => {
  it(
    "is cleared when the server starts, and the job runs again when asked",
    async () => {
      const server = await bootFreshServer("housekeeping-unfinished");
      try {
        const held = [PROBE, OTHER_PROBE];
        for (const name of held) await server.setFault(HELD(name));
        const runs = held.map((name) =>
          startRun(server, name).catch(() => undefined),
        );
        for (const name of held) await server.waitForHold(HELD(name));
        const running = await jobs(server);
        for (const name of held) {
          expect(running[name]?.running_since, name).not.toBeNull();
        }
        // The witness: a run in the middle of its work refuses a second.
        const refused = await operatorOf(server).runHousekeeping(PROBE);
        expect(refused.status).toBe(409);
        expect(refused.error?.error.code).toBe("housekeeping_job_running");

        await server.restart({ signal: "SIGKILL" });
        await Promise.all(runs);

        // Only the jobs held before the kill: the scheduler's first pass may
        // have started another job whose run is legitimately under way.
        const after = await jobs(server);
        for (const name of held) {
          expect(after[name]?.running_since, name).toBeNull();
        }
        expect(await server.faults()).toEqual([]);
        for (const name of held) {
          expect((await runJob(server, name)).outcome, name).toBe("ok");
        }
      } finally {
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a run that outlives its deadline", () => {
  const SHORT = "deadline:" + PROBE + "=300";

  it(
    "is recorded with last_outcome error and a last_error saying it did not finish in time",
    async () => {
      const server = await bootFreshServer(
        "housekeeping-deadline",
        QUIET_SCHEDULE,
      );
      try {
        // The witness: with the deadline shortened and nothing holding the
        // run, the job finishes inside it.
        await server.setFault(SHORT);
        expect((await runJob(server, PROBE)).outcome).toBe("ok");

        await server.setFault(HELD(PROBE));
        const run = await runJob(server, PROBE);
        expect(run).toMatchObject({
          name: PROBE,
          outcome: "error",
          result: null,
        });
        expect(run.error).toMatch(/did not finish/);

        const row = (await jobs(server))[PROBE];
        expect(row).toMatchObject({
          running_since: null,
          last_outcome: "error",
          last_result: null,
        });
        expect(row?.last_error).toMatch(/did not finish/);
      } finally {
        await server.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "frees the job, so it runs again when asked rather than answering 409 housekeeping_job_running",
    async () => {
      const server = await bootFreshServer("housekeeping-deadline-frees");
      try {
        await server.setFault(HELD(PROBE));
        await server.setFault(`deadline:${PROBE}=8000`);
        const first = startRun(server, PROBE);
        await server.waitForHold(HELD(PROBE));

        // The witness: inside its deadline the run holds the job.
        const refused = await operatorOf(server).runHousekeeping(PROBE);
        expect(refused.status).toBe(409);
        expect(refused.error?.error.code).toBe("housekeeping_job_running");

        // Past it, the job runs again, although the first run is held still.
        const ended = await first;
        expect(ended.status).toBe(200);
        expect(((await ended.json()) as { outcome: string }).outcome).toBe(
          "error",
        );
        await server.setFault(`deadline:${PROBE}=300`);
        const again = await operatorOf(server).runHousekeeping(PROBE);
        expect(again.status, JSON.stringify(again.error)).toBe(200);
        expect(again.data.outcome).toBe("error");
        expect((await jobs(server))[PROBE]?.running_since).toBeNull();
        expect(
          (await server.faults()).find((f) => f.name === HELD(PROBE))?.waiting,
        ).toBe(2);
      } finally {
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "does not record what the run finishes with if it later finishes",
    async () => {
      const server = await bootFreshServer(
        "housekeeping-deadline-late",
        QUIET_SCHEDULE,
      );
      try {
        const writer = writerOf(server);
        await quiet(server, ["trash-purge"]);
        const config = (await writer.getConfig()).data as Record<
          string,
          unknown
        >;
        const set = await writer.updateConfig({
          ...config,
          trash_retention_days: 1,
        });
        expect(set.status, JSON.stringify(set.error)).toBe(200);

        const binned = async (id: string): Promise<boolean> => {
          const listed = await writer.listItems({ state: "trashed" });
          expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
          return listed.data.data.some((item) => item.id === id);
        };
        const bin = async (body: string): Promise<string> => {
          const created = await writer.createItem({
            type: "core.note",
            properties: { body },
          });
          expect(created.ok, JSON.stringify(created.error)).toBe(true);
          expect((await writer.deleteItem(created.data.item.id)).ok).toBe(true);
          return created.data.item.id;
        };
        const clock = movedClock(server);
        const doomed = await bin("late");
        await clock.advance(2 * DAY_MS);
        expect(await binned(doomed)).toBe(true);

        await server.setFault(HELD("trash-purge"));
        await server.setFault("deadline:trash-purge=300");
        const run = await runJob(server, "trash-purge");
        expect(run.outcome).toBe("error");
        const recorded = (await jobs(server))["trash-purge"];
        expect(recorded).toMatchObject({
          last_outcome: "error",
          last_result: null,
        });
        // Held at its start: the sweep has not run.
        expect(await binned(doomed)).toBe(true);

        // Let the run go. It finishes its sweep and purges the item.
        await server.clearFault();
        const deadline = Date.now() + 20_000;
        while ((await binned(doomed)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(await binned(doomed), "the run never finished").toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Nothing it finished with is the job's record.
        expect((await jobs(server))["trash-purge"]).toEqual(recorded);

        // The witness: a run that finishes in time records what it did.
        const next = await bin("in time");
        await clock.advance(2 * DAY_MS);
        const ok = await runJob(server, "trash-purge");
        expect(ok).toMatchObject({ outcome: "ok", result: { deleted: 1 } });
        expect(await binned(next)).toBe(false);
        expect((await jobs(server))["trash-purge"]).toMatchObject({
          last_outcome: "ok",
          last_result: { deleted: 1 },
        });
      } finally {
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );
});
