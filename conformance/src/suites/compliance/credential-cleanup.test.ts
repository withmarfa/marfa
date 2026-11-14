import { afterAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  startDeviceFlow,
  stopFreshServers,
} from "../../utils/fresh-server.js";
import {
  jobs,
  MINUTE_MS,
  operatorOf,
  QUIET_SCHEDULE,
  runJob,
} from "../../utils/moved-clock.js";

/**
 * The jobs the server lists, and the one job that ends and removes the
 * credentials that have run their course. Each case boots a server of its
 * own, so its listing and its runs are the only ones.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const ALWAYS_LISTED = [
  "audit-cleanup",
  "blob-integrity",
  "blob-replicate",
  "credential-cleanup",
  "enrichment-sweep",
  "event-log-cleanup",
  "feed-expiry",
  "inbound-delivery-cleanup",
  "trash-purge",
  "version-thinning",
];

/** The jobs a server of this contract does not run. */
const NOT_RUN = [
  "auth-session-cleanup",
  "dcr-client-cleanup",
  "grant-inactivity-retirement",
  "rate-limit-cleanup",
  "revoked-grant-purge",
  "revoked-key-reap",
  "webhook-poll",
  "webhook-schedule",
];

describe("the credential clean-up", () => {
  it(
    "removes a device code ten minutes after it expires, and not before",
    async () => {
      const server = await bootFreshServer(
        "credential-cleanup-device-codes",
        QUIET_SCHEDULE,
      );
      const kept = await startDeviceFlow(server, ["core.note:read"]);
      const removed = await startDeviceFlow(server, ["core.note:read"]);
      // Past the ten minutes a code lives, by less than ten more.
      await server.advanceClock(19 * MINUTE_MS);
      expect((await runJob(server, "credential-cleanup")).outcome).toBe("ok");
      expect((await kept.poll()).body.error).toBe("expired_token");
      await server.advanceClock(2 * MINUTE_MS);
      expect((await runJob(server, "credential-cleanup")).outcome).toBe("ok");
      expect((await removed.poll()).body.error).toBe("invalid_grant");
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "lists every job the server runs, and runs the credential clean-up on demand",
    async () => {
      const server = await bootFreshServer(
        "credential-cleanup-listing",
        QUIET_SCHEDULE,
      );
      const operator = operatorOf(server);

      const listed = Object.keys(await jobs(server));
      for (const name of ALWAYS_LISTED) expect(listed, name).toContain(name);

      const run = await runJob(server, "credential-cleanup");
      expect(run.outcome, String(run.error)).toBe("ok");
      expect(run.result).toMatchObject({
        deleted: expect.any(Number),
        retired: expect.any(Number),
      });

      // The witness: a name the server runs is run, and one it does not is not
      // found.
      for (const name of NOT_RUN) {
        expect(listed, name).not.toContain(name);
        const refused = await operator.runHousekeeping(name);
        expect(refused.status, name).toBe(404);
        expect(refused.error?.error.code, name).toBe(
          "housekeeping_job_not_found",
        );
      }
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "finishes the credential clean-up with the retention settings at the largest value",
    async () => {
      const server = await bootFreshServer("credential-cleanup-widest", {
        ...QUIET_SCHEDULE,
        MARFA_REVOKED_GRANT_RETENTION_DAYS: "36500",
        MARFA_GRANT_INACTIVITY_DAYS: "36500",
        MARFA_DCR_CLIENT_RETENTION_HOURS: "876000",
      });
      const run = await runJob(server, "credential-cleanup");
      expect(run.outcome, String(run.error)).toBe("ok");
      expect((await jobs(server))["credential-cleanup"]?.last_outcome).toBe(
        "ok",
      );
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});
