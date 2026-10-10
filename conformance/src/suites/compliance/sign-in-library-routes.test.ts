import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { issuerOrigin } from "../../utils/signed-in.js";

/**
 * The sign-in library's routes Marfa does not use, and the password check
 * that remains on one it does. Each case needs the owner signed in, and the
 * password limits count per address over a window, so this file boots a
 * server of its own that believes a header naming the client's address.
 */
let server: FreshServer;
let origin: string;

const CLIENT_HEADER = "x-conformance-client";

beforeAll(async () => {
  server = await bootFreshServer("sign-in-library-routes", {
    TRUSTED_PROXY_HEADER: CLIENT_HEADER,
  });
  origin = await issuerOrigin(server);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function signIn(password: string, address: string): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      [CLIENT_HEADER]: address,
    },
    body: JSON.stringify({ email: OWNER.email, password }),
  });
}

async function cookieFrom(address: string): Promise<string> {
  const response = await signIn(OWNER.password, address);
  expect(response.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(cookie, "sign-in set no session cookie").toBeTruthy();
  return cookie!;
}

/** The library's paths no Marfa client calls, each parameter filled in. */
const UNUSED = [
  "/sign-in/social",
  "/callback/github",
  "/sign-up/email",
  "/reset-password",
  "/reset-password/a-token",
  "/request-password-reset",
  "/verify-password",
  "/verify-email",
  "/send-verification-email",
  "/change-email",
  "/update-session",
  "/update-user",
  "/delete-user",
  "/delete-user/callback",
  "/list-sessions",
  "/list-accounts",
  "/revoke-session",
  "/link-social",
  "/unlink-account",
  "/refresh-token",
  "/get-access-token",
  "/account-info",
  "/token",
  "/ok",
  "/oauth2/continue",
  // And a path nobody registered.
  "/not-a-route",
  // Served routes spelled with a percent-escape, which name no route.
  "/change%2Dpassword",
  "/revoke%2Dsessions",
  "/sign%2Din/email",
  "/oauth2/%74oken",
];

describe("the sign-in library's routes", () => {
  it("answer 404 not_found on every path no Marfa client uses, either spelling, to a signed-in owner", async () => {
    const cookie = await cookieFrom("192.0.2.1");
    // The witness: the same session is answered where Marfa serves the library.
    const session = await fetch(`${server.apiUrl}/auth/get-session`, {
      headers: { cookie },
    });
    expect(session.status).toBe(200);
    expect(
      ((await session.json()) as { user?: { email?: string } }).user?.email,
    ).toBe(OWNER.email);

    for (const path of UNUSED) {
      for (const spelling of [path, `${path}/`]) {
        for (const method of ["GET", "POST"]) {
          const response = await fetch(`${server.apiUrl}/auth${spelling}`, {
            method,
            headers: {
              cookie,
              origin,
              "content-type": "application/json",
              [CLIENT_HEADER]: "192.0.2.1",
            },
            ...(method === "POST"
              ? {
                  body: JSON.stringify({
                    password: OWNER.password,
                    name: "x",
                  }),
                }
              : {}),
          });
          const label = `${method} /auth${spelling}`;
          expect(response.status, label).toBe(404);
          expect(response.headers.get("x-error-code"), label).toBe("not_found");
          await response.body?.cancel();
        }
      }
    }
  });

  it("answer the browser session with no signed token", async () => {
    const cookie = await cookieFrom("192.0.2.2");
    const session = await fetch(`${server.apiUrl}/auth/get-session`, {
      headers: { cookie },
    });
    expect(session.status).toBe(200);
    expect(
      ((await session.json()) as { user?: { email?: string } }).user?.email,
    ).toBe(OWNER.email);
    expect(session.headers.get("set-auth-jwt")).toBeNull();
  });
});

describe("the owner's password change", () => {
  async function change(
    cookie: string,
    from: string,
    to: string,
    address: string,
  ): Promise<Response> {
    return fetch(`${server.apiUrl}/auth/change-password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie,
        [CLIENT_HEADER]: address,
      },
      body: JSON.stringify({ currentPassword: from, newPassword: to }),
    });
  }

  const failures = async (): Promise<number> => {
    const page = await new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.managementKey,
    }).listAudit({ action: "owner.password.change_failed", limit: 200 });
    expect(page.status, JSON.stringify(page.error)).toBe(200);
    return page.data.data.length;
  };

  it("holds the current password to the sign-in limits and records each refusal", async () => {
    const guesser = "203.0.113.40";
    const cookie = await cookieFrom(guesser);
    // The witness: the right current password changes it, and back.
    const changed = await change(
      cookie,
      OWNER.password,
      `${OWNER.password} again`,
      guesser,
    );
    expect(changed.status).toBe(200);
    expect(
      (await change(cookie, `${OWNER.password} again`, OWNER.password, guesser))
        .status,
    ).toBe(200);

    const before = await failures();
    for (let i = 0; i < 10; i++) {
      const wrong = await change(
        cookie,
        `guess ${String(i)}`,
        "x".repeat(20),
        guesser,
      );
      expect(wrong.status, `guess ${String(i)}`).toBe(401);
      await wrong.body?.cancel();
    }
    expect(await failures()).toBe(before + 10);
    const limited = await change(cookie, "guess 10", "x".repeat(20), guesser);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Answered before the password is judged.
    const right = await change(cookie, OWNER.password, "x".repeat(20), guesser);
    expect(right.status).toBe(429);
    expect(await failures()).toBe(before + 12);
    // The guesses count where a sign-in counts.
    expect((await signIn(OWNER.password, guesser)).status).toBe(429);
    // The owner, elsewhere, signs in.
    expect((await signIn(OWNER.password, "198.51.100.41")).status).toBe(200);
  });
});
