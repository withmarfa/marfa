import { controlRequest } from "../../utils/control-request.js";
import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { createServer } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A person's browser session ending, and the apps they connected. An app is
 * not the browser that approved it, so every door that ends a browser leaves
 * the app's access, refresh and consent as they were. A person has to be
 * signed in, and an instance has one owner, so this file boots a server of
 * its own and claims its owner through the production local command.
 *
 * Two apps are connected once, at the start, and every door then ends a fresh
 * browser session: one holds a refresh token and one holds access alone. The
 * file ends by restarting the server and asking again.
 */
let server: FreshServer | undefined;
let origin: string;

const CALLBACK = "http://127.0.0.1:9/callback";
const SCOPE = "core.note:read";

interface App {
  clientId: string;
  access: string;
  refresh?: string;
  idToken?: string;
}

/** The apps the browser about to end has just approved. */
let refreshing: App;
let accessOnly: App;
/** The cookie of a browser that lives: each door leaves one for the next. The
 *  password sign-in is limited to ten attempts a quarter hour, so no door
 *  signs in more than it must. */
let live: string;
let password = OWNER.password;

beforeAll(async () => {
  // A server restarted on the same address with the same secret is the same
  // instance: the provider's signing keys are sealed with the secret, and a
  // token's issuer is the address.
  const port = await freePort();
  server = await bootFreshServer("browser-sessions", {
    MARFA_AUTH_SECRET: randomBytes(32).toString("hex"),
    PORT: String(port),
  });
  const discovery = await fetch(
    `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
  );
  origin = new URL(((await discovery.json()) as { issuer: string }).issuer)
    .origin;

  live = await signIn();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/**
 * A request as a browser navigating sends it. `fetch` stamps its own fetch
 * metadata over the headers it is given, so the provider would read it as a
 * program's call and answer a program.
 */
function navigate(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; text: string; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, server!.apiUrl);
    const req = request(
      url,
      {
        method,
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-mode": "navigate",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            cookies: (res.headers["set-cookie"] ?? []).map(
              (cookie) => cookie.split(";")[0] ?? "",
            ),
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function signIn(): Promise<string> {
  const response = await fetch(`${server!.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: OWNER.email, password }),
  });
  expect(response.status).toBe(200);
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(cookie, "sign-in set no session cookie").toBeTruthy();
  return cookie!;
}

/** The raw session token inside a signed cookie, which the revocation door takes. */
function rawToken(cookie: string): string {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  return value.slice(0, value.lastIndexOf("."));
}

async function post(
  path: string,
  cookie: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${server!.apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify(body),
  });
}

async function browserLive(cookie: string): Promise<boolean> {
  const response = await fetch(`${server!.apiUrl}/auth/get-session`, {
    headers: { cookie },
  });
  return (await response.json()) !== null;
}

async function register(scope: string): Promise<string> {
  const response = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "browser-sessions",
      application_type: "native",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/**
 * Authorize as `cookie`'s browser and accept at the consent screen, ending on
 * the form that exchanges the code. A consent that already stands answers
 * with the code at once.
 */
async function authorize(cookie: string, clientId: string, scope: string) {
  const verifier = randomBytes(32).toString("base64url");
  const response = await fetch(
    `${server!.apiUrl}/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "browser-sessions",
      scope,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString()}`,
    { redirect: "manual", headers: { cookie } },
  );
  let landed = await whereTo(response);
  const silent = landed.startsWith(CALLBACK);
  if (!silent) {
    const decision = await fetch(`${server!.apiUrl}/auth/authorize/decision`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams([
        ["accept", "true"],
        ["oauth_query", landed.slice(landed.indexOf("?") + 1)],
        ...scope.split(" ").map((s): [string, string] => ["scopes", s]),
      ]),
    });
    landed = await whereTo(decision);
  }
  const code = new URL(landed, origin).searchParams.get("code");
  expect(code, `no code on ${landed}`).toBeTruthy();
  return {
    silent,
    form: {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      client_id: clientId,
    },
  };
}

async function whereTo(response: Response): Promise<string> {
  if (response.status === 302) return response.headers.get("location") ?? "";
  expect(response.status).toBe(200);
  const body = (await response.json()) as { url?: string };
  return body.url ?? "";
}

function token(form: Record<string, string>): Promise<Response> {
  return fetch(`${server!.apiUrl}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams(form),
  });
}

async function connect(cookie: string, scope: string): Promise<App> {
  const clientId = await register(scope);
  const { form } = await authorize(cookie, clientId, scope);
  const response = await token(form);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
  };
  return {
    clientId,
    access: body.access_token,
    refresh: body.refresh_token,
    idToken: body.id_token,
  };
}

/** Both kinds of app, approved by this browser, so ending it is what is asked. */
async function connectApps(cookie: string): Promise<void> {
  refreshing = await connect(cookie, `${SCOPE} offline_access openid`);
  accessOnly = await connect(cookie, SCOPE);
}

async function dataStatus(access: string): Promise<number> {
  const response = await fetch(`${server!.apiUrl}/items?type=core.note`, {
    headers: { authorization: `Bearer ${access}` },
  });
  await response.body?.cancel();
  return response.status;
}

/** Ask both apps for what they hold, and rotate the refresh token. */
async function expectAppsConnected(cookie: string): Promise<void> {
  expect(await dataStatus(refreshing.access)).toBe(200);
  expect(await dataStatus(accessOnly.access)).toBe(200);

  const renewed = await token({
    grant_type: "refresh_token",
    refresh_token: refreshing.refresh!,
    client_id: refreshing.clientId,
  });
  expect(renewed.status).toBe(200);
  const next = (await renewed.json()) as {
    access_token: string;
    refresh_token: string;
  };
  refreshing = {
    ...refreshing,
    access: next.access_token,
    refresh: next.refresh_token,
  };
  expect(await dataStatus(refreshing.access)).toBe(200);

  // The consent stands, so a later authorization it covers asks nobody.
  const again = await authorize(cookie, accessOnly.clientId, SCOPE);
  expect(again.silent).toBe(true);
}

describe("a browser session ending", () => {
  it("through browser sign-out leaves every app connected", async () => {
    const browser = live;
    await connectApps(browser);
    expect((await post("/auth/sign-out", browser)).status).toBe(200);
    expect(await browserLive(browser)).toBe(false);

    live = await signIn();
    await expectAppsConnected(live);
  });

  it("through ending one session leaves every app connected", async () => {
    const ended = live;
    await connectApps(ended);
    live = await signIn();
    const res = await post("/auth/revoke-session", live, {
      token: rawToken(ended),
    });
    expect(res.status).toBe(200);
    expect(await browserLive(ended)).toBe(false);
    expect(await browserLive(live)).toBe(true);

    await expectAppsConnected(live);
  });

  it("through ending the other sessions leaves every app connected", async () => {
    const ended = await signIn();
    await connectApps(ended);
    expect((await post("/auth/revoke-other-sessions", live)).status).toBe(200);
    expect(await browserLive(ended)).toBe(false);
    expect(await browserLive(live)).toBe(true);

    await expectAppsConnected(live);
  });

  it("through ending every session leaves every app connected", async () => {
    const ended = live;
    await connectApps(ended);
    expect((await post("/auth/revoke-sessions", live)).status).toBe(200);
    expect(await browserLive(ended)).toBe(false);

    live = await signIn();
    await expectAppsConnected(live);
  });

  it("through the provider's end-session, once confirmed, leaves every app connected", async () => {
    const browser = live;
    await connectApps(browser);
    const asked = await navigate("GET", "/auth/oauth2/end-session", {
      cookie: browser,
    });
    expect(asked.status, asked.text).toBe(200);
    // Asking changes nothing: the person confirms on the page it answers with.
    expect(await browserLive(browser)).toBe(true);
    const action = /action="([^"]+)"/.exec(asked.text)?.[1];
    expect(action, "the page named no form action").toBeTruthy();
    const confirmation = asked.cookies.filter((cookie) =>
      cookie.includes("oauth_logout_confirmation"),
    );
    expect(confirmation.length).toBeGreaterThan(0);

    const confirmed = await navigate(
      "POST",
      new URL(action!.replaceAll("&amp;", "&"), server!.apiUrl).pathname,
      {
        cookie: [browser, ...confirmation].join("; "),
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      "action=confirm",
    );
    expect(confirmed.status, confirmed.text).toBeLessThan(400);
    expect(await browserLive(browser)).toBe(false);

    live = await signIn();
    await expectAppsConnected(live);
  });

  it("through a password change that ends the other sessions leaves every app connected", async () => {
    const ended = await signIn();
    await connectApps(ended);
    const next = "a different horse battery";
    const res = await post("/auth/change-password", live, {
      currentPassword: password,
      newPassword: next,
      revokeOtherSessions: true,
    });
    expect(res.status).toBe(200);
    password = next;
    expect(await browserLive(live)).toBe(true);
    expect(await browserLive(ended)).toBe(false);

    await expectAppsConnected(live);
  });

  it("refuses an authorization code once the browser that approved it has ended, and accepts one whose browser lives", async () => {
    const browser = live;
    const accepted = await authorize(browser, accessOnly.clientId, SCOPE);
    const orphaned = await authorize(browser, accessOnly.clientId, SCOPE);

    // The witness: a code whose browser lives is exchanged.
    expect((await token(accepted.form)).status).toBe(200);

    expect((await post("/auth/sign-out", browser)).status).toBe(200);
    const refused = await token(orphaned.form);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
    live = await signIn();
  });

  it("local recovery revokes browser sessions and keeps apps connected", async () => {
    const ended = live;
    await connectApps(ended);
    const recovered = await controlRequest(
      server!.controlSocket,
      "/_control/owner/recover",
      { method: "POST", body: { password: OWNER.password } },
    );
    expect(recovered.status).toBe(200);
    password = OWNER.password;
    expect(await browserLive(ended)).toBe(false);
    live = await signIn();
    await expectAppsConnected(live);
  });

  it("leaves every app connected across a restart of the server", async () => {
    await connectApps(live);
    await server!.restart();
    await expectAppsConnected(live);

    expect((await post("/auth/sign-out", live)).status).toBe(200);
    await expectAppsConnected(await signIn());
  });

  it("advertises no back-channel logout, since no app is notified of a browser ending", async () => {
    for (const path of [
      "/auth/.well-known/openid-configuration",
      "/auth/.well-known/oauth-authorization-server",
    ]) {
      const response = await fetch(`${server!.apiUrl}${path}`);
      expect(response.status).toBe(200);
      const document = (await response.json()) as Record<string, unknown>;
      expect(document.backchannel_logout_supported).toBe(false);
      expect(document.backchannel_logout_session_supported).toBe(false);
    }
  });

  it("registers an app without a back-channel logout address and does not echo one", async () => {
    const response = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "browser-sessions-logout-address",
        application_type: "native",
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        backchannel_logout_uri: "https://app.example/logout",
        backchannel_logout_session_required: true,
      }),
    });
    expect(response.status).toBe(201);
    const answer = (await response.json()) as Record<string, unknown>;
    expect(answer.client_id).toBeTruthy();
    expect(answer).not.toHaveProperty("backchannel_logout_uri");
    expect(answer).not.toHaveProperty("backchannel_logout_session_required");
  });
});
