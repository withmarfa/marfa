import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { issuerOrigin } from "../../utils/signed-in.js";

/**
 * The sign-in library's routes Marfa does not use. The case needs the owner
 * signed in, so this file boots a server of its own that believes a header
 * naming the client's address.
 */
let server: FreshServer;
let origin: string;

const CLIENT_HEADER = "x-conformance-client";

beforeAll(async () => {
  server = await bootFreshServer("sign-in-library-routes", {
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
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
  "/get-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/change-password",
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
  "/sign%2Dout",
  "/sign%2Din/email",
  "/oauth2/%74oken",
];

describe("the sign-in library's routes", () => {
  it("answer 404 not_found on every path no Marfa client uses, either spelling, to a signed-in owner", async () => {
    const cookie = await cookieFrom("192.0.2.1");
    // The witness: the same session is answered where Marfa serves a page.
    const session = await fetch(`${server.apiUrl}/owner/passkeys`, {
      headers: { cookie, [CLIENT_HEADER]: "192.0.2.1" },
    });
    expect(session.status).toBe(200);
    await session.body?.cancel();

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
});
