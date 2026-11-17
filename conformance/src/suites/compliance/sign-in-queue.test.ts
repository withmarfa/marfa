import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * The queue a password check from no known device waits in
 * (`keys-and-oauth/sign-in-decoy-queue`). It has a server of its own that
 * believes a header for the caller's address, so each sign-in comes from an
 * address of its own and no limit on one address or one email can be what
 * refuses it.
 */
let server: FreshServer;
let origin: string;
let addresses = 0;
let spent: FreshServer;
let spentOrigin: string;
let spentAddresses = 0;

const CLIENT_HEADER = "x-conformance-client";

beforeAll(async () => {
  [server, spent] = await Promise.all(
    ["sign-in-queue", "sign-in-queue-spent"].map((name) =>
      bootFreshServer(name, {
        MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
        MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
      }),
    ),
  );
  origin = new URL(server.apiUrl).origin;
  spentOrigin = new URL(spent.apiUrl).origin;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

function signIn(email: string): Promise<Response> {
  addresses += 1;
  return fetch(`${server.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      [CLIENT_HEADER]: `198.51.100.${String(addresses)}`,
    },
    body: JSON.stringify({ email, password: "not the password" }),
  });
}

/** A wrong password at `email` on the server whose shared hour is spent, from an address of its own. */
function signInPastTheHour(email: string): Promise<Response> {
  spentAddresses += 1;
  return fetch(`${spent.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: spentOrigin,
      [CLIENT_HEADER]: `10.20.${String(spentAddresses >> 8)}.${String(spentAddresses & 255)}`,
    },
    body: JSON.stringify({ email, password: "not the password" }),
  });
}

async function timed(answers: Promise<Response>[]): Promise<number[]> {
  const statuses: number[] = [];
  for (const answer of await Promise.all(answers)) {
    expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(15 * 60);
    statuses.push(answer.status);
    await answer.body?.cancel();
  }
  return statuses;
}

describe("password sign-ins that carry no known device cookie", () => {
  it("answers a sign-in 429 with Retry-After once the queue of waiting checks is full, at any email, and answers one alone 401", async () => {
    // The witness: one at a time, a wrong password at either kind of email
    // is answered 401, so the 429s below come from the wait.
    for (let n = 0; n < 20; n++) {
      const alone = await signIn(
        n % 2 === 0 ? TEST_OWNER.email : `stranger-alone-${String(n)}@a.test`,
      );
      expect(alone.status).toBe(401);
      await alone.body?.cancel();
    }

    const emails = Array.from({ length: 60 }, (_, n) =>
      n % 2 === 0 ? TEST_OWNER.email : `stranger-${String(n)}@example.test`,
    );
    const answers = await Promise.all(emails.map((email) => signIn(email)));
    const refused = answers.filter((answer) => answer.status === 429);
    const kept = answers.filter((answer) => answer.status !== 429);
    // The queue holds some and turns the rest away.
    expect(refused.length).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((answer) => answer.status === 401)).toBe(true);
    for (const answer of refused) {
      expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    // The refusal does not depend on the email: the owner's and strangers'
    // are both turned away.
    const turnedAwayAt = (own: boolean) =>
      answers.filter(
        (answer, n) =>
          answer.status === 429 && (emails[n] === TEST_OWNER.email) === own,
      ).length;
    expect(turnedAwayAt(true)).toBeGreaterThan(0);
    expect(turnedAwayAt(false)).toBeGreaterThan(0);
    for (const answer of answers) await answer.body?.cancel();

    // Once the waiting ends, a sign-in is answered as it was before.
    const after = await signIn("stranger-after@example.test");
    expect(after.status).toBe(401);
    await after.body?.cancel();
  }, 120_000);

  // A failed try leaves the hour spent, which the retry would start from.
  it(
    "answers sign-ins at one email 429 with Retry-After past the hour every address shares, and turns away at once those its queue has no place for",
    { retry: 0, timeout: 120_000 },
    async () => {
      for (let n = 0; n < 100; n++) {
        const counted = await signInPastTheHour(
          `spender-${String(n)}@example.test`,
        );
        expect(counted.status).toBe(401);
        await counted.body?.cancel();
      }
      // The witness: one at a time, each sign-in waits its turn.
      const oneAtATime = performance.now();
      const alone: number[] = [];
      for (let n = 0; n < 8; n++) {
        alone.push(...(await timed([signInPastTheHour("alone@example.test")])));
      }
      const eight = performance.now() - oneAtATime;
      expect(alone).toEqual(Array<number>(8).fill(429));

      // Ninety-six at once at another email: were each to wait its turn, they
      // would take twelve times as long as the eight.
      const together = performance.now();
      const answers = await timed(
        Array.from({ length: 96 }, () =>
          signInPastTheHour("together@example.test"),
        ),
      );
      const all = performance.now() - together;
      expect(answers).toEqual(Array<number>(96).fill(429));
      expect(all).toBeLessThan(4 * eight);
    },
  );
});
