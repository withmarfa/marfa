/**
 * `offline_access` decides whether a grant gets a refresh token, and both
 * token-issuing paths have to answer that the same way.
 *
 * The library issues a refresh token only when the grant's scopes carry
 * `offline_access`, and its rotation lives inside the same call: rotating
 * revokes the presented token and links the replacement into the family, so
 * a replayed token is detectable and the whole chain can be terminated.
 *
 * Marfa's device route writes its own token rows at the terminal token step
 * rather than going through the library, and it used to mint a refresh token
 * for every approved grant. A device refresh token minted without
 * `offline_access` was therefore never eligible for rotation: presenting it
 * returned a fresh access token and left the row untouched, indefinitely.
 * Nothing could make it stale, so the replay defense never had anything to
 * fire on and the credential lasted until someone deleted the row by hand.
 * The grants that behavior reached are the least-watched ones there are —
 * a device is signed in once and left alone.
 *
 * The two paths now agree: no `offline_access`, no refresh token. With it,
 * a device refresh token rotates and its replay poisons the family, which
 * is what the authorization-code path has always done.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";

// Every test here signs a user up and in (two password hashes) and drives at
// least one full grant end to end before it asserts anything. That is real
// work to fit inside the default budget on a machine running the rest of the
// suite beside it, and an overrun reports as a timeout — a result that says
// nothing about the property under test.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function betterAuthSchema() {
  return import("../storage/sqlite/schema.js");
}

/** Seed a public PKCE client registered for both token-issuing grants, so
 *  one client can drive the device route and the authorization-code path in
 *  the same test. A `null` scope column means no ceiling: the client tracks
 *  whatever the server advertises, which keeps this suite independent of the
 *  live type registry. */
async function seedClient(c: TestContext): Promise<string> {
  const clientId = `client_${randomBytes(5).toString("hex")}`;
  if (!c.storage.betterAuthDb) {
    throw new Error("seedClient: storage.betterAuthDb missing");
  }
  const schemaModule = await betterAuthSchema();
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const asColumn = (values: readonly string[]): unknown =>
    JSON.stringify([...values]);
  const now = new Date();
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: `pk_${randomBytes(5).toString("hex")}`,
    clientId,
    name: "Refresh Parity Client",
    redirectUris: asColumn([CALLBACK]),
    grantTypes: asColumn([DEVICE_GRANT, "authorization_code", "refresh_token"]),
    responseTypes: asColumn(["code"]),
    scopes: null,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: true,
    tokenEndpointAuthMethod: "none",
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

async function signInUser(c: TestContext): Promise<string> {
  const { email, password } = c.owner;
  const signInRes = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (signInRes.status !== 200) {
    throw new Error(`sign-in failed (${String(signInRes.status)})`);
  }
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  for (const part of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = part.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("sign-in: session_token cookie not found");
}

// ---------------------------------------------------------------------------
// The device route
// ---------------------------------------------------------------------------

interface TokenResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Initiate, approve at the consent screen, and poll once — the whole device
 *  grant, ending on the terminal token response. */
async function deviceGrant(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
): Promise<TokenResponse> {
  const initRes = await request(c.app, "POST", "/auth/device/code", {
    body: { client_id: clientId, scope },
    headers: { origin: ORIGIN },
  });
  expect(initRes.status).toBe(200);
  const init = (await initRes.json()) as {
    device_code: string;
    user_code: string;
  };

  const consentRes = await request(c.app, "POST", "/auth/device/consent", {
    form: {
      user_code: init.user_code,
      decision: "approve",
      // Everything ticked, which is what the screen submits untouched:
      // the approval form carries a checkbox per requested scope, so a
      // post with none is a denial rather than a full approval.
      scopes: scope.split(" ").filter(Boolean),
    },
    headers: { cookie, origin: ORIGIN },
  });
  expect(consentRes.status).toBe(200);

  return pollDeviceToken(c, init.device_code, clientId);
}

async function pollDeviceToken(
  c: TestContext,
  deviceCode: string,
  clientId: string,
): Promise<TokenResponse> {
  const res = await request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: clientId,
    },
    headers: { origin: ORIGIN },
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// The authorization-code path
// ---------------------------------------------------------------------------

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Authorize, accept at the consent screen, exchange the code — the whole
 *  authorization-code grant, ending on the same terminal token response
 *  shape the device route produces. */
async function authorizationCodeGrant(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
): Promise<TokenResponse> {
  const { verifier, challenge } = pkcePair();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "parity-state",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorizeRes = await request(
    c.app,
    "GET",
    `/auth/oauth2/authorize?${params.toString()}`,
    { headers: { cookie } },
  );
  expect(authorizeRes.status).toBe(302);
  const location = authorizeRes.headers.get("location") ?? "";
  // The interactive path, and only that: a device approval now writes the
  // consent row the browser flow skips on, so each case gives the code leg
  // its own client, and this helper refuses a silent answer rather than
  // accepting whichever branch the plugin took. The property under test is
  // that the decision handler and the device route agree, which needs the
  // decision handler to run.
  if (!location.includes("/auth/authorize?")) {
    throw new Error(`authorize did not reach consent: ${location}`);
  }
  const signedQuery = location.slice(location.indexOf("?") + 1);
  const decisionRes = await request(c.app, "POST", "/auth/authorize/decision", {
    form: {
      accept: "true",
      oauth_query: signedQuery,
      scopes: scope.split(" ").filter(Boolean),
    },
    headers: { cookie, origin: ORIGIN },
  });
  expect(decisionRes.status).toBe(302);
  const code = new URL(
    decisionRes.headers.get("location") ?? "",
    ORIGIN,
  ).searchParams.get("code");
  if (!code) throw new Error("no code on callback redirect");

  const tokenRes = await request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    },
    headers: { origin: ORIGIN },
  });
  return {
    status: tokenRes.status,
    body: (await tokenRes.json()) as Record<string, unknown>,
  };
}

/** Present a refresh token at the token endpoint. */
async function refresh(
  c: TestContext,
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    },
    headers: { origin: ORIGIN },
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** Call the data plane with a bearer token, to establish that the token is
 *  live rather than to test the route.
 *
 *  This used to call `/profile/me`, described here as "the cheapest route that
 *  any authenticated credential can reach" — which was true and was the defect
 *  closed by gating Category 2: an OAuth token now reaches the profile only if
 *  its grant asked for it. These grants ask for `core.note:read`, so
 *  the listing is the route they actually cover, and this helper goes back to
 *  proving liveness rather than incidentally proving a gate was missing. */
async function callWithAccessToken(
  c: TestContext,
  accessToken: string,
): Promise<number> {
  const res = await request(c.app, "GET", "/items?type=core.note", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return res.status;
}

describe("refresh-token issuance is gated on offline_access", () => {
  it("neither path hands out a refresh token when the grant did not ask to stay signed in", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx);
    const clientId = await seedClient(ctx);

    // Deliberately no `offline_access`: this is a grant approved for data
    // access and nothing else.
    const scope = "openid core.note:read";

    const viaDevice = await deviceGrant(ctx, clientId, cookie, scope);
    expect(viaDevice.status).toBe(200);
    expect(viaDevice.body.access_token).toMatch(/^marfa_at_/);

    // Its own client: the device approval above wrote a consent row for
    // `clientId`, and the browser flow for that client would now skip.
    const codeClientId = await seedClient(ctx);
    const viaCode = await authorizationCodeGrant(
      ctx,
      codeClientId,
      cookie,
      scope,
    );
    expect(viaCode.status).toBe(200);
    expect(viaCode.body.access_token).toBeTruthy();

    // The property: the two paths answer the same way. Asserting the pair
    // together is the point — the device route agreeing with the library is
    // what stops a second implementation of token issuance drifting from the
    // first, which is exactly how this defect arrived.
    expect(viaCode.body.refresh_token).toBeUndefined();
    expect(viaDevice.body.refresh_token).toBeUndefined();

    // And the access token still works, so the grant is usable — the fix
    // removes a credential that should never have existed, not the session.
    expect(
      await callWithAccessToken(ctx, viaDevice.body.access_token as string),
    ).toBe(200);
  });

  it("both paths hand one out when the grant did ask", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx);
    const clientId = await seedClient(ctx);
    const scope = "openid offline_access core.note:read";

    const viaDevice = await deviceGrant(ctx, clientId, cookie, scope);
    expect(viaDevice.status).toBe(200);
    expect(viaDevice.body.refresh_token).toMatch(/^marfa_rt_/);

    // Its own client: the device approval above wrote a consent row for
    // `clientId`, and the browser flow for that client would now skip.
    const codeClientId = await seedClient(ctx);
    const viaCode = await authorizationCodeGrant(
      ctx,
      codeClientId,
      cookie,
      scope,
    );
    expect(viaCode.status).toBe(200);
    expect(viaCode.body.refresh_token).toBeTruthy();
  });

  it("a device refresh token rotates, and replaying the rotated-away one kills the family", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx);
    const clientId = await seedClient(ctx);

    const granted = await deviceGrant(
      ctx,
      clientId,
      cookie,
      "openid offline_access core.note:read",
    );
    const original = granted.body.refresh_token as string;
    expect(original).toMatch(/^marfa_rt_/);

    // Rotation: the refresh returns a *new* refresh token, and the one just
    // presented is spent. A device token that never rotated returned only an
    // access token here, which is what made it permanent.
    const rotated = await refresh(ctx, clientId, original);
    expect(rotated.status).toBe(200);
    const replacement = rotated.body.refresh_token;
    expect(typeof replacement).toBe("string");
    expect(replacement).not.toBe(original);

    const liveAccess = rotated.body.access_token as string;
    expect(await callWithAccessToken(ctx, liveAccess)).toBe(200);

    // The replay defense: presenting the spent token is terminal, and it
    // poisons the whole chain rather than just refusing the one request.
    const replay = await refresh(ctx, clientId, original);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");

    // The replacement is dead too — that is the family being invalidated
    // rather than a single token being refused.
    const afterReplay = await refresh(ctx, clientId, String(replacement));
    expect(afterReplay.status).toBe(400);
    expect(afterReplay.body.error).toBe("invalid_grant");

    // And the access tokens the chain issued go with it.
    expect(await callWithAccessToken(ctx, liveAccess)).toBe(401);
  });
});
