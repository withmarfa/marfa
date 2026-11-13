import { controlRequest } from "../../utils/control-request.js";
import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { issuerOrigin } from "../../utils/signed-in.js";

/**
 * The limits on password sign-in and device code lookups that count across
 * addresses: every address together, and an IPv6 address by its /64. A
 * fixture talks from one address, so each server here believes a header
 * naming the client's address. The account-wide window holds strangers out
 * for an hour once it fills, so each case that fills it has a server of its
 * own.
 */
let shared: FreshServer;
let account: FreshServer;
let timed: FreshServer;
let known: FreshServer;

const DAY = 24 * 60 * 60 * 1000;

const CLIENT_HEADER = "x-conformance-client";

beforeAll(async () => {
  [shared, account, timed, known] = await Promise.all([
    bootFreshServer("sign-in-limits", {
      MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    }),
    bootFreshServer("sign-in-limits-account", {
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
  ]);
}, 4 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.allSettled([
    shared.stop(),
    account.stop(),
    timed.stop(),
    known.stop(),
  ]);
}, 4 * FRESH_SERVER_TIMEOUT_MS);

async function signIn(
  server: FreshServer,
  password: string,
  address: string,
  cookie?: string,
): Promise<Response> {
  const response = await fetch(`${server.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: await issuerOrigin(server),
      [CLIENT_HEADER]: address,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ email: OWNER.email, password }),
  });
  await response.body?.cancel();
  return response;
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
  expect(response.status).toBe(200);
  const device = setCookie(response, "marfa_device");
  expect(device, "the sign-in set no device cookie").toBeDefined();
  return device!;
}

/** Spends the account-wide window with ten wrong passwords from each of ten addresses. */
async function fillAccount(server: FreshServer, block: number): Promise<void> {
  for (let a = 1; a <= 10; a++) {
    for (let i = 0; i < 10; i++) {
      const response = await signIn(
        server,
        "not the password",
        `10.${String(block)}.${String(a)}.1`,
      );
      expect(response.status).toBe(401);
    }
  }
  expect(
    (await signIn(server, OWNER.password, `10.${String(block)}.99.1`)).status,
    "the account's window is not spent",
  ).toBe(429);
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
      expect(response.status).toBe(401);
    }
    const sameBlock = await signIn(shared, OWNER.password, "2001:db8:1:1::ff");
    expect(sameBlock.status).toBe(429);
    // The witness: the next /64 has attempts left.
    expect(
      (await signIn(shared, OWNER.password, "2001:db8:1:2::1")).status,
    ).toBe(200);
  });

  it("holds every address together to a hundred attempts at an account in an hour, counting none an address made past its own limit", async () => {
    // One address past its own limit: ten counted, five refused uncounted.
    for (let i = 0; i < 15; i++) {
      const response = await signIn(account, "not the password", "192.0.2.1");
      expect(response.status).toBe(i < 10 ? 401 : 429);
    }
    // Then ten from each further address until the account's window
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
        if (response.status === 429) refused = true;
        else {
          expect(response.status).toBe(401);
          failures++;
        }
      }
    }
    expect(refused, "the account's window never closed").toBe(true);
    expect(failures).toBe(100);
    const elsewhere = await signIn(account, OWNER.password, "198.51.100.1");
    expect(elsewhere.status).toBe(429);
    expect(Number(elsewhere.headers.get("retry-after"))).toBeGreaterThan(0);

    // The form names the account window's wait, which runs for an hour and
    // not the fifteen minutes an address is held for.
    const form = await fetch(`${account.apiUrl}/auth/sign-in`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: await issuerOrigin(account),
        [CLIENT_HEADER]: "198.51.100.2",
      },
      body: new URLSearchParams({ ...OWNER, return_to: "/" }),
      redirect: "manual",
    });
    expect(form.status).toBe(302);
    const refusal = new URL(form.headers.get("location") ?? "", account.apiUrl);
    expect(refusal.searchParams.get("error")).toBe("too_many_attempts");
    const wait = Number(refusal.searchParams.get("retry_after"));
    expect(wait).toBeGreaterThan(15 * 60);
    expect(wait).toBeLessThanOrEqual(60 * 60);

    // The first address has spent its own limit as well, for a shorter time.
    // Both are spent, so the wait is the later end, the account's, and not
    // the address limit's quarter hour that would only meet the account's
    // limit again.
    const both = await fetch(`${account.apiUrl}/auth/sign-in`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: await issuerOrigin(account),
        [CLIENT_HEADER]: "192.0.2.1",
      },
      body: new URLSearchParams({ ...OWNER, return_to: "/" }),
      redirect: "manual",
    });
    expect(both.status).toBe(302);
    const bothWait = Number(
      new URL(
        both.headers.get("location") ?? "",
        account.apiUrl,
      ).searchParams.get("retry_after"),
    );
    expect(bothWait).toBeGreaterThan(15 * 60);
    expect(bothWait).toBeLessThanOrEqual(60 * 60);
  }, 120_000);
});

describe("counting only wrong passwords", () => {
  it("counts only wrong passwords, so the owner's own sign-ins and confirmations spend nothing", async () => {
    const address = "192.0.2.50";
    const origin = await issuerOrigin(shared);
    let session: string | undefined;
    for (let i = 0; i < 15; i++) {
      const response = await signIn(shared, OWNER.password, address);
      expect(response.status).toBe(200);
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
      expect((await signIn(shared, "not the password", address)).status).toBe(
        401,
      );
    }
    expect((await signIn(shared, OWNER.password, address)).status).toBe(429);
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
      expect(response.status).toBe(401);
    }
    const held = await signIn(shared, OWNER.password, "192.0.2.80", device);
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
    // The witness: the same address without the device's cookie signs in.
    expect((await signIn(shared, OWNER.password, "192.0.2.80")).status).toBe(
      200,
    );
  }, 120_000);

  it("keeps a known device signing in while strangers are limited", async () => {
    const first = await deviceCookie(known, "198.51.100.1");
    await fillAccount(known, 1);
    const forged = first.replace(/.$/, (last) => (last === "0" ? "1" : "0"));
    expect(
      (await signIn(known, OWNER.password, "198.51.100.2", forged)).status,
    ).toBe(429);
    const renewed = await signIn(known, OWNER.password, "198.51.100.3", first);
    expect(renewed.status).toBe(200);
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
      (await signIn(known, OWNER.password, "198.51.100.5", device)).status,
    ).toBe(429);
    expect(
      (await signIn(known, OWNER.password, "198.51.100.6", fresh)).status,
    ).toBe(200);
  }, 240_000);

  it("forgets every known device when the password is recovered", async () => {
    // A recovery also starts the account's counts afresh.
    await recover(known);
    const before = await deviceCookie(known, "172.17.0.1");
    await recover(known);
    const after = await deviceCookie(known, "172.17.0.2");
    await fillAccount(known, 3);
    expect(
      (await signIn(known, OWNER.password, "172.17.0.3", before)).status,
    ).toBe(429);
    // The witness: a cookie set after the recovery is still known.
    expect(
      (await signIn(known, OWNER.password, "172.17.0.4", after)).status,
    ).toBe(200);
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
        expect(response.status).toBe(401);
      }
    }
    const held = await signIn(
      known,
      OWNER.password,
      "172.16.10.1",
      devices[10],
    );
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
    // The witness: the account limit without a device cookie is untouched.
    expect((await signIn(known, OWNER.password, "172.16.11.1")).status).toBe(
      200,
    );
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
    const wait = Number(refused.searchParams.get("retry_after"));
    expect(wait).toBeGreaterThan(14 * 60);
    expect(wait).toBeLessThanOrEqual(15 * 60);
  }, 120_000);
});
