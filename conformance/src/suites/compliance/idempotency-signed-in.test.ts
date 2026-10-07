import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A signed-in app's idempotency key belongs to the app and the person, not to
 * the access token it sent the request with. A person has to be signed in to
 * approve an app, and an instance has one owner, so this file boots a server
 * of its own and creates the owner there.
 */
let server: FreshServer | undefined;
let origin: string;
let cookie: string;

const OWNER = {
  email: "replay@example.com",
  password: "correct horse battery",
};
const CALLBACK = "http://127.0.0.1:9/callback";
const SCOPE = "core.note:write offline_access";

interface Tokens {
  access_token: string;
  refresh_token: string;
}

beforeAll(async () => {
  server = await bootFreshServer("idempotency-signed-in");
  const operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.operatorKey,
  });
  expect((await operator.createOwner(OWNER)).status).toBe(201);
  const discovery = await fetch(
    `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
  );
  origin = new URL(((await discovery.json()) as { issuer: string }).issuer)
    .origin;
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

async function register(name: string): Promise<string> {
  const registration = await fetch(`${server!.apiUrl}/auth/oauth2/register`, {
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
  return ((await registration.json()) as { client_id: string }).client_id;
}

async function tokenFor(
  clientId: string,
  form: Record<string, string>,
): Promise<Tokens> {
  const response = await fetch(`${server!.apiUrl}/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ client_id: clientId, ...form }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}

function location(response: Response): URL {
  return new URL(response.headers.get("location") ?? "", origin);
}

/** The person approves the app at its registered scope; the app gets tokens. */
async function approve(clientId: string): Promise<Tokens> {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "idempotency-signed-in",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: SCOPE,
  });
  const authorize = await fetch(
    `${server!.apiUrl}/auth/oauth2/authorize?${params.toString()}`,
    { redirect: "manual", headers: { cookie } },
  );
  let consent: URL;
  if (authorize.status === 302) consent = location(authorize);
  else {
    expect(authorize.status).toBe(200);
    const body = (await authorize.json()) as {
      redirect?: boolean;
      url?: string;
    };
    expect(body.redirect).toBe(true);
    consent = new URL(body.url ?? "", origin);
  }
  expect(consent.pathname).toBe("/auth/authorize");
  const form = new URLSearchParams({
    accept: "true",
    oauth_query: consent.search.slice(1),
  });
  for (const scope of SCOPE.split(" ")) form.append("scopes", scope);
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
  return tokenFor(clientId, {
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: CALLBACK,
    code_verifier: verifier,
  });
}

async function create(accessToken: string, key: string, body: string) {
  return new MarfaClient({
    baseUrl: server!.apiUrl,
    apiKey: accessToken,
  }).rawRequest<{ item: { id: string } }>("/items", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: { type: "core.note", properties: { body } },
  });
}

describe("a signed-in app's idempotency key", () => {
  it("holds a key to the app and person across a token refresh", async () => {
    const app = await register("replay-app");
    const tokens = await approve(app);
    const key = `signed-in-${randomUUID()}`;

    const first = await create(tokens.access_token, key, "written once");
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();

    const refreshed = await tokenFor(app, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(
      refreshed.access_token,
      "the refresh issued the same token, so the repeat is not from another one",
    ).not.toBe(tokens.access_token);

    const repeat = await create(refreshed.access_token, key, "written once");
    expect(
      repeat.status,
      `the repeat under the new token was not replayed: ${JSON.stringify(repeat.error)}`,
    ).toBe(201);
    expect(repeat.headers.get("Idempotency-Replayed")).toBe("true");
    expect(repeat.data).toEqual(first.data);

    // The witness: the key is held to the pair, not open to every signed-in
    // credential, so another app of the same person writes its own row.
    const other = await approve(await register("replay-other-app"));
    const own = await create(other.access_token, key, "written once");
    expect(own.status, JSON.stringify(own.error)).toBe(201);
    expect(own.headers.get("Idempotency-Replayed")).toBeNull();
    expect(own.data.item.id).not.toBe(first.data.item.id);
  });

  it("lets a refreshed token read and cancel the jobs an earlier token queued", async () => {
    const app = await register("job-app");
    const tokens = await approve(app);
    const tag = `signed-in-job-${randomUUID()}`;
    const note = await new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: tokens.access_token,
    }).rawRequest<{ item: { id: string } }>("/items", {
      method: "POST",
      body: { type: "core.note", properties: { body: "for a job" }, tags: [tag] },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    const queued = await new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: tokens.access_token,
    }).bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const jobId = (queued.data as { id: string }).id;

    const refreshed = await tokenFor(app, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    const asRefreshed = new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: refreshed.access_token,
    });
    expect((await asRefreshed.bulkActionStatus(jobId)).status).toBe(200);
    expect((await asRefreshed.bulkActionCancel(jobId)).status).toBe(200);

    // The witness: the job is held to the pair, so another app of the same
    // person is refused it.
    const other = await approve(await register("job-other-app"));
    const refused = await new MarfaClient({
      baseUrl: server!.apiUrl,
      apiKey: other.access_token,
    }).bulkActionStatus(jobId);
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
  });
});
