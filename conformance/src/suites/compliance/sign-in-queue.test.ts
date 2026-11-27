import {
  postSignInForm,
  signInAnswerOf,
  signInOutcome,
} from "../../client/owner-session.js";
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
 * address of its own and no limit on one address or one username can be what
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

function signIn(username: string): Promise<Response> {
  addresses += 1;
  return postSignInForm(
    server.apiUrl,
    origin,
    { username, password: "not the password" },
    { [CLIENT_HEADER]: `198.51.100.${String(addresses)}` },
  );
}

/** A wrong password at `username` on the server whose shared hour is spent, from an address of its own. */
function signInPastTheHour(username: string): Promise<Response> {
  spentAddresses += 1;
  return postSignInForm(
    spent.apiUrl,
    spentOrigin,
    { username, password: "not the password" },
    {
      [CLIENT_HEADER]: `10.20.${String(spentAddresses >> 8)}.${String(spentAddresses & 255)}`,
    },
  );
}

async function timed(answers: Promise<Response>[]): Promise<string[]> {
  const outcomes: string[] = [];
  for (const answer of await Promise.all(answers)) {
    expect(signInAnswerOf(answer).wait).toBeGreaterThan(15 * 60);
    outcomes.push(signInOutcome(answer));
    await answer.body?.cancel();
  }
  return outcomes;
}

describe("password sign-ins that carry no known device cookie", () => {
  it("refuses a sign-in with a wait once the queue of waiting checks is full, at any username, and answers one alone as wrong credentials", async () => {
    // The witness: one at a time, a wrong password at either kind of username
    // is answered as wrong credentials, so the refusals below come from the wait.
    for (let n = 0; n < 20; n++) {
      const alone = await signIn(
        n % 2 === 0 ? TEST_OWNER.username : `stranger-alone-${String(n)}`,
      );
      expect(signInOutcome(alone)).toBe("invalid_credentials");
      await alone.body?.cancel();
    }

    const usernames = Array.from({ length: 60 }, (_, n) =>
      n % 2 === 0 ? TEST_OWNER.username : `stranger-${String(n)}`,
    );
    const answers = await Promise.all(
      usernames.map((username) => signIn(username)),
    );
    const refused = answers.filter(
      (answer) => signInOutcome(answer) === "too_many_attempts",
    );
    const kept = answers.filter(
      (answer) => signInOutcome(answer) !== "too_many_attempts",
    );
    // The queue holds some and turns the rest away.
    expect(refused.length).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThan(0);
    expect(
      kept.every((answer) => signInOutcome(answer) === "invalid_credentials"),
    ).toBe(true);
    for (const answer of refused) {
      expect(signInAnswerOf(answer).wait).toBeGreaterThan(0);
    }
    // The refusal does not depend on the username: the owner's and strangers'
    // are both turned away.
    const turnedAwayAt = (own: boolean) =>
      answers.filter(
        (answer, n) =>
          signInOutcome(answer) === "too_many_attempts" &&
          (usernames[n] === TEST_OWNER.username) === own,
      ).length;
    expect(turnedAwayAt(true)).toBeGreaterThan(0);
    expect(turnedAwayAt(false)).toBeGreaterThan(0);
    for (const answer of answers) await answer.body?.cancel();

    // Once the waiting ends, a sign-in is answered as it was before.
    const after = await signIn("stranger-after");
    expect(signInOutcome(after)).toBe("invalid_credentials");
    await after.body?.cancel();
  }, 120_000);

  // A failed try leaves the hour spent, which the retry would start from.
  it(
    "refuses sign-ins at one username with a wait past the hour every address shares, and turns away at once those its queue has no place for",
    { retry: 0, timeout: 120_000 },
    async () => {
      for (let n = 0; n < 100; n++) {
        const counted = await signInPastTheHour(`spender-${String(n)}`);
        expect(signInOutcome(counted)).toBe("invalid_credentials");
        await counted.body?.cancel();
      }
      // The witness: one at a time, each sign-in waits its turn.
      const oneAtATime = performance.now();
      const alone: string[] = [];
      for (let n = 0; n < 8; n++) {
        alone.push(...(await timed([signInPastTheHour("alone")])));
      }
      const eight = performance.now() - oneAtATime;
      expect(alone).toEqual(Array<string>(8).fill("too_many_attempts"));

      // Ninety-six at once at another username: were each to wait its turn, they
      // would take twelve times as long as the eight.
      const together = performance.now();
      const answers = await timed(
        Array.from({ length: 96 }, () => signInPastTheHour("together")),
      );
      const all = performance.now() - together;
      expect(answers).toEqual(Array<string>(96).fill("too_many_attempts"));
      expect(all).toBeLessThan(4 * eight);
    },
  );
});
