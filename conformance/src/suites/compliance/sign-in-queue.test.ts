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

const CLIENT_HEADER = "x-conformance-client";

beforeAll(async () => {
  server = await bootFreshServer("sign-in-queue", {
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
  });
  origin = new URL(server.apiUrl).origin;
}, FRESH_SERVER_TIMEOUT_MS);

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

describe("password sign-ins that carry no known device cookie", () => {
  it("answers a sign-in 429 with Retry-After once eight are waiting, at any email, and answers one alone 401", async () => {
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
    // Eight wait at once, so at least eight are answered before any is
    // turned away, and most of sixty are turned away.
    expect(refused.length).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThanOrEqual(8);
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
});
