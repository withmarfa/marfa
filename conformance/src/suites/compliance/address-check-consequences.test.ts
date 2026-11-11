import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { testAuthenticator } from "../../utils/passkey-authenticator.js";
import { TEST_OWNER } from "../../utils/target.js";

// Passkeys require a hostname; moving sign-in to localhost ends the initial session.
let server: FreshServer;
let ownerCookie: string;

beforeAll(async () => {
  server = await bootFreshServer("address-check-consequences");
  const home = onLocalhost();
  const moved = await controlRequest(server.controlSocket, "/config", {
    method: "PATCH",
    body: {
      sign_in_address: home.origin,
      confirm_sign_in_address_change: true,
    },
  });
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  const signedIn = await fetch(`${home.origin}/auth/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: home.origin },
    body: JSON.stringify(TEST_OWNER),
  });
  expect(signedIn.status).toBe(200);
  ownerCookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

interface Consequence {
  code: string;
  count: number | null;
}

/** What a check of a sign-in address would do, by code. */
async function checked(signIn: string): Promise<Consequence[]> {
  const answer = await fetch(`${server.apiUrl}/config/address-check`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.managementKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sign_in_address: signIn }),
  });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { consequences: Consequence[] })
    .consequences;
}

const countOf = (found: Consequence[], code: string): number | undefined =>
  found.find((consequence) => consequence.code === code)?.count ?? undefined;

/** The instance's own address under the name browsers accept for a passkey. */
function onLocalhost(): URL {
  const own = new URL(server.apiUrl);
  own.hostname = "localhost";
  return own;
}

async function registerPasskey(): Promise<void> {
  const base = onLocalhost();
  const origin = base.origin;
  const asked = await fetch(`${origin}/auth/passkeys/registration/options`, {
    method: "POST",
    headers: { Origin: origin, Cookie: ownerCookie },
  });
  expect(asked.status, await asked.clone().text()).toBe(200);
  const { challenge } = (await asked.json()) as { challenge: string };
  const cookies = [
    ownerCookie,
    ...asked.headers.getSetCookie().map((value) => value.split(";")[0]),
  ].join("; ");
  const device = testAuthenticator();
  const registered = await fetch(`${origin}/auth/passkeys/registration`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookies,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Consequences",
      response: device.registration(challenge, origin, base.hostname),
    }),
  });
  expect(registered.status, await registered.clone().text()).toBe(201);
}

const ELSEWHERE = "https://elsewhere.example";

describe("an address check of a new sign-in address", () => {
  it("names the passkeys that would stop working, with their number, only while one is registered for another host", async () => {
    // The witness: with none registered, the consequence is left out.
    expect(countOf(await checked(ELSEWHERE), "passkeys_unusable")).toBe(
      undefined,
    );

    await registerPasskey();
    expect(countOf(await checked(ELSEWHERE), "passkeys_unusable")).toBe(1);
    // A passkey belongs to a host, so another port on the same host keeps it.
    expect(
      countOf(await checked("http://localhost:1"), "passkeys_unusable"),
    ).toBe(undefined);
  });

  it("names the apps that would have to sign in again, with their number, only while one is connected", async () => {
    // The witness: with none connected, the consequence is left out.
    expect(countOf(await checked(ELSEWHERE), "apps_sign_in_again")).toBe(
      undefined,
    );

    await approvedAppToken(server);
    expect(countOf(await checked(ELSEWHERE), "apps_sign_in_again")).toBe(1);
    // Nothing moves when the sign-in address stays where it is.
    expect(
      countOf(await checked(onLocalhost().origin), "apps_sign_in_again"),
    ).toBe(undefined);
  });
});
