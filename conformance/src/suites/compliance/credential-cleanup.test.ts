import { afterAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  startDeviceFlow,
  stopFreshServers,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  jobs,
  MINUTE_MS,
  movedClock,
  operatorOf,
  QUIET_SCHEDULE,
  runJob,
} from "../../utils/moved-clock.js";
import {
  connect,
  issuerOrigin,
  itemsStatus,
  registerApp,
  signIn,
  token,
  type App,
} from "../../utils/signed-in.js";

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
    "keeps a refresh token a refresh rotated past its own expiry while its chain lives, for a revocation and a replay",
    async () => {
      const server = await bootFreshServer(
        "credential-cleanup-rotated-refresh",
        QUIET_SCHEDULE,
      );
      const origin = await issuerOrigin(server);
      const cookie = await signIn(server, origin);
      const scope = "core.note:read offline_access";
      const refresh = (app: App, refreshToken: string) =>
        token(server, {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: app.clientId,
        });
      const granted = async (): Promise<string[]> => {
        const response = await fetch(`${server.apiUrl}/grants`, {
          headers: { authorization: `Bearer ${server.managementKey}` },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          data: { client_id: string }[];
        };
        return body.data.map((grant) => grant.client_id);
      };

      const connected = async () => {
        const app = await registerApp(server, scope);
        const first = await connect(server, origin, cookie, app, scope);
        return { app, first: first.refresh_token!, newest: "" };
      };
      const revoked = await connected();
      const replayed = await connected();
      const witness = await connected();
      const clock = movedClock(server);
      await clock.advance(10 * DAY_MS);
      for (const held of [revoked, replayed, witness]) {
        const renewed = await refresh(held.app, held.first);
        expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
        held.newest = renewed.body.refresh_token!;
      }
      // Past the 30 days the first refresh tokens live, short of the newest.
      await clock.advance(21 * DAY_MS);
      expect((await runJob(server, "credential-cleanup")).outcome).toBe(
        "succeeded",
      );

      // The witness: a chain lives on past its first token's expiry.
      const kept = await refresh(witness.app, witness.newest);
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(await itemsStatus(server, kept.body.access_token!)).toBe(200);

      expect(await granted()).toContain(revoked.app.clientId);
      const answered = await fetch(`${server.apiUrl}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: revoked.first,
          token_type_hint: "refresh_token",
          client_id: revoked.app.clientId,
        }),
      });
      expect(answered.status).toBe(200);
      const afterRevoke = await refresh(revoked.app, revoked.newest);
      expect(afterRevoke.status).toBe(400);
      expect(afterRevoke.body.error).toBe("invalid_grant");
      expect(await granted()).not.toContain(revoked.app.clientId);

      const replay = await refresh(replayed.app, replayed.first);
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");
      const afterReplay = await refresh(replayed.app, replayed.newest);
      expect(afterReplay.status).toBe(400);
      expect(afterReplay.body.error).toBe("invalid_grant");
      expect(await granted()).toContain(replayed.app.clientId);
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );

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
      expect((await runJob(server, "credential-cleanup")).outcome).toBe(
        "succeeded",
      );
      expect((await kept.poll()).body.error).toBe("expired_token");
      await server.advanceClock(2 * MINUTE_MS);
      expect((await runJob(server, "credential-cleanup")).outcome).toBe(
        "succeeded",
      );
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
      expect(run.outcome, String(run.error)).toBe("succeeded");
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
        MARFA_UNAPPROVED_APP_RETENTION_HOURS: "876000",
      });
      const run = await runJob(server, "credential-cleanup");
      expect(run.outcome, String(run.error)).toBe("succeeded");
      expect((await jobs(server))["credential-cleanup"]?.last_outcome).toBe(
        "succeeded",
      );
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});
