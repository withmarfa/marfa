import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { ErrorResponse } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * The browser doors under `/auth`: where they accept a post from, where a
 * sign-in may send the browser afterwards, and how many attempts they take.
 *
 * The limits count per caller address, and a fixture talks to the server
 * from one address. So this file boots a server of its own that believes a
 * header naming the client's address, the setting a deployment behind a
 * platform edge uses, and claims a different address with it wherever a case
 * is about one. The limits also count across a window, so a server of its
 * own keeps this file's attempts from meeting any other file's.
 */
let server: FreshServer | undefined;
let origin: string;

const CLIENT_HEADER = "x-conformance-client";
const OWNER = { email: "owner@example.com", password: "correct horse battery" };
const FOREIGN = "https://foreign.example";

/** The doors a browser posts a form to. */
const FORM_DOORS = [
  "/auth/sign-in",
  "/auth/device",
  "/auth/device/consent",
  "/auth/authorize/decision",
];

beforeAll(async () => {
  server = await bootFreshServer("sign-in-surface", {
    TRUSTED_PROXY_HEADER: CLIENT_HEADER,
  });
  const operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.operatorKey,
  });
  expect((await operator.createOwner(OWNER)).status).toBe(201);
  // The origin the surface trusts is its own, which discovery names as the
  // issuer.
  const discovery = await fetch(
    `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
  );
  const { issuer } = (await discovery.json()) as { issuer: string };
  origin = new URL(issuer).origin;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function postForm(
  path: string,
  form: Record<string, string>,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${server!.apiUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(form),
    redirect: "manual",
  });
}

function signIn(password: string, address: string): Promise<Response> {
  return fetch(`${server!.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      [CLIENT_HEADER]: address,
    },
    body: JSON.stringify({ email: OWNER.email, password }),
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorResponse).error.code;
}

describe("the sign-in surface", () => {
  it("refuses a form post from an origin it does not trust, on every browser door", async () => {
    for (const path of FORM_DOORS) {
      for (const headers of [
        { origin: FOREIGN },
        { referer: `${FOREIGN}/page` },
        { origin: "null" },
      ] as Record<string, string>[]) {
        const refused = await postForm(
          path,
          { user_code: "ABCD2345" },
          {
            ...headers,
            [CLIENT_HEADER]: "192.0.2.1",
          },
        );
        expect(refused.status, `${path} ${JSON.stringify(headers)}`).toBe(403);
        expect(await errorCode(refused)).toBe("forbidden");
      }
    }
    // The witness: the same post from the instance's own origin is answered
    // by the door rather than refused.
    const own = await postForm(
      "/auth/sign-in",
      { email: "", password: "", return_to: "/" },
      { origin },
    );
    expect(own.status).toBe(302);
    expect(own.headers.get("location")).toContain("error=missing_field");
  });

  it("sends a signed-in browser only to a path on the instance", async () => {
    // A browser strips the tab before it resolves the address, so this is
    // `//foreign.example` by the time it navigates.
    const offInstance = "/\t/foreign.example";
    const page = await fetch(
      `${server!.apiUrl}/auth/sign-in?return_to=${encodeURIComponent(offInstance)}`,
    );
    expect(await page.text()).toContain('name="return_to" value="/"');

    const signedIn = await postForm(
      "/auth/sign-in",
      { ...OWNER, return_to: offInstance },
      { origin, [CLIENT_HEADER]: "192.0.2.2" },
    );
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe("/");

    const onInstance = await postForm(
      "/auth/sign-in",
      { ...OWNER, return_to: "/auth/device?from=sign-in" },
      { origin, [CLIENT_HEADER]: "192.0.2.2" },
    );
    expect(onInstance.headers.get("location")).toBe(
      "/auth/device?from=sign-in",
    );
  });

  it("holds one address to ten attempts at an account, and leaves the owner signing in from another", async () => {
    const guesser = "203.0.113.10";
    for (let i = 0; i < 10; i++) {
      expect((await signIn("not the password", guesser)).status).toBe(401);
    }
    const throttled = await signIn("not the password", guesser);
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
    // Answered before the password is judged.
    expect((await signIn(OWNER.password, guesser)).status).toBe(429);

    // The form says so, rather than that the password is wrong.
    const form = await postForm(
      "/auth/sign-in",
      { ...OWNER, return_to: "/" },
      { origin, [CLIENT_HEADER]: guesser },
    );
    expect(form.status).toBe(302);
    expect(form.headers.get("location")).toContain("error=too_many_attempts");
    expect(form.headers.get("set-cookie")).toBeNull();

    // The owner, somewhere else, signs in.
    expect((await signIn(OWNER.password, "198.51.100.20")).status).toBe(200);
  });

  it("limits device code entry per address, whatever codes are tried", async () => {
    const sweeper = "203.0.113.30";
    const enter = async (code: string, address: string) => {
      const response = await postForm(
        "/auth/device",
        { user_code: code },
        { origin, [CLIENT_HEADER]: address },
      );
      expect(response.status).toBe(302);
      return response.headers.get("location") ?? "";
    };
    for (let i = 0; i < 10; i++) {
      expect(await enter(`ZZ${String(100000 + i)}`, sweeper)).toContain(
        "error=invalid_code",
      );
    }
    expect(await enter("ZZ999999", sweeper)).toContain(
      "error=too_many_attempts",
    );
    expect(await enter("ZZ999998", "198.51.100.30")).toContain(
      "error=invalid_code",
    );
  });
});
