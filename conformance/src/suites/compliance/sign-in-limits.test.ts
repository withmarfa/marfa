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
 * naming the client's address. The account-wide window holds the owner out
 * for an hour once it fills, so it has a server of its own.
 */
let shared: FreshServer;
let account: FreshServer;

const CLIENT_HEADER = "x-conformance-client";

beforeAll(async () => {
  [shared, account] = await Promise.all([
    bootFreshServer("sign-in-limits", { TRUSTED_PROXY_HEADER: CLIENT_HEADER }),
    bootFreshServer("sign-in-limits-account", {
      TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    }),
  ]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await Promise.allSettled([shared.stop(), account.stop()]);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function signIn(
  server: FreshServer,
  password: string,
  address: string,
): Promise<Response> {
  const response = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: await issuerOrigin(server),
      [CLIENT_HEADER]: address,
    },
    body: JSON.stringify({ email: OWNER.email, password }),
  });
  await response.body?.cancel();
  return response;
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
    // refuses one an address's own limit would still take. The server's
    // own boot signed the owner in once, so the window takes 99 or 100
    // counted failures here; had the five refusals counted, it would have
    // closed after 95 at most.
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
    expect(failures).toBeGreaterThanOrEqual(99);
    expect(failures).toBeLessThanOrEqual(100);
    const elsewhere = await signIn(account, OWNER.password, "198.51.100.1");
    expect(elsewhere.status).toBe(429);
    expect(Number(elsewhere.headers.get("retry-after"))).toBeGreaterThan(0);
  }, 120_000);
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
});
