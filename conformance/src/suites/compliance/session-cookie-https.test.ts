import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { TEST_OWNER } from "../../utils/target.js";

// The server names its cookies from the sign-in address, not from the
// connection, so a plain listener behind a named HTTPS address serves them.
const ADDRESS = "https://marfa.example";
let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("session-cookie-https");
  const moved = await controlRequest(server.controlSocket, "/config", {
    method: "PATCH",
    body: { sign_in_address: ADDRESS, confirm_sign_in_address_change: true },
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

function signIn(): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ADDRESS },
    body: JSON.stringify(TEST_OWNER),
  });
}

function passkeyList(cookie: string): Promise<Response> {
  return fetch(`${server.apiUrl}/owner/passkeys`, { headers: { cookie } });
}

describe("the owner's session cookie on an HTTPS sign-in address", () => {
  it("is __Host-marfa_session, Secure, on path / and with no Domain", async () => {
    const signedIn = await signIn();
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const line = signedIn.headers.get("set-cookie") ?? "";
    expect(line).toMatch(/^__Host-marfa_session=[^;]+;/);
    expect(line).toMatch(/;\s*Secure/i);
    expect(line).toMatch(/;\s*Path=\/(;|$)/);
    expect(line).not.toMatch(/;\s*Domain=/i);
  });

  it("signs no one in when its token comes under the name a plain HTTP address uses", async () => {
    const signedIn = await signIn();
    expect(signedIn.status).toBe(200);
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0];
    const token = cookie.slice(cookie.indexOf("=") + 1);
    // The witness: the token under its own name is a live session.
    expect((await passkeyList(`__Host-marfa_session=${token}`)).status).toBe(
      200,
    );
    const refused = await passkeyList(`marfa_session=${token}`);
    expect(refused.status).toBe(401);
  });
});
