import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  HOLD,
  idsWith,
  jobOf,
  queue,
  rowsAndChunk,
  seed,
} from "../../utils/bulk-jobs.js";
import {
  approvedApp,
  refreshedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A signed-in app queues a job and its access token expires while the job is
 * held between two chunks. The token is the app's for an hour; the fixture
 * moves the server's clock past that, so the token stops authenticating at
 * a door and the grant behind it still stands.
 */
let server: FreshServer;
let working: MarfaClient;
let learned: { rows: number; chunk: number };

/** Past the hour an access token lasts. */
const PAST_EXPIRY_MS = 2 * 60 * 60_000;

beforeAll(async () => {
  server = await bootFreshServer("bulk-job-token");
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  learned = await rowsAndChunk(working);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("the job of a signed-in app", () => {
  it("goes on running after the access token that queued it expires, while the grant stands", async () => {
    const tag = "token-expiry";
    await seed(working, tag, learned.rows);
    const app = await approvedApp(server, [
      "core.note:write",
      "offline_access",
    ]);
    const client = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: app.token,
    });

    await server.setFault(HOLD.betweenChunks);
    const id = await queue(client, {
      action: "update_tags",
      add: [`${tag}-done`],
      filter: { tags: [tag] },
    });
    await server.waitForHold(HOLD.betweenChunks);
    const held = await jobOf(client, id);
    expect(held.processed).toBeGreaterThan(0);
    expect(held.processed).toBeLessThan(held.matched);

    // The witness: the token authenticates now, and does not once the clock
    // has passed its expiry, so it is the job that outlives it.
    expect((await client.listItems({ limit: 1 })).status).toBe(200);
    await server.advanceClock(PAST_EXPIRY_MS);
    expect((await client.listItems({ limit: 1 })).status).toBe(401);

    expect(app.refreshToken).toBeDefined();
    const refreshed = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: await refreshedAppToken(server, app.clientId, app.refreshToken!),
    });
    expect((await refreshed.listItems({ limit: 1 })).status).toBe(200);
    expect((await jobOf(refreshed, id)).status).toBe("in_progress");
    await server.clearFault();
    const ended = await refreshed.pollBulkActionToTerminal(id, {
      timeoutMs: 60_000,
    });
    expect(ended).toMatchObject({
      status: "completed",
      matched: learned.rows,
      succeeded: learned.rows,
      errored: 0,
    });
    expect(await idsWith(working, `${tag}-done`)).toHaveLength(learned.rows);
  }, 180_000);
});
