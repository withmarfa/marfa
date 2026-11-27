import { controlRequest } from "../../utils/control-request.js";
import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { issuerOrigin } from "../../utils/signed-in.js";
import {
  postSignInForm,
  signInAnswerOf,
  signInOutcome,
} from "../../client/owner-session.js";

/**
 * The limits on password sign-in and device code lookups that count across
 * addresses: every address together, and an IPv6 address by its /64. A
 * fixture talks from one address, so each server here believes a header
 * naming the client's address. The window shared by every address holds
 * strangers out for an hour once it fills, so each case that fills it has a
 * server of its own.
 */
let shared: FreshServer;
let account: FreshServer;
let every: FreshServer;
let timed: FreshServer;
let known: FreshServer;
let noted: FreshServer;
let uncertain: FreshServer;
let ownersUsername: FreshServer;
let ownersCount: FreshServer;
let usernames: FreshServer;

const DAY = 24 * 60 * 60 * 1000;

const CLIENT_HEADER = "x-conformance-client";

beforeAll(async () => {
  [
    shared,
    account,
    every,
    timed,
    known,
    noted,
    uncertain,
    ownersUsername,
    ownersCount,
    usernames,
  ] = await Promise.all([
    bootFreshServer("sign-in-limits", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
    bootFreshServer("sign-in-limits-account", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
    bootFreshServer("sign-in-limits-every-username", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
    bootFreshServer("sign-in-limits-timed", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
    bootFreshServer("sign-in-limits-known-device", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
    bootFreshServer("sign-in-limits-noted", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
    bootFreshServer("sign-in-limits-uncertain", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
    bootFreshServer("sign-in-limits-owners-username", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
    bootFreshServer("sign-in-limits-owners-count", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
    bootFreshServer("sign-in-limits-usernames", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
  ]);
}, 10 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.allSettled([
    shared.stop(),
    account.stop(),
    every.stop(),
    timed.stop(),
    known.stop(),
    noted.stop(),
    uncertain.stop(),
    ownersUsername.stop(),
    ownersCount.stop(),
    usernames.stop(),
  ]);
}, 10 * FRESH_SERVER_TIMEOUT_MS);

/** The sign-in form's answer for a password from `address`, the redirect not followed. */
async function signIn(
  server: FreshServer,
  password: string,
  address: string,
  cookie?: string,
  username = OWNER.username,
): Promise<Response> {
  const response = await postSignInForm(
    server.apiUrl,
    await issuerOrigin(server),
    { username, password },
    {
      [CLIENT_HEADER]: address,
      ...(cookie === undefined ? {} : { cookie }),
    },
  );
  await response.body?.cancel();
  return response;
}

/** One wrong password at `username`, answered in full. */
async function attempt(
  server: FreshServer,
  username: string,
  address: string,
): Promise<{ status: number; outcome: string }> {
  const response = await signIn(
    server,
    "not the password",
    address,
    undefined,
    username,
  );
  return { status: response.status, outcome: signInOutcome(response) };
}

/** The `name=value` of the cookie a response sets whose name ends in `name`. */
function setCookie(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .find((pair) => pair.split("=")[0]?.endsWith(name));
}

/** A device cookie from a sign-in with the right password. */
async function deviceCookie(
  server: FreshServer,
  address: string,
  cookie?: string,
): Promise<string> {
  const response = await signIn(server, OWNER.password, address, cookie);
  expect(signInOutcome(response)).toBe("signed_in");
  const device = setCookie(response, "marfa_device");
  expect(device, "the sign-in set no device cookie").toBeDefined();
  return device!;
}

/** The refused sign-ins the audit log holds with `reason`, newest first. */
async function refusals(
  server: FreshServer,
  reason: string,
): Promise<{ details?: { reason?: string; unrecorded_before?: number } }[]> {
  const response = await fetch(
    `${server.apiUrl}/audit?${new URLSearchParams({ action: "auth.sign_in.failed", limit: "200" })}`,
    { headers: { authorization: `Bearer ${server.managementKey}` } },
  );
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as {
    data: { details?: { reason?: string; unrecorded_before?: number } }[];
  };
  return data.filter((entry) => entry.details?.reason === reason);
}

/** How many refused sign-ins the audit log holds with `reason`. */
async function refusalsLogged(
  server: FreshServer,
  reason: string,
): Promise<number> {
  return (await refusals(server, reason)).length;
}

/** Spends the window every address shares with ten wrong passwords from each of ten addresses. */
async function fillAccount(server: FreshServer, block: number): Promise<void> {
  for (let a = 1; a <= 10; a++) {
    for (let i = 0; i < 10; i++) {
      const response = await signIn(
        server,
        "not the password",
        `10.${String(block)}.${String(a)}.1`,
      );
      expect(signInOutcome(response)).toBe("invalid_credentials");
    }
  }
  expect(
    signInOutcome(
      await signIn(server, OWNER.password, `10.${String(block)}.99.1`),
    ),
    "the window every address shares is not spent",
  ).toBe("too_many_attempts");
}

/** Recovers the owner's password, as it was, through the private control socket. */
async function recover(server: FreshServer): Promise<void> {
  const recovered = await controlRequest(
    server.controlSocket,
    "/_control/owner/recover",
    { method: "POST", body: { password: OWNER.password } },
  );
  expect(recovered.status).toBe(200);
}

/** Where the device code entry form sends a browser entering `code`. */
async function enter(
  server: FreshServer,
  code: string,
  address: string,
): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/device`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: await issuerOrigin(server),
      [CLIENT_HEADER]: address,
    },
    body: new URLSearchParams({ user_code: code }),
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  return response.headers.get("location") ?? "";
}

describe("password sign-in", () => {
  it("counts an IPv6 address as its /64", async () => {
    for (let i = 1; i <= 10; i++) {
      const response = await signIn(
        shared,
        "not the password",
        `2001:db8:1:1::${i.toString(16)}`,
      );
      expect(signInOutcome(response)).toBe("invalid_credentials");
    }
    const sameBlock = await signIn(shared, OWNER.password, "2001:db8:1:1::ff");
    expect(signInOutcome(sameBlock)).toBe("too_many_attempts");
    // The witness: the next /64 has attempts left.
    expect(
      signInOutcome(await signIn(shared, OWNER.password, "2001:db8:1:2::1")),
    ).toBe("signed_in");
  });

  it("holds every address together to a hundred attempts in an hour, counting none an address made past its own limit", async () => {
    // One address past its own limit: ten counted, five refused uncounted.
    for (let i = 0; i < 15; i++) {
      const response = await signIn(account, "not the password", "192.0.2.1");
      expect(signInOutcome(response)).toBe(
        i < 10 ? "invalid_credentials" : "too_many_attempts",
      );
    }
    // Then ten from each further address until the shared window
    // refuses one an address's own limit would still take. The window takes
    // a hundred counted failures; had the five refusals counted, it would
    // have closed after 95.
    let failures = 10;
    let refused = false;
    for (let a = 2; a <= 20 && !refused; a++) {
      for (let i = 0; i < 10 && !refused; i++) {
        const response = await signIn(
          account,
          "not the password",
          `192.0.2.${String(a)}`,
        );
        if (signInOutcome(response) === "too_many_attempts") refused = true;
        else {
          expect(signInOutcome(response)).toBe("invalid_credentials");
          failures++;
        }
      }
    }
    expect(refused, "the window every address shares never closed").toBe(true);
    expect(failures).toBe(100);
    const elsewhere = await signIn(account, OWNER.password, "198.51.100.1");
    expect(signInOutcome(elsewhere)).toBe("too_many_attempts");
    expect(signInAnswerOf(elsewhere).wait).toBeGreaterThan(0);

    // The form names the shared window's wait, which runs for an hour and
    // not the fifteen minutes an address is held for.
    const wait = signInAnswerOf(elsewhere).wait!;
    expect(wait).toBeGreaterThan(15 * 60);
    expect(wait).toBeLessThanOrEqual(60 * 60);

    // The first address has spent its own limit as well, for a shorter time.
    // Both are spent, so the wait is the later end, the shared window's, and not
    // the address limit's quarter hour that would only meet the shared
    // limit again.
    const both = await signIn(account, OWNER.password, "192.0.2.1");
    expect(signInOutcome(both)).toBe("too_many_attempts");
    const bothWait = signInAnswerOf(both).wait!;
    expect(bothWait).toBeGreaterThan(15 * 60);
    expect(bothWait).toBeLessThanOrEqual(60 * 60);
  }, 120_000);

  it("answers a name that cannot be a username, and the owner's email, as a wrong username, and counts each at its address", async () => {
    // The witness: the owner's own username signs in, typed in capitals and with spaces too.
    const signed = (username: string, address: string) =>
      signIn(usernames, OWNER.password, address, undefined, username);
    expect(signInOutcome(await signed(OWNER.username, "10.20.1.1"))).toBe(
      "signed_in",
    );
    expect(
      signInOutcome(
        await signed(` ${OWNER.username.toUpperCase()} `, "10.20.1.2"),
      ),
    ).toBe("signed_in");
    const wrong = await attempt(usernames, "nobody", "10.20.2.1");
    expect(wrong).toEqual({ status: 302, outcome: "invalid_credentials" });
    const names = [
      "nobody",
      `${OWNER.username}@example.test`,
      `${OWNER.username} two`,
      `${OWNER.username}\u200b`,
      "o".repeat(65),
    ];
    for (const [n, username] of names.entries()) {
      const address = `10.20.${String(10 + n)}.1`;
      for (let i = 0; i < 10; i++) {
        expect(
          await attempt(usernames, username, address),
          JSON.stringify(username),
        ).toEqual(wrong);
      }
      const past = await attempt(usernames, username, address);
      expect(past, JSON.stringify(username)).toEqual({
        status: 302,
        outcome: "too_many_attempts",
      });
    }
  });

  it("holds attempts at every username together to the same hundred, and the owner's right password still signs in", async () => {
    const device = await deviceCookie(every, "203.0.113.200");
    // From each of ten addresses, five wrong passwords at the owner's username
    // and five at usernames with no account.
    for (let a = 1; a <= 10; a++) {
      const address = `203.0.113.${String(a)}`;
      for (let i = 0; i < 10; i++) {
        const username =
          i < 5 ? OWNER.username : `stranger-${String(a)}-${String(i)}`;
        const response = await signIn(
          every,
          "not the password",
          address,
          undefined,
          username,
        );
        expect(signInOutcome(response)).toBe("invalid_credentials");
      }
    }
    const owner = await signIn(every, "not the password", "203.0.113.50");
    expect(signInOutcome(owner)).toBe("too_many_attempts");
    const stranger = await signIn(
      every,
      "not the password",
      "203.0.113.51",
      undefined,
      "stranger",
    );
    expect(signInOutcome(stranger)).toBe("too_many_attempts");
    const waits = [owner, stranger].map(
      (response) => signInAnswerOf(response).wait,
    );
    expect(waits[0]).toBeGreaterThan(15 * 60);
    expect(Math.abs(waits[0]! - waits[1]!)).toBeLessThanOrEqual(1);
    // Fifty of the hundred were at the owner's username, so the owner's share
    // has room: the right password signs in from a browser the server does
    // not know, and so does the known device.
    expect(
      signInOutcome(await signIn(every, OWNER.password, "203.0.113.53")),
    ).toBe("signed_in");
    expect(
      signInOutcome(
        await signIn(every, OWNER.password, "203.0.113.52", device),
      ),
    ).toBe("signed_in");
  }, 120_000);

  it("answers the owner's right password as a wrong one once a hundred attempts at the owner's username are counted in an hour", async () => {
    // The witness: with the owner's share left, the right password signs in.
    expect(
      signInOutcome(await signIn(ownersUsername, OWNER.password, "10.9.98.1")),
    ).toBe("signed_in");
    await fillAccount(ownersUsername, 9);
    const wrong = await signIn(ownersUsername, "not the password", "10.9.97.1");
    const right = await signIn(ownersUsername, OWNER.password, "10.9.96.1");
    expect(signInOutcome(wrong)).toBe("too_many_attempts");
    expect(signInOutcome(right)).toBe(signInOutcome(wrong));
    expect(right.headers.getSetCookie()).toEqual([]);
    const waits = [wrong, right].map(
      (response) => signInAnswerOf(response).wait,
    );
    expect(waits[0]).toBeGreaterThan(15 * 60);
    expect(Math.abs(waits[0]! - waits[1]!)).toBeLessThanOrEqual(1);
  }, 120_000);

  // A failed try leaves the clock moved, which the retry would start from.
  it(
    "counts the owner's right password as a wrong one once a hundred attempts at the owner's username are counted in an hour",
    { retry: 0, timeout: 120_000 },
    async () => {
      // Past every window the server's start opened, the hour every address
      // shares opens first, so it ends while the owner's username still has its
      // hundred counted.
      await ownersCount.advanceClock(61 * 60 * 1000);
      expect(
        signInOutcome(
          await signIn(
            ownersCount,
            "not the password",
            "10.8.0.1",
            undefined,
            "stranger",
          ),
        ),
      ).toBe("invalid_credentials");
      await ownersCount.advanceClock(59 * 60 * 1000);
      for (let a = 1; a <= 10; a++) {
        for (let i = 0; i < 10; i++) {
          const response = await signIn(
            ownersCount,
            "not the password",
            `10.8.${String(a)}.1`,
          );
          expect(["invalid_credentials", "too_many_attempts"]).toContain(
            signInOutcome(response),
          );
        }
      }
      await ownersCount.advanceClock(2 * 60 * 1000);
      const control: string[] = [];
      for (let i = 0; i < 11; i++) {
        control.push(
          signInOutcome(
            await signIn(ownersCount, "not the password", "10.8.50.1"),
          ),
        );
      }
      // The witness: the address's own ten show in the answers.
      expect(control).toEqual([
        ...Array<string>(10).fill("invalid_credentials"),
        "too_many_attempts",
      ]);
      const right = await signIn(ownersCount, OWNER.password, "10.8.51.1");
      expect(right.headers.getSetCookie()).toEqual([]);
      const probe = [signInOutcome(right)];
      for (let i = 0; i < 10; i++) {
        probe.push(
          signInOutcome(
            await signIn(ownersCount, "not the password", "10.8.51.1"),
          ),
        );
      }
      expect(probe).toEqual(control);
    },
  );

  it("records the first sign-in a filled limit refuses in fifteen minutes, and no other, from any number of addresses", async () => {
    // The witness: each wrong password that fills the window is recorded,
    // and so is the first refusal, which shows the window spent.
    await fillAccount(noted, 7);
    expect(await refusalsLogged(noted, "invalid_credentials")).toBe(100);
    expect(await refusalsLogged(noted, "too_many_attempts")).toBe(1);

    for (let n = 1; n <= 50; n++) {
      const refused = await signIn(
        noted,
        OWNER.password,
        `198.51.100.${String(n)}`,
      );
      expect(signInOutcome(refused)).toBe("too_many_attempts");
    }
    expect(await refusalsLogged(noted, "too_many_attempts")).toBe(1);

    // The shared window runs an hour, so it still refuses, and a new quarter
    // hour records its first refusal.
    await noted.advanceClock(15 * 60 * 1000);
    for (let n = 1; n <= 10; n++) {
      const refused = await signIn(
        noted,
        "not the password",
        `203.0.113.${String(n)}`,
      );
      expect(signInOutcome(refused)).toBe("too_many_attempts");
    }
    expect(await refusalsLogged(noted, "too_many_attempts")).toBe(2);
    expect(await refusalsLogged(noted, "invalid_credentials")).toBe(100);
  }, 120_000);

  it("records the next refused sign-in when the record of the one before could not be written", async () => {
    // A new quarter hour; the shared window the case before filled still refuses.
    await noted.advanceClock(15 * 60 * 1000);
    const before = await refusalsLogged(noted, "too_many_attempts");
    await noted.setFault("fail:lock=1");
    const unrecorded = await signIn(noted, OWNER.password, "192.0.2.61");
    expect(signInOutcome(unrecorded)).toBe("503");
    expect(await refusalsLogged(noted, "too_many_attempts")).toBe(before);
    const refused = await signIn(noted, OWNER.password, "192.0.2.62");
    expect(signInOutcome(refused)).toBe("too_many_attempts");
    const held = await refusals(noted, "too_many_attempts");
    expect(held).toHaveLength(before + 1);
    // Nine omissions from the previous case, plus the failed write.
    expect(held[0]?.details?.unrecorded_before).toBe(10);
  }, 120_000);

  it("treats the record of a refused sign-in whose write may have committed as written, and writes none for fifteen minutes after it", async () => {
    await fillAccount(uncertain, 7);
    await uncertain.advanceClock(15 * 60 * 1000);
    expect(await refusalsLogged(uncertain, "too_many_attempts")).toBe(1);
    await uncertain.setFault("fail:commit=auth.sign_in.failed");
    expect(
      signInOutcome(await signIn(uncertain, OWNER.password, "192.0.2.71")),
    ).toBe("too_many_attempts");
    const failed = (await uncertain.faults()).find(
      (fault) => fault.name === "fail:commit",
    );
    // The witness that this refusal's record was written and its commit failed.
    expect(failed?.fired).toBe(1);
    for (let n = 72; n <= 76; n++) {
      expect(
        signInOutcome(
          await signIn(uncertain, OWNER.password, `192.0.2.${String(n)}`),
        ),
      ).toBe("too_many_attempts");
    }
    expect(await refusalsLogged(uncertain, "too_many_attempts")).toBe(1);

    await uncertain.advanceClock(15 * 60 * 1000);
    expect(
      signInOutcome(await signIn(uncertain, OWNER.password, "192.0.2.77")),
    ).toBe("too_many_attempts");
    const held = await refusals(uncertain, "too_many_attempts");
    expect(held).toHaveLength(2);
    // The five after it, and not the one whose commit could not be told.
    expect(held[0]?.details?.unrecorded_before).toBe(5);
  }, 120_000);
});

describe("counting only wrong passwords", () => {
  it("counts only wrong passwords, so the owner's own sign-ins and confirmations spend nothing", async () => {
    const address = "192.0.2.50";
    const origin = await issuerOrigin(shared);
    let session: string | undefined;
    for (let i = 0; i < 15; i++) {
      const response = await signIn(shared, OWNER.password, address);
      expect(signInOutcome(response)).toBe("signed_in");
      session = setCookie(response, "marfa_session");
    }
    expect(session, "the sign-in set no session cookie").toBeDefined();
    for (let i = 0; i < 15; i++) {
      const confirmed = await fetch(`${shared.apiUrl}/auth/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: session!,
          [CLIENT_HEADER]: address,
        },
        body: JSON.stringify({ password: OWNER.password }),
      });
      await confirmed.body?.cancel();
      expect(confirmed.status).toBe(200);
      session = setCookie(confirmed, "marfa_session");
    }
    // The witness: the same address is still held to ten wrong passwords.
    for (let i = 0; i < 10; i++) {
      expect(
        signInOutcome(await signIn(shared, "not the password", address)),
      ).toBe("invalid_credentials");
    }
    expect(signInOutcome(await signIn(shared, OWNER.password, address))).toBe(
      "too_many_attempts",
    );
  }, 120_000);

  it("holds a known device to ten wrong passwords across addresses", async () => {
    const device = await deviceCookie(shared, "192.0.2.60");
    for (let i = 1; i <= 10; i++) {
      const response = await signIn(
        shared,
        "not the password",
        `192.0.2.${String(60 + i)}`,
        device,
      );
      expect(signInOutcome(response)).toBe("invalid_credentials");
    }
    const held = await signIn(shared, OWNER.password, "192.0.2.80", device);
    expect(signInOutcome(held)).toBe("too_many_attempts");
    expect(signInAnswerOf(held).wait).toBeGreaterThan(0);
    // The witness: the same address without the device's cookie signs in.
    expect(
      signInOutcome(await signIn(shared, OWNER.password, "192.0.2.80")),
    ).toBe("signed_in");
  }, 120_000);

  it("keeps a known device signing in while strangers are limited", async () => {
    const first = await deviceCookie(known, "198.51.100.1");
    await fillAccount(known, 1);
    const forged = first.replace(/.$/, (last) => (last === "0" ? "1" : "0"));
    expect(
      signInOutcome(
        await signIn(known, OWNER.password, "198.51.100.2", forged),
      ),
    ).toBe("too_many_attempts");
    const renewed = await signIn(known, OWNER.password, "198.51.100.3", first);
    expect(signInOutcome(renewed)).toBe("signed_in");
    const device = setCookie(renewed, "marfa_device");
    expect(device).toBeDefined();
    expect(device!.split(".")[0]).toBe(first.split(".")[0]);
    const line = renewed.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(device!.split("=")[0] + "="));
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).toMatch(/;\s*Max-Age=34560000(;|$)/);

    // The device cookie is no session; the session cookie is the witness.
    const session = setCookie(renewed, "marfa_session");
    expect(session).toBeDefined();
    const origin = await issuerOrigin(known);
    const page = async (cookie: string) => {
      const response = await fetch(`${known.apiUrl}/auth/owner/passkeys`, {
        headers: { origin, cookie },
        redirect: "manual",
      });
      await response.body?.cancel();
      return response.status;
    };
    expect(await page(session!)).toBe(200);
    expect(await page(device!)).toBe(302);
    const [sessionName] = session!.split("=");
    const deviceValue = device!.slice(device!.indexOf("=") + 1);
    expect(await page(`${sessionName!}=${deviceValue}`)).toBe(302);

    // Past 400 days the device is a stranger, and a fresh cookie is known.
    await known.advanceClock(400 * DAY + 60_000);
    const fresh = await deviceCookie(known, "198.51.100.4");
    await fillAccount(known, 2);
    expect(
      signInOutcome(
        await signIn(known, OWNER.password, "198.51.100.5", device),
      ),
    ).toBe("too_many_attempts");
    expect(
      signInOutcome(await signIn(known, OWNER.password, "198.51.100.6", fresh)),
    ).toBe("signed_in");
  }, 240_000);

  it("forgets every known device when the password is recovered", async () => {
    // A recovery also starts every password count afresh.
    await recover(known);
    const before = await deviceCookie(known, "172.17.0.1");
    await recover(known);
    const after = await deviceCookie(known, "172.17.0.2");
    await fillAccount(known, 3);
    expect(
      signInOutcome(await signIn(known, OWNER.password, "172.17.0.3", before)),
    ).toBe("too_many_attempts");
    // The witness: a cookie set after the recovery is still known.
    expect(
      signInOutcome(await signIn(known, OWNER.password, "172.17.0.4", after)),
    ).toBe("signed_in");
  }, 240_000);

  it("forgets every other known device when the password is changed", async () => {
    await recover(known);
    const other = await deviceCookie(known, "172.18.0.1");
    const signedIn = await signIn(known, OWNER.password, "172.18.0.2");
    expect(signInOutcome(signedIn)).toBe("signed_in");
    const session = setCookie(signedIn, "marfa_session");
    const changing = setCookie(signedIn, "marfa_device");
    expect(session, "the sign-in set no session cookie").toBeDefined();
    expect(changing, "the sign-in set no device cookie").toBeDefined();
    const next = "sign-in limits changed password";
    const changed = await fetch(`${known.apiUrl}/auth/owner/password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: await issuerOrigin(known),
        cookie: `${session!}; ${changing!}`,
        [CLIENT_HEADER]: "172.18.0.2",
      },
      body: JSON.stringify({
        current_password: OWNER.password,
        new_password: next,
      }),
    });
    await changed.body?.cancel();
    expect(changed.status).toBe(200);
    const kept = setCookie(changed, "marfa_device");
    expect(kept, "the change set no device cookie").toBeDefined();
    await fillAccount(known, 4);
    expect(signInOutcome(await signIn(known, next, "172.18.0.3", other))).toBe(
      "too_many_attempts",
    );
    // The witness: the browser that changed the password is still known.
    expect(signInOutcome(await signIn(known, next, "172.18.0.4", kept))).toBe(
      "signed_in",
    );
    await recover(known);
  }, 240_000);

  it("answers an address that spent its attempts at two usernames alike after the password is changed", async () => {
    await recover(known);
    const address = "172.19.0.1";
    const stranger = "stranger";
    for (let i = 0; i < 10; i++) {
      for (const username of [OWNER.username, stranger]) {
        const response = await signIn(
          known,
          "wrong",
          address,
          undefined,
          username,
        );
        expect(signInOutcome(response)).toBe("invalid_credentials");
      }
    }
    for (const username of [OWNER.username, stranger]) {
      expect(
        signInOutcome(
          await signIn(known, "wrong", address, undefined, username),
        ),
      ).toBe("too_many_attempts");
    }
    const signedIn = await signIn(known, OWNER.password, "172.19.0.2");
    expect(signInOutcome(signedIn)).toBe("signed_in");
    const changed = await fetch(`${known.apiUrl}/auth/owner/password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: await issuerOrigin(known),
        cookie: setCookie(signedIn, "marfa_session")!,
        [CLIENT_HEADER]: "172.19.0.2",
      },
      body: JSON.stringify({
        current_password: OWNER.password,
        new_password: "sign-in limits another password",
      }),
    });
    await changed.body?.cancel();
    expect(changed.status).toBe(200);
    const after = await Promise.all(
      [OWNER.username, stranger].map((username) =>
        signIn(known, "wrong", address, undefined, username),
      ),
    );
    expect(after.map((response) => signInOutcome(response))).toEqual([
      "too_many_attempts",
      "too_many_attempts",
    ]);
    const waits = after.map((response) => signInAnswerOf(response).wait);
    expect(Math.abs(waits[0]! - waits[1]!)).toBeLessThanOrEqual(1);
    await recover(known);
  }, 240_000);

  it("holds every known device together to a hundred wrong passwords an hour", async () => {
    await recover(known);
    const devices: string[] = [];
    for (let d = 0; d <= 10; d++) {
      devices.push(await deviceCookie(known, `172.16.${String(d)}.1`));
    }
    for (let d = 0; d < 10; d++) {
      for (let i = 0; i < 10; i++) {
        const response = await signIn(
          known,
          "not the password",
          `172.16.${String(d)}.1`,
          devices[d],
        );
        expect(signInOutcome(response)).toBe("invalid_credentials");
      }
    }
    const held = await signIn(
      known,
      OWNER.password,
      "172.16.10.1",
      devices[10],
    );
    expect(signInOutcome(held)).toBe("too_many_attempts");
    expect(signInAnswerOf(held).wait).toBeGreaterThan(0);
    // The witness: the limit without a device cookie is untouched.
    expect(
      signInOutcome(await signIn(known, OWNER.password, "172.16.11.1")),
    ).toBe("signed_in");
  }, 240_000);
});

describe("a confirmed move of the sign-in address", () => {
  it("counts a device cookie set before a confirmed move of the sign-in address as no device cookie", async () => {
    // Its own server: the move changes the address every later sign-in names.
    const own = await bootFreshServer("sign-in-limits-address-move", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    });
    try {
      const before = await deviceCookie(own, "172.18.0.1");
      const moved = await controlRequest(own.controlSocket, "/config", {
        method: "PATCH",
        body: {
          sign_in_address: "https://moved.example",
          confirm_sign_in_address_change: true,
          skip_sign_in_address_check: true,
        },
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      // An https address reads its device cookie under another name.
      const old = `__Host-marfa_device=${before.slice(before.indexOf("=") + 1)}`;
      const after = await deviceCookie(own, "172.18.0.2");
      await fillAccount(own, 3);
      expect(
        signInOutcome(await signIn(own, OWNER.password, "172.18.0.3", old)),
      ).toBe("too_many_attempts");
      // The witness: a cookie set after the move is still known.
      expect(
        signInOutcome(await signIn(own, OWNER.password, "172.18.0.4", after)),
      ).toBe("signed_in");
    } finally {
      await own.stop();
    }
  }, 240_000);
});

describe("device code lookups", () => {
  it("hold every address together to a hundred in fifteen minutes, counting none an address made past its own limit", async () => {
    for (let i = 0; i < 15; i++) {
      expect(
        await enter(shared, `QQ${String(100000 + i)}`, "203.0.113.1"),
      ).toContain(i < 10 ? "error=invalid_code" : "error=too_many_attempts");
    }
    for (let a = 2; a <= 10; a++) {
      for (let i = 0; i < 10; i++) {
        expect(
          await enter(
            shared,
            `QQ${String(200000 + a * 100 + i)}`,
            `203.0.113.${String(a)}`,
          ),
        ).toContain("error=invalid_code");
      }
    }
    expect(await enter(shared, "QQ999999", "198.51.100.9")).toContain(
      "error=too_many_attempts",
    );
  }, 120_000);

  it("names the later end when a lookup meets a spent address limit and a spent instance limit", async () => {
    // The instance's window opens first, so it ends first.
    await enter(timed, "QQ300000", "198.51.100.1");
    await timed.advanceClock(10 * 60_000);
    // This address spends its own ten in a window that ends nine minutes
    // after the instance's has ended.
    for (let i = 0; i < 10; i++)
      expect(
        await enter(timed, `QQ31000${String(i)}`, "203.0.113.9"),
      ).toContain("error=invalid_code");
    await timed.advanceClock(6 * 60_000);
    // The instance's window ended and opens again, and ten other addresses
    // fill its hundred.
    for (let a = 1; a <= 10; a++)
      for (let i = 0; i < 10; i++)
        expect(
          await enter(
            timed,
            `QQ4${String(a).padStart(2, "0")}${String(i).padStart(3, "0")}`,
            `198.51.100.${String(a + 20)}`,
          ),
        ).toContain("error=invalid_code");

    // The address limit refuses this address for nine more minutes and the
    // instance limit for fifteen, so the wait is the fifteen.
    const refused = new URL(
      await enter(timed, "QQ500000", "203.0.113.9"),
      timed.apiUrl,
    );
    expect(refused.searchParams.get("error")).toBe("too_many_attempts");
    const wait = Number(refused.searchParams.get("retry_after_seconds"));
    expect(wait).toBeGreaterThan(14 * 60);
    expect(wait).toBeLessThanOrEqual(15 * 60);
  }, 120_000);
});
