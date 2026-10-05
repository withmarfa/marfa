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
    // Each of these is `//foreign.example` by the time a browser navigates:
    // it strips the tab, and resolving collapses the dot segments.
    for (const offInstance of [
      "/\t/foreign.example",
      "/.//foreign.example",
      "/a/..//foreign.example",
      "/%2e//foreign.example",
      "/.\\/foreign.example",
      `${origin}//foreign.example`,
    ]) {
      const page = await fetch(
        `${server!.apiUrl}/auth/sign-in?return_to=${encodeURIComponent(offInstance)}`,
      );
      expect(await page.text(), offInstance).toContain(
        'name="return_to" value="/"',
      );
      const signedIn = await postForm(
        "/auth/sign-in",
        { ...OWNER, return_to: offInstance },
        { origin, [CLIENT_HEADER]: "192.0.2.2" },
      );
      expect(signedIn.status).toBe(302);
      expect(signedIn.headers.get("location"), offInstance).toBe("/");
    }

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

  it("limits device code lookups per address, on the entry form and the consent screen alike", async () => {
    const enter = async (code: string, address: string) => {
      const response = await postForm(
        "/auth/device",
        { user_code: code },
        { origin, [CLIENT_HEADER]: address },
      );
      expect(response.status).toBe(302);
      return response.headers.get("location") ?? "";
    };
    const sweeper = "203.0.113.30";
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

    // A signed-in browser looks codes up on the consent screen and its
    // decision, and those lookups count in the same limit.
    const signedIn = await signIn(OWNER.password, "198.51.100.31");
    expect(signedIn.status).toBe(200);
    const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
      signedIn.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(cookie).toBeDefined();
    const screen = async (code: string, address: string) => {
      const response = await fetch(
        `${server!.apiUrl}/auth/device/consent?user_code=${code}`,
        {
          headers: { cookie: cookie!, [CLIENT_HEADER]: address },
          redirect: "manual",
        },
      );
      return response.headers.get("location") ?? "";
    };
    const decide = (code: string, address: string) =>
      postForm(
        "/auth/device/consent",
        { user_code: code, decision: "approve" },
        { origin, cookie: cookie!, [CLIENT_HEADER]: address },
      );
    const browser = "203.0.113.31";
    for (let i = 0; i < 5; i++) {
      expect(await screen(`YY${String(100000 + i)}`, browser)).toContain(
        "error=invalid_code",
      );
      expect((await decide(`YY${String(200000 + i)}`, browser)).status).toBe(
        404,
      );
    }
    expect(await screen("YY999999", browser)).toContain(
      "error=too_many_attempts",
    );
    const refused = await decide("YY999998", browser);
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toContain(
      "error=too_many_attempts",
    );
  });
});

/** A browser's navigation, as the headers say it. */
const NAVIGATION = {
  accept: "text/html,application/xhtml+xml",
  "sec-fetch-mode": "navigate",
};

/** The session cookie a sign-in from `address` sets. */
async function sessionCookie(address: string): Promise<string> {
  const signedIn = await signIn(OWNER.password, address);
  expect(signedIn.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    signedIn.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(cookie).toBeDefined();
  return cookie!;
}

/** Register an app the way any program can, and start its authorization:
 *  answered with where the instance sends a person who is not signed in. */
async function startAuthorization(name: string): Promise<URL> {
  const registered = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      client_name: name,
      application_type: "native",
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as {
    client_id: string;
  };
  const authorize = await fetch(
    `${server!.apiUrl}/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1/callback",
      scope: "core.note:read",
      state: "pages",
      code_challenge: "0123456789012345678901234567890123456789012",
      code_challenge_method: "S256",
    }).toString()}`,
    {
      redirect: "manual",
      headers: { ...NAVIGATION, [CLIENT_HEADER]: "192.0.2.50" },
    },
  );
  // The provider answers a redirect as a 302 or, to a caller it takes for a
  // program, as JSON naming the address.
  const where =
    authorize.status === 302
      ? authorize.headers.get("location")
      : ((await authorize.json()) as { url?: string }).url;
  expect(where).toBeTruthy();
  return new URL(where ?? "", server!.apiUrl);
}

describe("the pages a person reads at sign-in", () => {
  it("returns the typed email after a wrong password, and never the password", async () => {
    const failed = await postForm(
      "/auth/sign-in",
      { email: OWNER.email, password: "not-the-password", return_to: "/" },
      { origin, [CLIENT_HEADER]: "192.0.2.51" },
    );
    expect(failed.status).toBe(302);
    const location = failed.headers.get("location") ?? "";
    expect(location).toContain("error=invalid_credentials");
    expect(location).not.toContain("not-the-password");
    const page = await (await fetch(`${server!.apiUrl}${location}`)).text();
    expect(page).toContain(`value="${OWNER.email}"`);
    expect(page).not.toContain("not-the-password");
  });

  it("names the app an authorization sent the person for, and no app for a link edited after signing", async () => {
    const signInUrl = await startAuthorization("Conformance Notes");
    expect(signInUrl.pathname).toBe("/auth/sign-in");
    const named = await (await fetch(signInUrl)).text();
    expect(named).toContain("Conformance Notes");
    // An app that registered itself is flagged as the consent page flags it.
    expect(named).toContain("hasn't verified this app");

    const edited = new URL(signInUrl);
    edited.searchParams.set("scope", "core.note:write");
    expect(await (await fetch(edited)).text()).not.toContain(
      "Conformance Notes",
    );
  });

  it("tells a person who is signed in so, and shows the form to one an authorization sent to sign in again", async () => {
    const cookie = await sessionCookie("192.0.2.52");
    const page = await (
      await fetch(`${server!.apiUrl}/auth/sign-in`, { headers: { cookie } })
    ).text();
    expect(page).toContain("You&#39;re signed in");
    expect(page).toContain(OWNER.email);
    expect(page).not.toContain('name="password"');

    const wanted = await startAuthorization("Conformance Again");
    const again = await (await fetch(wanted, { headers: { cookie } })).text();
    expect(again).toContain('name="password"');
    // Witness for both: nobody signed in is shown the form.
    expect(
      await (await fetch(`${server!.apiUrl}/auth/sign-in`)).text(),
    ).toContain('name="password"');
  });

  it("tells a link edited after it was signed that it is invalid, not that it has expired", async () => {
    const cookie = await sessionCookie("192.0.2.53");
    const signInUrl = await startAuthorization("Conformance Edited");
    const authorize = new URL(
      signInUrl.searchParams.get("return_to") ?? "",
      server!.apiUrl,
    );
    // The sign-in page carries the signed query itself; the consent screen
    // takes the same one.
    const signed = new URLSearchParams(signInUrl.search);
    signed.delete("return_to");
    authorize.search = signed.toString();
    authorize.pathname = "/auth/authorize";
    const edited = new URL(authorize);
    edited.searchParams.set("exp", String(Math.floor(Date.now() / 1000) - 60));
    const refused = await fetch(edited, { headers: { cookie } });
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(text).toContain("We could not verify this request");
    expect(text).not.toContain("has expired");
  });

  it("shows a browser at end-session with no session a page, and a program the provider's JSON", async () => {
    const page = await fetch(`${server!.apiUrl}/auth/oauth2/end-session`, {
      headers: NAVIGATION,
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("signed out");

    const program = await fetch(`${server!.apiUrl}/auth/oauth2/end-session`, {
      headers: { accept: "application/json" },
    });
    expect(program.status).toBe(400);
    expect(program.headers.get("content-type")).toContain("application/json");
  });
});
