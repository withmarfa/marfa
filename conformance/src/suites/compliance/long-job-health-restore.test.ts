import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import { itemsArchive } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";

/**
 * `GET /health` answered while an archive restore runs, between its first
 * and its last row (`instance/long-job-health`).
 *
 * **The witness is an order the target records.** The restore is held before
 * its first row, with a second hold armed before it commits. A `release`
 * fault clears the first hold as the target admits `GET /health`, and records
 * which holds had a caller waiting when that request answered.
 *
 * A restore holds the write lock from its first row to its commit, so the
 * write probe cannot commit while it is held: `/health` is asked once then,
 * and the probe's attempt ends `degraded` within the write wait, which is set
 * shorter than the time `/health` waits on the probe. That outcome answers the
 * calls of the next ten seconds, so the request the release admits waits on
 * no write.
 */
let server: FreshServer;

/** Notes enough that the restore has dozens of steps between its two holds. */
const ROWS = 4_000;
const TAG = "long-job-health-restore";

function owner(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
}

async function health(): Promise<void> {
  const answer = await fetch(`${server.apiUrl}/health`);
  await answer.arrayBuffer();
  expect(answer.status).toBe(200);
}

beforeAll(async () => {
  server = await bootFreshServer("long-job-health-restore", {
    ...DISK_ONLY,
    MARFA_WRITE_WAIT_MS: "500",
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("GET /health while an archive restore runs", () => {
  it("is answered between the first and the last row of an archive restore", async () => {
    const start = "hold:restore:item";
    const later = "hold:restore:before-commit";
    const release = "release:restore:item";
    let restoring: ReturnType<MarfaClient["restoreArchive"]> | undefined;
    let finished = false;
    try {
      await server.setFault(`${start}=1`);
      await server.setFault(later);
      const source = `${TAG}-${uuidv7()}`;
      restoring = owner().restoreArchive(
        itemsArchive(
          Array.from({ length: ROWS }, (_, index) => ({
            id: uuidv7(),
            type: "core.note",
            source,
            properties: { body: `restored ${String(index)}` },
          })),
          [{ data: randomBytes(64), mime_type: "application/octet-stream" }],
        ),
      );
      await server.waitForHold(start);
      await health();
      await server.setFault(release);
      await health();
      const recorded = (await server.faults()).find(
        (fault) => fault.name === release,
      );
      expect(recorded?.fired, `${release} released the restore`).toBe(1);
      expect(recorded?.held_when_answered, "/health answered").toEqual([]);
      // The witness that the later hold is on the restore's path.
      await server.waitForHold(later);
      await server.clearFault();
      const restored = await restoring;
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.imported).toBe(ROWS);
      finished = true;
    } finally {
      await server.clearFault();
      if (!finished && restoring !== undefined) await restoring.catch(() => {});
    }
  }, 600_000);
});
