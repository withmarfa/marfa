import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";

/**
 * The cap on the key doors, and what a caller past it is told.
 *
 * **A server of its own, because the claim is about a setting.** The run's
 * shared server boots with limiting off: the suite mints and revokes a key
 * per file and would spend the allowance on the run's own housekeeping.
 * Turning it on there would change every other file's instance, and a
 * fixture that lowered the limit on the shared server would refuse work
 * that has nothing to do with this chapter.
 *
 * **The number is set low on purpose.** A cap the instance did not choose
 * is the one thing this line is about, so the fixture asks for a number no
 * default names and counts to it. A server that ignored the setting would
 * answer every request below alike, because its own cap is two orders of
 * magnitude higher.
 */
let server: FreshServer | undefined;

/** Low enough to reach, and nothing else in the server names it. */
const KEYS_LIMIT = 5;

beforeAll(async () => {
  server = await bootFreshServer("keys-rate-limit", {
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_KEYS_REQUESTS: String(KEYS_LIMIT),
  });
}, 180_000);

afterAll(() => {
  server?.stop();
});

/**
 * A credential with a window of its own.
 *
 * The limiter keys on the credential, so two cases sharing one key would
 * share one budget and the second would read the first's spending. The
 * mint costs the operator key a request from its own window, not from the
 * minted key's.
 */
async function freshKey(label: string): Promise<MarfaClient> {
  const operator = new MarfaClient({
    baseUrl: server!.apiUrl,
    apiKey: server!.operatorKey,
  });
  const minted = await operator.createKey({
    label: `keys-rate-limit-${label}`,
    source: `keys-rate-limit-${label}`,
  });
  expect(
    minted.ok,
    `could not mint the case's own key: ${JSON.stringify(minted.error)}`,
  ).toBe(true);
  return new MarfaClient({ baseUrl: server!.apiUrl, apiKey: minted.data.key });
}

describe("the key doors' rate limit", () => {
  it("refuses past the limit the instance set, and the key doors share one window", async () => {
    const client = await freshKey("limit");

    // One. The header says which cap this request was judged against, so
    // the setting is observable before anything is refused: a server that
    // ignored `RATE_LIMIT_KEYS_REQUESTS` would name its own number here.
    const first = await client.listKeys();
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Limit")).toBe(String(KEYS_LIMIT));

    // Two and three, on the other door. `/keys` and `/keys/{id}` are one
    // budget, not two — the statement says the doors share it, and a
    // fixture spending its whole allowance on one of them would leave
    // that half of the sentence unasserted.
    const minted = await client.createKey({
      label: "spends the window",
      source: "keys-rate-limit-spent",
    });
    expect(minted.status).toBe(201);
    const revoked = await client.revokeKey(minted.data.id);
    expect(revoked.status).toBe(200);

    // Four and five: the allowance runs out exactly where it was set.
    for (const spent of [4, 5]) {
      const answer = await client.listKeys();
      expect(
        answer.status,
        `request ${String(spent)} of ${String(KEYS_LIMIT)} was refused`,
      ).toBe(200);
    }

    const refused = await client.listKeys();
    expect(refused.status).toBe(429);
    expect(refused.error?.error.code).toBe("rate_limited");
    // What to do about it. The limiter's window is fixed rather than
    // sliding, so the wait it names is a real number of seconds and not
    // an invitation to retry immediately.
    const retryAfter = refused.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  }, 120_000);

  it("closes the key doors and no others, on the same credential", async () => {
    // The witness for the case above. Without it, a limiter that had
    // simply stopped answering this credential would satisfy every
    // assertion there, and what the statement claims — that the cap is
    // the key doors' and the rest of the instance keeps its own — would
    // be asserted against nothing.
    const client = await freshKey("scope");

    for (let spent = 1; spent <= KEYS_LIMIT; spent++) {
      const answer = await client.listKeys();
      expect(
        answer.status,
        `request ${String(spent)} of ${String(KEYS_LIMIT)} was refused`,
      ).toBe(200);
    }
    const refused = await client.listKeys();
    expect(refused.status).toBe(429);

    const items = await client.listItems({ limit: 1 });
    expect(
      items.status,
      `a data-plane read was refused too: ${JSON.stringify(items.error)}`,
    ).toBe(200);
  }, 120_000);
});
