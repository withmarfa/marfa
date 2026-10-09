import { createHash, randomBytes } from "node:crypto";
import type { FreshServer } from "./fresh-server.js";
import { TEST_OWNER } from "./target.js";

/**
 * The steps an app and a person take through the sign-in operations, on a
 * server of the fixture's own: register, sign in, authorize, decide, and
 * exchange. Each returns what the server answered, so a fixture asserts the
 * answer rather than trusting a helper that threw on the unexpected.
 */

/** The redirect URI every app here registers. Nothing listens on it. */
export const CALLBACK = "http://127.0.0.1:9/callback";

/** The origin the issuer names, which the browser operations trust. */
export async function issuerOrigin(server: FreshServer): Promise<string> {
  const discovery = await fetch(
    `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
  );
  return new URL(((await discovery.json()) as { issuer: string }).issuer)
    .origin;
}

/** The owner's session cookie, from a password sign-in. */
export async function signIn(
  server: FreshServer,
  origin: string,
): Promise<string> {
  const response = await fetch(`${server.apiUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(TEST_OWNER),
  });
  if (response.status !== 200) {
    throw new Error(`the owner could not sign in: ${String(response.status)}`);
  }
  const cookie = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  if (cookie === undefined) throw new Error("sign-in set no session cookie");
  return cookie;
}

export interface App {
  clientId: string;
  clientSecret?: string;
}

/** Registers a public native app for the code flow with no credential. */
export async function registerApp(
  server: FreshServer,
  scope: string,
  extra: Record<string, unknown> = {},
): Promise<App> {
  const response = await fetch(`${server.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "signed-in fixture",
      application_type: "native",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope,
      ...extra,
    }),
  });
  if (response.status !== 201) {
    throw new Error(
      `registration answered ${String(response.status)}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    client_id: string;
    client_secret?: string;
  };
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** The parameters of an authorization request, with PKCE unless told not. */
export function authorizeQuery(
  clientId: string,
  scope: string,
  proof: Pkce | undefined,
  extra: Record<string, string> = {},
): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "signed-in-fixture",
    scope,
    ...(proof === undefined
      ? {}
      : { code_challenge: proof.challenge, code_challenge_method: "S256" }),
    ...extra,
  });
}

/** `GET /auth/oauth2/authorize` as `cookie`'s browser, or nobody's. */
export function authorize(
  server: FreshServer,
  query: URLSearchParams,
  cookie?: string,
): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/oauth2/authorize?${query.toString()}`, {
    redirect: "manual",
    headers: cookie === undefined ? {} : { cookie },
  });
}

/**
 * Where an answer sends the caller: a `302`'s `Location`, or the `url` the
 * provider answers a program's request with. Undefined for neither.
 */
export async function sentTo(
  server: FreshServer,
  response: Response,
): Promise<URL | undefined> {
  if (response.status === 302) {
    const location = response.headers.get("location");
    return location === null ? undefined : new URL(location, server.apiUrl);
  }
  if (response.status !== 200) return undefined;
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    return undefined;
  }
  const body = (await response.json()) as { url?: string };
  return body.url === undefined ? undefined : new URL(body.url, server.apiUrl);
}

/**
 * The person's decision on the consent screen `consent` is the address of,
 * posting the scopes they left ticked. Answers where the server sends them.
 */
export async function decide(
  server: FreshServer,
  origin: string,
  cookie: string,
  consent: URL,
  accept: boolean,
  scopes: readonly string[],
): Promise<URL | undefined> {
  const decision = await fetch(`${server.apiUrl}/auth/authorize/decision`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams([
      ["accept", String(accept)],
      ["oauth_query", consent.search.slice(1)],
      ...scopes.map((s): [string, string] => ["scopes", s]),
    ]),
  });
  return sentTo(server, decision);
}

/** One request to the token operation, answered status and body. */
export async function token(
  server: FreshServer,
  form: Record<string, string>,
  app?: App,
): Promise<{ status: number; body: TokenAnswer }> {
  const response = await fetch(`${server.apiUrl}/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(app === undefined ? {} : basicAuthorization(app)),
    },
    body: new URLSearchParams(form),
  });
  return {
    status: response.status,
    body: (await response.json()) as TokenAnswer,
  };
}

export interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
}

/** HTTP Basic for an app registered with a secret, as RFC 6749 encodes it. */
export function basicAuthorization(app: App): Record<string, string> {
  if (app.clientSecret === undefined) return {};
  return {
    authorization: `Basic ${Buffer.from(
      `${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`,
    ).toString("base64")}`,
  };
}

/**
 * The code an accepted authorization sends to the redirect URI, with the
 * verifier that redeems it: through the consent screen when no consent
 * covers the request, at once when one does.
 */
export async function codeFor(
  server: FreshServer,
  origin: string,
  cookie: string,
  app: App,
  scope: string,
): Promise<{ code: string; verifier: string; silent: boolean }> {
  const proof = pkce();
  let landed = await sentTo(
    server,
    await authorize(server, authorizeQuery(app.clientId, scope, proof), cookie),
  );
  const silent = landed?.href.startsWith(CALLBACK) === true;
  if (!silent && landed !== undefined) {
    landed = await decide(server, origin, cookie, landed, true, [
      ...new Set(scope.split(" ")),
    ]);
  }
  const code = landed?.searchParams.get("code");
  if (code === null || code === undefined) {
    throw new Error(`no code on ${String(landed)}`);
  }
  return { code, verifier: proof.verifier, silent };
}

/** The tokens an accepted authorization exchanges its code for. */
export async function connect(
  server: FreshServer,
  origin: string,
  cookie: string,
  app: App,
  scope: string,
): Promise<TokenAnswer> {
  const { code, verifier } = await codeFor(server, origin, cookie, app, scope);
  const answer = await token(
    server,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      client_id: app.clientId,
    },
    app,
  );
  if (answer.status !== 200) {
    throw new Error(
      `the code exchange answered ${String(answer.status)}: ${JSON.stringify(answer.body)}`,
    );
  }
  return answer.body;
}

/** What `GET /items` answers an access token, which shows whether it works. */
export async function itemsStatus(
  server: FreshServer,
  accessToken: string,
): Promise<number> {
  const response = await fetch(`${server.apiUrl}/items?limit=1`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  await response.body?.cancel();
  return response.status;
}
