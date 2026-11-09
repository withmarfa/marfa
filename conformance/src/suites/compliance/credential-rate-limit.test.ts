import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * What one key may ask of the server in a window, whatever it asks for.
 *
 * **A server of its own, because the claim is about a setting.** The run's
 * shared server boots with limiting off. The number is low on purpose, so a
 * server that ignored the setting would answer every request below alike.
 */
let server: FreshServer;
let unset: FreshServer;

const REQUESTS_LIMIT = 8;
/** Written here, since the chapter names it and a reader takes it from there. */
const DEFAULT_REQUESTS_LIMIT = 4000;

beforeAll(async () => {
  server = await bootFreshServer("credential-rate-limit", {
    MARFA_RATE_LIMIT_ENABLED: "true",
    MARFA_RATE_LIMIT_REQUESTS: String(REQUESTS_LIMIT),
  });
  unset = await bootFreshServer("credential-rate-limit-default", {
    MARFA_RATE_LIMIT_ENABLED: "true",
  });
}, 4 * FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

/** A key whose window nothing else has spent, minted by the working key. */
async function freshKey(on: FreshServer, label: string): Promise<MarfaClient> {
  const minter = new MarfaClient({
    baseUrl: on.apiUrl,
    apiKey: on.workingKey,
  });
  const minted = await minter.createKey({
    label: `rate-cap-${label}`,
    source: `rate-cap-${label}`,
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  return new MarfaClient({ baseUrl: on.apiUrl, apiKey: minted.data.key });
}

describe("a credential's allowance across every operation", () => {
  it("refuses a key past the cap across operations, and counts none of its refused requests against another key", async () => {
    const spent = await freshKey(server, "spent");
    const other = await freshKey(server, "other");

    const operations = [
      () => spent.listItems({ limit: 1 }),
      () => spent.getCurrentKey(),
      () => spent.listTypes(),
      () => spent.listItems({ limit: 1 }),
    ];
    for (let made = 0; made < REQUESTS_LIMIT; made++) {
      const answer = await operations[made % operations.length]!();
      expect(
        answer.status,
        `request ${String(made + 1)} of ${String(REQUESTS_LIMIT)} was refused`,
      ).toBe(200);
    }

    const refused = await spent.listTypes();
    expect(refused.status).toBe(429);
    expect(refused.error?.error.code).toBe("rate_limited");
    const retryAfter = refused.headers.get("Retry-After");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
    expect(
      (refused.error?.error as { details?: { retry_after?: number } }).details
        ?.retry_after,
    ).toBe(Number(retryAfter));

    // The witness: another key is answered, so the refusal is this key's.
    const answered = await other.listItems({ limit: 1 });
    expect(answered.status).toBe(200);
  }, 120_000);

  it("falls back to 4000 when the instance names no number", async () => {
    const client = await freshKey(unset, "default");
    const BATCH = 100;
    for (let made = 0; made < DEFAULT_REQUESTS_LIMIT; made += BATCH) {
      const answers = await Promise.all(
        Array.from({ length: BATCH }, () => client.listItems({ limit: 1 })),
      );
      const refused = answers.filter((answer) => answer.status !== 200);
      expect(
        refused.map((answer) => answer.status),
        `a request under ${String(DEFAULT_REQUESTS_LIMIT)} was refused`,
      ).toEqual([]);
    }
    expect((await client.listItems({ limit: 1 })).status).toBe(429);
  }, 300_000);
});
