import { TEST_OWNER as OWNER } from "../../utils/target.js";
import {
  markedInvalid,
  pageField,
  visibleText,
} from "../../utils/page-html.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ErrorResponse } from "../../client/types.js";
import {
  postSignInForm,
  sessionCookieOf,
  signInAnswerOf,
  signInOutcome,
} from "../../client/owner-session.js";
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
const FOREIGN = "https://foreign.example";

/** The doors a browser posts a form to. */
const FORM_DOORS = [
  "/auth/sign-in",
  "/auth/device",
  "/auth/device/check",
  "/auth/device/consent",
  "/auth/consent",
];

beforeAll(async () => {
  server = await bootFreshServer("sign-in-surface", {
    MARFA_TRUSTED_PROXY_HEADER: CLIENT_HEADER,
    MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
  });
  // The origin the surface trusts is its own, which discovery names as the
  // issuer.
  const discovery = await fetch(
    `${server.apiUrl}/.well-known/oauth-authorization-server`,
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

/** The sign-in form's answer for a password from `address`, the redirect not followed. */
function signIn(password: string, address: string): Promise<Response> {
  return postSignInForm(
    server!.apiUrl,
    origin,
    { username: OWNER.username, password },
    { [CLIENT_HEADER]: address },
  );
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
      { username: "", password: "", return_to: "/" },
      { origin },
    );
    expect(own.status).toBe(302);
    expect(own.headers.get("location")).toContain("error=missing_field");
    // A post naming no origin at all is answered by a door that opens no
    // session.
    const unnamed = await postForm(
      "/auth/device",
      { user_code: "" },
      { [CLIENT_HEADER]: "192.0.2.1" },
    );
    expect(unnamed.status).toBe(302);
    expect(unnamed.headers.get("location")).toContain("error=missing_code");
    const unnamedCheck = await postForm(
      "/auth/device/check",
      { user_code: "ABCD-EFGH" },
      { [CLIENT_HEADER]: "192.0.2.1" },
    );
    expect(unnamedCheck.status).toBe(302);
    expect(
      new URL(unnamedCheck.headers.get("location") ?? "", origin).pathname,
    ).toBe("/auth/sign-in");
  });

  it("refuses a sign-in that says neither Origin nor Referer, and sets no cookie", async () => {
    const refused = await postForm(
      "/auth/sign-in",
      { ...OWNER, return_to: "/" },
      { [CLIENT_HEADER]: "192.0.2.5" },
    );
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("forbidden");
    expect(refused.headers.get("set-cookie")).toBeNull();
    // The witness: a form whose Referer is a page of the instance signs in.
    const referred = await postForm(
      "/auth/sign-in",
      { ...OWNER, return_to: "/" },
      { referer: `${origin}/auth/sign-in`, [CLIENT_HEADER]: "192.0.2.5" },
    );
    expect(referred.status).toBe(302);
    expect(referred.headers.get("set-cookie")).toMatch(/^marfa_session=/);
  });

  it("answers a sign-out with only ok, and ends the session cookie", async () => {
    const signedIn = await signIn(OWNER.password, "192.0.2.6");
    const cookie = sessionCookieOf(signedIn)!;
    const ended = await fetch(`${server!.apiUrl}/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: "{}",
    });
    expect(ended.status).toBe(200);
    expect(await ended.json()).toEqual({ ok: true });
    const line = ended.headers.get("set-cookie") ?? "";
    expect(line).toMatch(/^marfa_session=;/);
    expect(line).toMatch(/;\s*Max-Age=0/i);
    const after = await fetch(`${server!.apiUrl}/owner/passkeys`, {
      headers: { cookie },
    });
    expect(after.status).toBe(401);
  });

  it("answers a sign-out from a page with a page that says so, and ends the session cookie", async () => {
    const signedIn = await signIn(OWNER.password, "192.0.2.16");
    const cookie = sessionCookieOf(signedIn)!;
    const ended = await fetch(`${server!.apiUrl}/auth/sign-out`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        origin,
        cookie,
      },
      body: "",
    });
    expect(ended.status).toBe(200);
    expect(ended.headers.get("content-type")).toContain("text/html");
    const page = await ended.text();
    expect(page).toContain("signed out");
    expect(page).toContain('href="/auth/sign-in"');
    const line = ended.headers.get("set-cookie") ?? "";
    expect(line).toMatch(/^marfa_session=;/);
    expect(line).toMatch(/;\s*Max-Age=0/i);
    const after = await fetch(`${server!.apiUrl}/owner/passkeys`, {
      headers: { cookie },
    });
    expect(after.status).toBe(401);
  });

  it("refuses a sign-out 403 from another origin or none and 401 from no live session, and keeps the session until the instance's own origin ends it", async () => {
    const signedIn = await signIn(OWNER.password, "192.0.2.7");
    const cookie = sessionCookieOf(signedIn)!;
    const signOut = (headers: Record<string, string>): Promise<Response> =>
      fetch(`${server!.apiUrl}/auth/sign-out`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
    const lives = async (): Promise<number> =>
      (await fetch(`${server!.apiUrl}/owner/passkeys`, { headers: { cookie } }))
        .status;

    // The witness: the session is live.
    expect(await lives()).toBe(200);
    const refusedHeaders: Record<string, string>[] = [
      { cookie },
      { cookie, origin: FOREIGN },
    ];
    for (const headers of refusedHeaders) {
      const refused = await signOut(headers);
      expect(refused.status).toBe(403);
      const body = (await refused.json()) as ErrorResponse;
      expect(body.error.code).toBe("forbidden");
      expect(refused.headers.get("set-cookie")).toBeNull();
      expect(await lives()).toBe(200);
    }
    const bare = await signOut({ origin });
    expect(bare.status).toBe(401);
    expect(((await bare.json()) as ErrorResponse).error.code).toBe(
      "unauthorized",
    );

    expect((await signOut({ cookie, origin })).status).toBe(200);
    const ended = await signOut({ cookie, origin });
    expect(ended.status).toBe(401);
    expect(((await ended.json()) as ErrorResponse).error.code).toBe(
      "unauthorized",
    );
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
      expect(
        pageField(await page.text(), "return_to")?.value,
        offInstance,
      ).toBe("/");
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
      { ...OWNER, return_to: "/auth/device?from=sign-in#entry" },
      { origin, [CLIENT_HEADER]: "192.0.2.2" },
    );
    expect(onInstance.headers.get("location")).toBe(
      "/auth/device?from=sign-in#entry",
    );
  });

  it("answers a password sign-in sent as the form with a redirect, and its session cookie", async () => {
    const signedIn = await signIn(OWNER.password, "192.0.2.3");
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe("/");
    const line = signedIn.headers.get("set-cookie") ?? "";
    expect(line).toMatch(/^marfa_session=[^;]+;/);
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    const cookie = line.split(";")[0];
    const passkeys = await fetch(`${server!.apiUrl}/owner/passkeys`, {
      headers: { cookie },
    });
    expect(passkeys.status).toBe(200);
  });

  it("refuses a password sign-in sent as anything but the form, and signs in with the form", async () => {
    // The witness: the form with the same credentials signs the owner in.
    const witness = await signIn(OWNER.password, "192.0.2.4");
    expect(witness.status).toBe(302);
    expect(sessionCookieOf(witness)).toBeDefined();
    const asForm = new URLSearchParams(OWNER).toString();
    const multipart = new FormData();
    multipart.set("username", OWNER.username);
    multipart.set("password", OWNER.password);
    const bodies: [string, Record<string, string>, BodyInit][] = [
      ["JSON", { "content-type": "application/json" }, JSON.stringify(OWNER)],
      [
        "JSON with another field",
        { "content-type": "application/json" },
        JSON.stringify({ ...OWNER, rememberMe: false }),
      ],
      ["plain text", { "content-type": "text/plain" }, asForm],
      ["no content type", {}, new TextEncoder().encode(asForm)],
      ["multipart", {}, multipart],
    ];
    for (const [kind, type, body] of bodies) {
      const refused = await fetch(`${server!.apiUrl}/auth/sign-in`, {
        method: "POST",
        redirect: "manual",
        headers: { ...type, origin, [CLIENT_HEADER]: "192.0.2.4" },
        body,
      });
      expect(refused.status, kind).toBe(400);
      expect(await errorCode(refused), kind).toBe("validation_error");
      expect(refused.headers.get("set-cookie"), kind).toBeNull();
    }
  });

  it("answers a wrong password with a redirect that names invalid_credentials, and sets no cookie", async () => {
    const wrong = await signIn("not the password", "192.0.2.8");
    expect(wrong.status).toBe(302);
    expect(signInAnswerOf(wrong).error).toBe("invalid_credentials");
    expect(wrong.headers.get("set-cookie")).toBeNull();
    // The witness: the right password from the same address signs in.
    expect(signInOutcome(await signIn(OWNER.password, "192.0.2.8"))).toBe(
      "signed_in",
    );
  });

  it("holds one address to ten attempts at one username, and leaves the owner signing in from another", async () => {
    const guesser = "203.0.113.10";
    for (let i = 0; i < 10; i++) {
      expect(
        signInAnswerOf(await signIn("not the password", guesser)).error,
      ).toBe("invalid_credentials");
    }
    // The form says so, rather than that the password is wrong, and the
    // right password is answered the same before it is judged.
    const throttled = await signIn(OWNER.password, guesser);
    expect(throttled.status).toBe(302);
    const refusal = signInAnswerOf(throttled);
    expect(refusal.error).toBe("too_many_attempts");
    expect(throttled.headers.get("set-cookie")).toBeNull();
    // The wait is no longer than the address limit's fifteen minutes.
    expect(Number.isInteger(refusal.wait)).toBe(true);
    expect(refusal.wait).toBeGreaterThan(0);
    expect(refusal.wait).toBeLessThanOrEqual(15 * 60);

    // The owner, somewhere else, signs in.
    const elsewhere = await signIn(OWNER.password, "198.51.100.20");
    expect(elsewhere.status).toBe(302);
    expect(signInAnswerOf(elsewhere).error).toBe(undefined);
  });

  it("limits anonymous device code entry per address and the owner's checks per owner", async () => {
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
    const sweepRefusal = new URL(await enter("ZZ999999", sweeper), origin);
    expect(sweepRefusal.searchParams.get("error")).toBe("too_many_attempts");
    const deviceWait = Number(
      sweepRefusal.searchParams.get("retry_after_seconds"),
    );
    expect(deviceWait).toBeGreaterThan(0);
    expect(deviceWait).toBeLessThanOrEqual(15 * 60);
    expect(await enter("ZZ999998", "198.51.100.30")).toContain(
      "error=invalid_code",
    );

    const signedIn = await signIn(OWNER.password, "198.51.100.31");
    expect(signInOutcome(signedIn)).toBe("signed_in");
    const cookie = /(?:^|,\s*)([\w.-]*marfa_session=[^;]+)/.exec(
      signedIn.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(cookie).toBeDefined();
    const screen = async (code: string, address: string) => {
      const response = await fetch(
        `${server!.apiUrl}/auth/device/check?user_code=${code}`,
        {
          headers: { cookie: cookie!, [CLIENT_HEADER]: address },
          redirect: "manual",
        },
      );
      return response.headers.get("location") ?? "";
    };
    const confirm = (code: string, address: string) =>
      postForm(
        "/auth/device/check",
        { user_code: code },
        { origin, cookie: cookie!, [CLIENT_HEADER]: address },
      );
    const browser = "203.0.113.31";
    for (let i = 0; i < 5; i++) {
      expect(await screen(`YY${String(100000 + i)}`, browser)).toContain(
        "error=invalid_code",
      );
      const confirmed = await confirm(`YY${String(200000 + i)}`, browser);
      expect(confirmed.status).toBe(302);
      expect(confirmed.headers.get("location")).toContain("error=invalid_code");
    }
    expect(await screen("YY999999", browser)).toContain(
      "error=too_many_attempts",
    );
    const refused = await confirm("YY999998", browser);
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
  expect(signedIn.status).toBe(302);
  const cookie = sessionCookieOf(signedIn)!;
  expect(cookie).toBeDefined();
  return cookie!;
}

/** The consent screen's address for the authorization a sign-in page was sent
 *  for. The sign-in page carries the signed query itself, and the consent
 *  screen takes the same one. */
function consentLink(signInUrl: URL): URL {
  const authorize = new URL(
    signInUrl.searchParams.get("return_to") ?? "",
    server!.apiUrl,
  );
  const signed = new URLSearchParams(signInUrl.search);
  signed.delete("return_to");
  authorize.search = signed.toString();
  authorize.pathname = "/auth/consent";
  return authorize;
}

/** Register an app the way any program can, and start its authorization:
 *  answered with where the instance sends a person who is not signed in. */
async function startAuthorization(name: string): Promise<URL> {
  const registered = await fetch(`${server!.apiUrl}/oauth/register`, {
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
    `${server!.apiUrl}/oauth/authorize?${new URLSearchParams({
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
  it("returns the typed username after a wrong password, and never the password", async () => {
    const failed = await postForm(
      "/auth/sign-in",
      {
        username: OWNER.username,
        password: "not-the-password",
        return_to: "/",
      },
      { origin, [CLIENT_HEADER]: "192.0.2.51" },
    );
    expect(failed.status).toBe(302);
    const location = failed.headers.get("location") ?? "";
    expect(location).toContain("error=invalid_credentials");
    expect(location).not.toContain("not-the-password");
    const page = await (await fetch(`${server!.apiUrl}${location}`)).text();
    expect(pageField(page, "username")?.value).toBe(OWNER.username);
    expect(pageField(page, "password")?.value).toBeUndefined();
    expect(page).not.toContain("not-the-password");
  });

  it("tells a locked-out person how long to wait, in whole minutes rounded up, and names no passkey when the owner has none", async () => {
    // The wait the page names is the one the real lock set: lock an address,
    // follow the form's redirect, and read the page it lands on.
    const guesser = "203.0.113.60";
    for (let i = 0; i < 10; i++)
      expect(
        signInAnswerOf(await signIn("not the password", guesser)).error,
      ).toBe("invalid_credentials");
    const refused = await postForm(
      "/auth/sign-in",
      { ...OWNER, return_to: "/" },
      { origin, [CLIENT_HEADER]: guesser },
    );
    const location = refused.headers.get("location") ?? "";
    const seconds = Number(
      new URL(location, origin).searchParams.get("retry_after_seconds"),
    );
    const minutes = Math.ceil(seconds / 60);
    const real = visibleText(
      await (await fetch(`${server!.apiUrl}${location}`)).text(),
    );
    expect(real).toContain(
      `Try again in ${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}`,
    );
    // This instance signs in at an address that cannot hold a passkey.
    expect(real).toMatch(/Try again in \d+ minutes?\./);
    expect(real.toLowerCase()).not.toContain("passkey");

    // Whole minutes, rounded up, for waits either side of a minute.
    for (const [retryAfter, said] of [
      ["1", "1 minute"],
      ["60", "1 minute"],
      ["61", "2 minutes"],
      ["900", "15 minutes"],
      ["3599", "60 minutes"],
    ] as const) {
      const text = visibleText(
        await (
          await fetch(
            `${server!.apiUrl}/auth/sign-in?error=too_many_attempts&retry_after_seconds=${retryAfter}`,
          )
        ).text(),
      );
      expect(text, retryAfter).toContain(`Try again in ${said}`);
    }

    // Witness: the page names a number of minutes only when it was given a
    // wait; nothing in the address and it promises none.
    const none = visibleText(
      await (
        await fetch(`${server!.apiUrl}/auth/sign-in?error=too_many_attempts`)
      ).text(),
    );
    expect(none).toContain("Too many attempts");
    expect(none).not.toMatch(/\d+ minutes?/);
  });

  it("tells a person who has tried too many device codes how long to wait, in whole minutes rounded up", async () => {
    for (const [retryAfter, said] of [
      ["1", "1 minute"],
      ["61", "2 minutes"],
      ["900", "15 minutes"],
    ] as const) {
      const text = visibleText(
        await (
          await fetch(
            `${server!.apiUrl}/auth/device?error=too_many_attempts&retry_after_seconds=${retryAfter}`,
          )
        ).text(),
      );
      expect(text, retryAfter).toContain(`Try again in ${said}`);
    }
    const none = visibleText(
      await (
        await fetch(`${server!.apiUrl}/auth/device?error=too_many_attempts`)
      ).text(),
    );
    expect(none).toContain("Too many codes");
    expect(none).not.toMatch(/\d+ minutes?/);
  });

  it("says an unknown code as wrong or expired, and a code the server holds as expired as expired", async () => {
    const said = async (error: string): Promise<string> =>
      visibleText(
        await (
          await fetch(`${server!.apiUrl}/auth/device?error=${error}`)
        ).text(),
      );
    const wrong = await said("invalid_code");
    expect(wrong).toContain(
      "That code isn’t right or has expired. Check your device.",
    );
    // The witness: the other error is the one that says only expired.
    const expired = await said("expired_code");
    expect(expired).toContain(
      "That code has expired. Start again on your device.",
    );
    expect(expired).not.toContain("isn’t right");
  });

  it("says how long codes last", async () => {
    const plain = visibleText(
      await (await fetch(`${server!.apiUrl}/auth/device`)).text(),
    );
    expect(plain).toContain("A code lasts 10 minutes.");
    expect(plain).not.toContain("isn’t right");
  });

  it("names the app an authorization sent the person for, and no app for a link edited after signing", async () => {
    const signInUrl = await startAuthorization("Conformance Notes");
    expect(signInUrl.pathname).toBe("/auth/sign-in");
    const named = visibleText(await (await fetch(signInUrl)).text());
    expect(named).toContain("Conformance Notes");
    // An app that registered itself is marked unverified beside its name.
    expect(named).toContain("(unverified");

    const edited = new URL(signInUrl);
    edited.searchParams.set("scope", "core.note:write");
    expect(visibleText(await (await fetch(edited)).text())).not.toContain(
      "Conformance Notes",
    );
    const unsigned = new URL(signInUrl);
    unsigned.searchParams.delete("sig");
    expect(visibleText(await (await fetch(unsigned)).text())).not.toContain(
      "Conformance Notes",
    );
  });

  it("tells a person who is signed in so, and shows the form to one an authorization sent to sign in again", async () => {
    const cookie = await sessionCookie("192.0.2.52");
    const page = await (
      await fetch(`${server!.apiUrl}/auth/sign-in`, { headers: { cookie } })
    ).text();
    expect(visibleText(page)).toContain("You’re signed in");
    expect(visibleText(page)).toContain(OWNER.username);
    expect(pageField(page, "password")).toBeUndefined();

    const wanted = await startAuthorization("Conformance Again");
    const again = await (await fetch(wanted, { headers: { cookie } })).text();
    expect(pageField(again, "password")).toBeDefined();
    // Witness for both: nobody signed in is shown the form.
    expect(
      pageField(
        await (await fetch(`${server!.apiUrl}/auth/sign-in`)).text(),
        "password",
      ),
    ).toBeDefined();
  });

  it("marks only the fields a sign-in form was sent without, and lets the form reach the server empty", async () => {
    const page = await (await fetch(`${server!.apiUrl}/auth/sign-in`)).text();
    expect(/<form\b[^>]*\snovalidate[\s>]/i.test(page)).toBe(true);
    expect(/<input id="username"[^>]*\srequired/i.test(page)).toBe(true);
    expect(/<input id="password"[^>]*\srequired/i.test(page)).toBe(true);

    const marked = async (username: string, password: string) => {
      const sent = await postForm(
        "/auth/sign-in",
        { username, password, return_to: "/" },
        { origin, [CLIENT_HEADER]: "192.0.2.61" },
      );
      expect(sent.status).toBe(302);
      const landed = await (
        await fetch(new URL(sent.headers.get("location")!, server!.apiUrl))
      ).text();
      expect(visibleText(landed)).toContain(
        "Enter your username and your password.",
      );
      return ["username", "password"].filter((id) => markedInvalid(landed, id));
    };
    expect(await marked("   ", OWNER.password)).toEqual(["username"]);
    expect(await marked(OWNER.username, "")).toEqual(["password"]);
    expect(await marked("", "")).toEqual(["username", "password"]);
  });

  it("answers a page that says how to reset the owner's password, without a sign-in and without printing the private socket's path", async () => {
    const reply = await fetch(`${server!.apiUrl}/auth/forgot-password`, {
      headers: { accept: "text/html" },
    });
    expect(reply.status).toBe(200);
    const text = visibleText(await reply.text());
    expect(text).toContain("marfa --socket PATH owner recover");
    expect(text).toContain("MARFA_OWNER_RECOVERY=true");
    expect(text).toContain("Enter Recovery Code");
    // The witness: the server has a private socket whose path a page could have
    // printed, and which the page does not.
    const socket = server!.controlSocket;
    expect(socket).toContain("/");
    expect(text).not.toContain(socket);
    // A query on the address changes nothing, and nor does a session.
    expect(
      (await fetch(`${server!.apiUrl}/auth/forgot-password?stray=1`)).status,
    ).toBe(200);
    const signedIn = await fetch(`${server!.apiUrl}/auth/forgot-password`, {
      headers: { cookie: await sessionCookie("192.0.2.55") },
    });
    expect(signedIn.status).toBe(200);
    expect(visibleText(await signedIn.text())).toBe(text);
  });

  it("tells a link edited after it was signed that it is invalid, not that it has expired", async () => {
    const cookie = await sessionCookie("192.0.2.53");
    const authorize = consentLink(
      await startAuthorization("Conformance Edited"),
    );
    const edited = new URL(authorize);
    edited.searchParams.set("exp", String(Math.floor(Date.now() / 1000) - 60));
    const refused = await fetch(edited, { headers: { cookie } });
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(text).toContain("Marfa couldn’t check this request");
    expect(text).not.toContain("has expired");

    // A signature the instance did not make is told the same.
    const forged = new URL(authorize);
    forged.searchParams.set(
      "sig",
      "AAAA" + (forged.searchParams.get("sig") ?? "").slice(4),
    );
    const unverified = await fetch(forged, { headers: { cookie } });
    expect(unverified.status).toBe(400);
    expect(await unverified.text()).toContain(
      "Marfa couldn’t check this request",
    );
    // The witness: the link as it was signed reaches the consent screen.
    const genuine = await fetch(authorize, { headers: { cookie } });
    expect(genuine.status).toBe(200);
    expect(await genuine.text()).not.toContain(
      "Marfa couldn’t check this request",
    );
  });

  it("tells a link whose window has closed that the request has expired", async () => {
    const cookie = await sessionCookie("192.0.2.54");
    const link = consentLink(await startAuthorization("Conformance Lapsed"));
    // The witness: the link reaches the consent screen while its window is
    // open.
    const open = await fetch(link, { headers: { cookie } });
    expect(open.status).toBe(200);
    const shown = await open.text();
    expect(shown).not.toContain("has expired");
    expect(shown).not.toContain("Marfa couldn’t check this request");

    // The window is ten minutes.
    await server!.advanceClock(11 * 60_000);
    const lapsed = await fetch(link, { headers: { cookie } });
    expect(lapsed.status).toBe(400);
    const text = await lapsed.text();
    expect(text).toContain("This request has expired");
    expect(text).not.toContain("Marfa couldn’t check this request");
  });
});
