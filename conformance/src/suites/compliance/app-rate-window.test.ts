import { TEST_OWNER as OWNER } from "../../utils/target.js";
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A signed-in app's requests against the cap on one credential's requests,
 * on a server of its own with the limiter on and a cap of three.
 */
const CAP = 3;
const CALLBACK = "http://127.0.0.1:9/callback";
const SCOPE = "core.note:read offline_access";

let server: FreshServer;
let origin: string;
let cookie: string;

beforeAll(async () => {
  server = await bootFreshServer("app-rate-window", {
    MARFA_RATE_LIMIT_ENABLED: "true",
    MARFA_RATE_LIMIT_REQUESTS: String(CAP),
  });
  const discovery = await fetch(
    `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
  );
  const { issuer } = (await discovery.json()) as { issuer: string };
  origin = new URL(issuer).origin;
  const signedIn = await fetch(`${server.apiUrl}/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(OWNER),
  });
  expect(signedIn.status).toBe(200);
  const session = /(?:^|,\s*)([\w.-]*marfa_session=[^;]+)/.exec(
    signedIn.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(session, "sign-in set no session cookie").toBeTruthy();
  cookie = session!;
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

type Tokens = { access_token: string; refresh_token: string };

async function token(
  clientId: string,
  form: Record<string, string>,
): Promise<Tokens> {
  const response = await fetch(`${server.apiUrl}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ client_id: clientId, ...form }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}

/** Where the provider sends a script's fetch, or a browser's `302`. */
async function sentTo(response: Response): Promise<URL> {
  if (response.status === 302) {
    return new URL(response.headers.get("location") ?? "", origin);
  }
  expect(response.status).toBe(200);
  const body = (await response.json()) as { url?: string };
  return new URL(body.url ?? "", origin);
}

/** An app registered and approved by the signed-in owner, with its tokens. */
async function approvedApp(name: string) {
  const registration = await fetch(`${server.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      application_type: "native",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  expect(registration.status).toBe(201);
  const clientId = ((await registration.json()) as { client_id: string })
    .client_id;
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: name,
    scope: SCOPE,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const consent = await sentTo(
    await fetch(`${server.apiUrl}/auth/oauth2/authorize?${params.toString()}`, {
      redirect: "manual",
      headers: { cookie },
    }),
  );
  expect(consent.pathname).toBe("/auth/authorize");
  const form = new URLSearchParams({
    accept: "true",
    oauth_query: consent.search.slice(1),
  });
  for (const scope of SCOPE.split(" ")) form.append("scopes", scope);
  const decision = await fetch(`${server.apiUrl}/auth/authorize/decision`, {
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
  const code = new URL(
    decision.headers.get("location") ?? "",
    origin,
  ).searchParams.get("code");
  expect(code).toBeTruthy();
  const tokens = await token(clientId, {
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: CALLBACK,
    code_verifier: verifier,
  });
  return { clientId, tokens };
}

async function read(accessToken: string): Promise<Response> {
  const response = await fetch(`${server.apiUrl}/items?type=core.note`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  await response.body?.cancel();
  return response;
}

describe("a signed-in app against the request cap", () => {
  it("is limited by its grant, so a refreshed token shares the window of the one before it", async () => {
    const app = await approvedApp("app-rate-window");
    const other = await approvedApp("app-rate-window-other");
    for (let n = 1; n < CAP; n += 1) {
      expect((await read(app.tokens.access_token)).status).toBe(200);
    }
    const refreshed = await token(app.clientId, {
      grant_type: "refresh_token",
      refresh_token: app.tokens.refresh_token,
    });
    expect(refreshed.access_token).not.toBe(app.tokens.access_token);
    expect((await read(refreshed.access_token)).status).toBe(200);

    const refused = await read(refreshed.access_token);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(
      1,
    );
    expect((await read(other.tokens.access_token)).status).toBe(200);
  });
});
