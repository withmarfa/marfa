import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { HOUR_MS, movedClock } from "../../utils/moved-clock.js";
import {
  bytesOf,
  clientsFor,
  DISK_ONLY,
  runJob,
} from "../../utils/own-blob-server.js";
import { NEVER_MS, QUIET_TUNING, tuning } from "../../utils/tuning.js";

/**
 * How long an upload that nothing references stands before `blob-orphans`
 * purges it, at the grace the instance starts with: one day,
 * `blob_cleanup_grace_seconds` at its default. The grace is a time a fixture
 * cannot wait out, so the case moves the server's clock through the target
 * interface and runs the job by hand.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("an upload that nothing references, at the default grace", () => {
  let server: FreshServer;
  let operator: MarfaClient;
  let working: MarfaClient;
  let clock: ReturnType<typeof movedClock>;

  beforeAll(async () => {
    server = await bootFreshServer("blob-orphan-grace", {
      ...DISK_ONLY,
      // A blank value counts as unset, so a run's own grace never reaches
      // this server.
      MARFA_BLOB_CLEANUP_GRACE_SECONDS: "",
      ...tuning(...QUIET_TUNING, `interval.blob-orphans=${NEVER_MS}`),
    });
    ({ operator, working } = clientsFor(server));
    clock = movedClock(server);
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  it(
    "stays for a day after its upload, and a run after that day purges it",
    async () => {
      const upload = await working.uploadBlob(
        bytesOf(`nothing names these bytes ${String(Date.now())}`, 100),
        "text/plain",
      );
      expect(upload.status, JSON.stringify(upload.error)).toBe(201);
      const hash = upload.data.hash;

      // The run that finds the upload reports it and purges nothing.
      const first = await runJob<{ reported: number; purged: number }>(
        operator,
        "blob-orphans",
      );
      expect(first.result.purged).toBe(0);
      expect(
        (await operator.listBlobOrphans()).data.data.map((row) => row.hash),
      ).toContain(hash);

      // Most of the day on, a run purges nothing and the bytes still read.
      await clock.advance(23 * HOUR_MS);
      const within = await runJob<{ reported: number; purged: number }>(
        operator,
        "blob-orphans",
      );
      expect(within.result.purged).toBe(0);
      expect((await operator.downloadBlob(hash)).status).toBe(200);

      // Past the day, the same job purges the blob the earlier runs kept.
      await clock.advance(2 * HOUR_MS);
      const past = await runJob<{ reported: number; purged: number }>(
        operator,
        "blob-orphans",
      );
      expect(past.result.purged).toBeGreaterThanOrEqual(1);
      expect((await operator.downloadBlob(hash)).status).toBe(404);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
