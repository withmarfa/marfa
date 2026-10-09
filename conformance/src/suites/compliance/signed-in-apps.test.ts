import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * An app signing in through the authorization flow, from registration to a
 * refreshed token, driven the way a browser and an app drive it. A person
 * has to be signed in, and an instance has one owner, so this file boots a
 * server of its own, with the limiter on, and claims its owner through the production local command.
 */
let server: FreshServer | undefined;
let origin: string;
let cookie: string;

const CALLBACK = "http://127.0.0.1:9/callback";
const REGISTERED = "core.note:read offline_access";
/** A scope the instance publishes to every client and the client did not
 *  register for. */
const PUBLISHED = "core.task:read";

let clientId: string;
let verifier: string;
let tokens: { access_token: string; refresh_token: string; scope: string };

beforeAll(async () => {
  server = await bootFreshServer("signed-in-apps", {
    RATE_LIMIT_ENABLED: "true",
  });
  const discovery = await fetch(
    `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
  );
  const { issuer } = (await discovery.json()) as { issuer: string };
  origin = new URL(issuer).origin;
  const signedIn = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(OWNER),
  });
  expect(signedIn.status).toBe(200);
  const session = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    signedIn.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(session, "sign-in set no session cookie").toBeTruthy();
  cookie = session!;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function authorizePath(
  scope: string | undefined,
  forClient: string = clientId,
): string {
  verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: forClient,
    redirect_uri: CALLBACK,
    state: "signed-in-apps",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  if (scope !== undefined) params.set("scope", scope);
  return `/auth/oauth2/authorize?${params.toString()}`;
}

async function get(path: string, withCookie: boolean): Promise<Response> {
  return fetch(`${server!.apiUrl}${path}`, {
    redirect: "manual",
    headers: withCookie ? { cookie } : {},
  });
}

function location(response: Response): URL {
  return new URL(response.headers.get("location") ?? "", origin);
}

/**
 * Where the provider sends the caller. It answers a browser navigating with
 * a `302` and a script's fetch, which this is, with `{ redirect, url }`.
 */
async function sentTo(response: Response): Promise<URL> {
  if (response.status === 302) return location(response);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { redirect?: boolean; url?: string };
  expect(body.redirect).toBe(true);
  return new URL(body.url ?? "", origin);
}

async function token(form: Record<string, string>) {
  const response = await fetch(`${server!.apiUrl}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ client_id: clientId, ...form }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as typeof tokens;
}

async function remaining(accessToken: string): Promise<number> {
  const response = await fetch(`${server!.apiUrl}/items?type=core.note`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
  return Number(response.headers.get("x-ratelimit-remaining"));
}

describe("an app signing in", () => {
  it("is registered at the scope it asked for, which an authorize from nobody signed in leaves as it was", async () => {
    const registration = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "signed-in-apps",
        application_type: "native",
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: REGISTERED,
      }),
    });
    expect(registration.status).toBe(201);
    const registered = (await registration.json()) as {
      client_id: string;
      scope: string;
    };
    expect(registered.scope).toBe(REGISTERED);
    clientId = registered.client_id;

    // Nobody signed in asks for more than the registration holds: they are
    // sent to sign in, carrying the request as it was.
    const asked = `${REGISTERED} ${PUBLISHED}`;
    const toSignIn = await sentTo(await get(authorizePath(asked), false));
    expect(toSignIn.pathname).toBe("/auth/sign-in");
    const back = new URL(toSignIn.searchParams.get("return_to") ?? "", origin);
    expect(back.pathname).toBe("/auth/oauth2/authorize");
    expect(back.searchParams.get("scope")).toBe(asked);

    // And the registration is as it was: a request naming no scope is the
    // registration's own scope, which the sign-in redirect carries.
    const omitted = await sentTo(await get(authorizePath(undefined), false));
    expect(omitted.pathname).toBe("/auth/sign-in");
    expect(omitted.searchParams.get("scope")).toBe(REGISTERED);
  });

  it("is caught up to a published scope once a person is signed in, and the grant carries it", async () => {
    const asked = `${REGISTERED} ${PUBLISHED}`;
    const consent = await sentTo(await get(authorizePath(asked), true));
    expect(consent.pathname).toBe("/auth/authorize");
    const signedQuery = consent.search.slice(1);
    const form = new URLSearchParams({
      accept: "true",
      oauth_query: signedQuery,
    });
    for (const scope of asked.split(" ")) form.append("scopes", scope);
    const decision = await fetch(`${server!.apiUrl}/auth/authorize/decision`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    expect(decision.status).toBe(302);
    const code = location(decision).searchParams.get("code");
    expect(code).toBeTruthy();
    tokens = await token({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    });
    expect(tokens.scope.split(" ").sort()).toEqual(asked.split(" ").sort());
  });

  it("keeps the published scope it was caught up to, so a request naming none carries it", async () => {
    const omitted = await sentTo(await get(authorizePath(undefined), false));
    expect(omitted.pathname).toBe("/auth/sign-in");
    expect(omitted.searchParams.get("scope")?.split(" ").sort()).toEqual(
      `${REGISTERED} ${PUBLISHED}`.split(" ").sort(),
    );
  });

  it("is answered login_required under prompt=none from nobody signed in, and is not caught up", async () => {
    const registration = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "signed-in-apps-silent",
        application_type: "native",
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: REGISTERED,
      }),
    });
    expect(registration.status).toBe(201);
    const silent = ((await registration.json()) as { client_id: string })
      .client_id;

    const asked = `${REGISTERED} ${PUBLISHED}`;
    const answered = await sentTo(
      await get(`${authorizePath(asked, silent)}&prompt=none`, false),
    );
    expect(answered.href.startsWith(CALLBACK), String(answered)).toBe(true);
    expect(answered.searchParams.get("error")).toBe("login_required");
    // The registration is as it was: a request naming no scope carries it.
    const omitted = await sentTo(
      await get(authorizePath(undefined, silent), false),
    );
    expect(omitted.pathname).toBe("/auth/sign-in");
    expect(omitted.searchParams.get("scope")).toBe(REGISTERED);
  });

  it("is limited by its grant, so a refreshed token shares the window of the one before it", async () => {
    const before = await remaining(tokens.access_token);
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(await remaining(refreshed.access_token)).toBe(before - 1);
  });
});

describe("a device signing in", () => {
  const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
  const HELD = "core.note:read";
  let deviceClient: string;

  async function startCode(scope: string): Promise<{
    device_code: string;
    user_code: string;
  }> {
    const response = await fetch(`${server!.apiUrl}/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: deviceClient, scope }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      device_code: string;
      user_code: string;
    };
  }

  /** The scope an authorize request that names none is judged against, which
   *  is the registration's own and is carried to the sign-in redirect. */
  async function registeredScope(): Promise<string[]> {
    const toSignIn = await sentTo(
      await get(authorizePath(undefined, deviceClient), false),
    );
    expect(toSignIn.pathname).toBe("/auth/sign-in");
    return (toSignIn.searchParams.get("scope") ?? "").split(" ").sort();
  }

  async function approve(userCode: string, ticked: string[]): Promise<void> {
    const claimed = await fetch(
      `${server!.apiUrl}/auth/device/consent?user_code=${userCode}`,
      { headers: { cookie } },
    );
    expect(claimed.status).toBe(200);
    await claimed.body?.cancel();
    const form = new URLSearchParams({
      user_code: userCode,
      decision: "approve",
    });
    for (const scope of ticked) form.append("scopes", scope);
    const decision = await fetch(`${server!.apiUrl}/auth/device/consent`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    expect(decision.status).toBe(200);
    await decision.body?.cancel();
  }

  it("is issued a code for a published scope it is not registered for, and its registration is as it was", async () => {
    const registration = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "signed-in-apps-device",
        application_type: "native",
        redirect_uris: [CALLBACK],
        grant_types: [DEVICE_GRANT, "authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: HELD,
      }),
    });
    expect(registration.status).toBe(201);
    deviceClient = ((await registration.json()) as { client_id: string })
      .client_id;
    expect(await registeredScope()).toEqual([HELD]);

    // Nobody is signed in, and the client's public id is all this request has.
    const code = await startCode(`${HELD} ${PUBLISHED}`);

    expect(await registeredScope()).toEqual([HELD]);

    // And until a person decides, the code is pending, as for any client.
    const pending = await fetch(`${server!.apiUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: code.device_code,
        client_id: deviceClient,
      }),
    });
    expect(pending.status).toBe(400);
    expect(((await pending.json()) as { error: string }).error).toBe(
      "authorization_pending",
    );
  });

  it("is registered only for what the person approved, which a narrower approval leaves out", async () => {
    const code = await startCode(`${HELD} ${PUBLISHED}`);
    await approve(code.user_code, [HELD]);

    expect(await registeredScope()).toEqual([HELD]);
  });

  it("is registered for the published scope once the person approves it, and the token carries it", async () => {
    const code = await startCode(`${HELD} ${PUBLISHED}`);
    await approve(code.user_code, [HELD, PUBLISHED]);

    expect(await registeredScope()).toEqual([HELD, PUBLISHED].sort());
    const redeemed = await fetch(`${server!.apiUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: code.device_code,
        client_id: deviceClient,
      }),
    });
    expect(redeemed.status).toBe(200);
    const body = (await redeemed.json()) as { scope: string };
    expect(body.scope.split(" ").sort()).toEqual([HELD, PUBLISHED].sort());
  });
});
