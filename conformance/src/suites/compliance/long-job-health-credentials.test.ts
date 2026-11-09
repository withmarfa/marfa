import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  audited,
  heldWhenHealthAnswered,
} from "../../utils/held-when-answered.js";
import {
  DAY_MS,
  operatorOf,
  QUIET_SCHEDULE,
  runJob,
} from "../../utils/moved-clock.js";
import {
  connect,
  issuerOrigin,
  registerApp,
  signIn,
} from "../../utils/signed-in.js";

/**
 * `GET /health` answered while the credential clean-up retires inactive
 * grants (`instance/long-job-health`), on a server of its own, since the case
 * moves the clock a year.
 */
let server: FreshServer;

/**
 * Grants enough that their retirement takes many steps, in one run: a run
 * retires at most 500.
 */
const GRANTS = 60;
const NOTES = "core.note:read";

beforeAll(async () => {
  server = await bootFreshServer("long-job-health-credentials", QUIET_SCHEDULE);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("GET /health while the credential clean-up runs", () => {
  it("is answered between two grants of the retirement of inactive grants", async () => {
    const job = "credential-cleanup";
    const action = "auth.grant.retired";
    // One sign-in for every grant: the owner's address may make ten
    // password attempts in fifteen minutes.
    const origin = await issuerOrigin(server);
    const cookie = await signIn(server, origin);
    for (let made = 0; made < GRANTS; made += 10) {
      await Promise.all(
        Array.from({ length: 10 }, async () =>
          connect(
            server,
            origin,
            cookie,
            await registerApp(server, NOTES),
            NOTES,
          ),
        ),
      );
    }
    const before = await audited(server, action);

    const held = await heldWhenHealthAnswered(server, {
      start: `hold:housekeeping:${job}`,
      // Each grant's retirement is a write of its own, after a turn: the last.
      later: `hold:write=${action}@${String(GRANTS)}`,
      begin: async () => {
        // The move makes the job due, and the scheduler may start it before
        // this request does: either run waits at the hold.
        await server.advanceClock(366 * DAY_MS);
        const retiring = operatorOf(server).runHousekeeping(job);
        return async () => {
          const asked = await retiring;
          if (asked.status !== 200) {
            expect(asked.error?.error.code).toBe("housekeeping_job_running");
            await runJob(server, job);
          }
          expect((await audited(server, action)) - before).toBe(GRANTS);
        };
      },
    });
    expect(held).toEqual([]);
  }, 900_000);
});
