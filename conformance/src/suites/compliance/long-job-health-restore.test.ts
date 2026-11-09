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
import { heldWhenHealthAnswered } from "../../utils/held-when-answered.js";

/**
 * `GET /health` answered while an archive restore runs, between its first
 * and its last row (`instance/long-job-health`); `heldWhenHealthAnswered`
 * says how the order is witnessed.
 *
 * A restore holds the write lock from its first row to its commit, so the
 * write probe cannot commit while it is held. The write wait is set shorter
 * than the time `/health` waits on the probe, so the probe's attempt during
 * the hold ends `degraded` and answers the calls of the next ten seconds, and
 * the request the release admits waits on no write.
 */
let server: FreshServer;

/** Notes enough that the restore has dozens of steps between its two holds. */
const ROWS = 4_000;
const TAG = "long-job-health-restore";

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
    // The restore waits before its first row, once the blob is placed, and
    // again with every row written, before it commits.
    const held = await heldWhenHealthAnswered(server, {
      start: "hold:restore:item=1",
      later: "hold:restore:before-commit",
      begin: async () => {
        const source = `${TAG}-${uuidv7()}`;
        const archive = itemsArchive(
          Array.from({ length: ROWS }, (_, index) => ({
            id: uuidv7(),
            type: "core.note",
            source,
            properties: { body: `restored ${String(index)}` },
          })),
          [{ data: randomBytes(64), mime_type: "application/octet-stream" }],
        );
        const restoring = new MarfaClient({
          baseUrl: server.apiUrl,
          controlSocket: server.controlSocket,
        }).restoreArchive(archive);
        return async () => {
          const restored = await restoring;
          expect(restored.status, JSON.stringify(restored.error)).toBe(200);
          expect(restored.data.imported).toBe(ROWS);
        };
      },
    });
    expect(held).toEqual([]);
  }, 600_000);
});
