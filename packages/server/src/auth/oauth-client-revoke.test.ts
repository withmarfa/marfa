/**
 * A refresh token handed to `POST /auth/oauth2/revoke` ends the grant it
 * belongs to, not just the token.
 *
 * A grant is two records, the plugin's consent row and Marfa's
 * `system.connection` projection, and the plugin's revoke endpoint used to
 * reach neither: it marked the presented refresh token revoked and deleted
 * the access tokens under it, and stopped. The app had done the one thing
 * RFC 7009 gives it for "forget me", the security page still listed it,
 * the consent row still stood, and the next authorize was answered
 * silently with a fresh code. The after-hook this file pins runs the same
 * cascade the person's own Disconnect runs, keyed on the row the token
 * resolves to rather than on the endpoint's response, because the endpoint
 * answers 200 with nothing in it whether or not it did anything.
 *
 * Two bounds beside the positive case. A refresh token presented under a
 * different registered client is a no-op for the plugin and has to stay a
 * no-op here, or a stolen refresh token becomes a denial-of-service on
 * somebody else's grant. And an access-token revoke stays token-only: that
 * is a sign-out, not a disconnect.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import * as logger from "../middleware/logger.js";
import { resolveRevokeClientId } from "./oauth-provider.js";

// Every case signs a user up and in and drives a full authorization-code
// grant before asserting anything, which is more than the default budget
// allows on a machine running the rest of the suite beside it.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";

async function betterAuthSchema(c: TestContext) {
  return c.storage.betterAuthDialect === "pg"
    ? await import("../storage/pg/schema.js")
    : await import("../storage/sqlite/schema.js");
}

/** A public PKCE client with no scope ceiling, registered for the code and
 *  refresh grants. */
async function seedClient(c: TestContext, name: string): Promise<string> {
  const clientId = `client_${randomBytes(5).toString("hex")}`;
  if (!c.storage.betterAuthDb) {
    throw new Error("seedClient: storage.betterAuthDb missing");
  }
  const schemaModule = await betterAuthSchema(c);
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const isPg = c.storage.betterAuthDialect === "pg";
  const asColumn = (values: readonly string[]): unknown =>
    isPg ? [...values] : JSON.stringify([...values]);
  const now = new Date();
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: `pk_${randomBytes(5).toString("hex")}`,
    clientId,
    name,
    redirectUris: asColumn([CALLBACK]),
    grantTypes: asColumn(["authorization_code", "refresh_token"]),
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

async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  const signUpRes = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Test User" },
    headers: { origin: ORIGIN },
  });
  if (signUpRes.status !== 200) {
    throw new Error(`sign-up failed (${String(signUpRes.status)})`);
  }
  await markEmailVerified(c.storage, email);
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

async function authUserIdFor(c: TestContext, email: string): Promise<string> {
  const schemaModule = await betterAuthSchema(c);
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => {
        where: (w: unknown) => Promise<{ id: string }[]>;
      };
    };
  };
  const rows = await db
    .select()
    .from(schemaModule.auth_user)
    .where(eq(schemaModule.auth_user.email, email));
  const id = rows[0]?.id;
  if (!id) throw new Error(`authUserIdFor: no auth_user for ${email}`);
  return id;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeParams(clientId: string, scope: string, challenge: string) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "revoke-state",
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
}

/** Authorize, accept at the consent screen, exchange the code. */
async function codeGrant(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
): Promise<Record<string, unknown>> {
  const { verifier, challenge } = pkcePair();
  const authorizeRes = await request(
    c.app,
    "GET",
    `/auth/oauth2/authorize?${authorizeParams(clientId, scope, challenge).toString()}`,
    { headers: { cookie } },
  );
  expect(authorizeRes.status).toBe(302);
  const location = authorizeRes.headers.get("location") ?? "";
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
  expect(tokenRes.status).toBe(200);
  return (await tokenRes.json()) as Record<string, unknown>;
}

/** What a fresh authorize does for a signed-in user: reaches the consent
 *  screen (a 200 page), or is answered silently with a code because a
 *  standing consent row covers it. The silent answer has two shapes, the
 *  plugin's own skip straight from its authorize endpoint and Marfa's skip
 *  on the consent route, and both count. */
async function authorizeOutcome(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
): Promise<"consent_screen" | "silent_code"> {
  const { challenge } = pkcePair();
  const authorizeRes = await request(
    c.app,
    "GET",
    `/auth/oauth2/authorize?${authorizeParams(clientId, scope, challenge).toString()}`,
    { headers: { cookie } },
  );
  expect(authorizeRes.status).toBe(302);
  const location = authorizeRes.headers.get("location") ?? "";
  if (isCallbackWithCode(location)) return "silent_code";
  if (!location.includes("/auth/authorize?")) {
    throw new Error(`authorize did not reach the consent route: ${location}`);
  }
  const consentRes = await request(c.app, "GET", location, {
    headers: { cookie },
  });
  if (consentRes.status === 200) return "consent_screen";
  const next = consentRes.headers.get("location") ?? "";
  if (consentRes.status === 302 && isCallbackWithCode(next)) {
    return "silent_code";
  }
  throw new Error(
    `unexpected consent outcome: ${String(consentRes.status)} ${next}`,
  );
}

function isCallbackWithCode(location: string): boolean {
  return (
    location.startsWith(CALLBACK) &&
    new URL(location).searchParams.get("code") !== null
  );
}

interface GrantRows {
  consents: number;
  accessTokens: number;
  refreshTokens: { revoked: boolean }[];
}

/** The plugin's three tables for one (client, user) pair. */
async function grantRows(
  c: TestContext,
  clientId: string,
  authUserId: string,
): Promise<GrantRows> {
  const schemaModule = await betterAuthSchema(c);
  const { and, eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => {
        where: (w: unknown) => Promise<Record<string, unknown>[]>;
      };
    };
  };
  const consents = await db
    .select()
    .from(schemaModule.auth_oauth_consent)
    .where(
      and(
        eq(schemaModule.auth_oauth_consent.clientId, clientId),
        eq(schemaModule.auth_oauth_consent.userId, authUserId),
      ),
    );
  const access = await db
    .select()
    .from(schemaModule.auth_oauth_access_token)
    .where(
      and(
        eq(schemaModule.auth_oauth_access_token.clientId, clientId),
        eq(schemaModule.auth_oauth_access_token.userId, authUserId),
      ),
    );
  const refresh = await db
    .select()
    .from(schemaModule.auth_oauth_refresh_token)
    .where(
      and(
        eq(schemaModule.auth_oauth_refresh_token.clientId, clientId),
        eq(schemaModule.auth_oauth_refresh_token.userId, authUserId),
      ),
    );
  return {
    consents: consents.length,
    accessTokens: access.length,
    refreshTokens: refresh.map((r) => ({ revoked: Boolean(r.revoked) })),
  };
}

async function onlyGrant(c: TestContext) {
  const items = await c.storage.items.list({ type: "system.connection" });
  expect(items.data.length).toBe(1);
  return items.data[0]!;
}

function revoke(
  c: TestContext,
  token: string,
  clientId: string,
  hint?: "access_token" | "refresh_token",
): Promise<Response> {
  return request(c.app, "POST", "/auth/oauth2/revoke", {
    form: {
      token,
      client_id: clientId,
      ...(hint === undefined ? {} : { token_type_hint: hint }),
    },
    headers: { origin: ORIGIN },
  });
}

/** Present a refresh token at the token endpoint; the rotated pair. */
async function refresh(
  c: TestContext,
  clientId: string,
  refreshToken: string,
): Promise<Record<string, unknown>> {
  const res = await request(c.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    },
    headers: { origin: ORIGIN },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function revokedAudits(c: TestContext) {
  return c.storage.audit.list({ action: "auth.grant.revoked", limit: 10 });
}

describe("POST /auth/oauth2/revoke with a refresh token ends the grant", () => {
  it("drops the consent row, every token and the projection, writes the audit row, and the next authorize asks again", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx, "Revoking App");
    const cookie = await signInUser(ctx, "revoke@example.com");
    const authUserId = await authUserIdFor(ctx, "revoke@example.com");
    const scope = "core.note:read offline_access";
    const tokens = await codeGrant(ctx, clientId, cookie, scope);
    const refreshToken = tokens.refresh_token;
    expect(typeof refreshToken).toBe("string");

    const before = await grantRows(ctx, clientId, authUserId);
    expect(before.consents).toBe(1);
    expect(before.refreshTokens).toEqual([{ revoked: false }]);
    expect(before.accessTokens).toBeGreaterThanOrEqual(1);
    expect((await onlyGrant(ctx)).properties.status).toBe("active");
    expect(await authorizeOutcome(ctx, clientId, cookie, scope)).toBe(
      "silent_code",
    );

    const res = await revoke(ctx, refreshToken as string, clientId);
    expect(res.status).toBe(200);

    const after = await grantRows(ctx, clientId, authUserId);
    expect(after.consents).toBe(0);
    expect(after.accessTokens).toBe(0);
    expect(after.refreshTokens).toEqual([]);
    const grant = await onlyGrant(ctx);
    expect(grant.properties.status).toBe("revoked");

    const audits = await waitForAudit(
      () => revokedAudits(ctx!),
      (result) => result.data.length >= 1,
    );
    expect(audits.data.length).toBe(1);
    const row = audits.data[0]!;
    expect(row.resource_id).toBe(clientId);
    expect(row.details.source).toBe("client");
    expect(row.details.user_id).toBe(authUserId);
    expect(row.details.grant_item_id).toBe(grant.id);

    // The person is asked again: nothing stands that could cover the request.
    expect(await authorizeOutcome(ctx, clientId, cookie, scope)).toBe(
      "consent_screen",
    );
  });

  it("a refresh token presented under another registered client revokes nothing", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const owner = await seedClient(ctx, "Owner App");
    const other = await seedClient(ctx, "Other App");
    const cookie = await signInUser(ctx, "stolen@example.com");
    const authUserId = await authUserIdFor(ctx, "stolen@example.com");
    const tokens = await codeGrant(
      ctx,
      owner,
      cookie,
      "core.note:read offline_access",
    );

    // The plugin no-ops a mismatch on its own, so the rows alone would not
    // say whether the hook saw it; the warning it logs does.
    const lines: { message: string; data?: unknown }[] = [];
    const spy = vi
      .spyOn(logger, "log")
      .mockImplementation((_level, message, data) => {
        lines.push({ message, data });
      });
    const res = await revoke(ctx, tokens.refresh_token as string, other);
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(
      lines.some(
        (l) =>
          l.message === "oauth client revoke: token belongs to another client",
      ),
    ).toBe(true);

    const rows = await grantRows(ctx, owner, authUserId);
    expect(rows.consents).toBe(1);
    expect(rows.refreshTokens).toEqual([{ revoked: false }]);
    expect(rows.accessTokens).toBeGreaterThanOrEqual(1);
    expect((await onlyGrant(ctx)).properties.status).toBe("active");
    expect((await revokedAudits(ctx)).data).toEqual([]);
  });

  it("a rotated-out refresh token still ends the grant, because the plugin has already ended its tokens", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx, "Rotating App");
    const cookie = await signInUser(ctx, "rotated@example.com");
    const authUserId = await authUserIdFor(ctx, "rotated@example.com");
    const first = await codeGrant(
      ctx,
      clientId,
      cookie,
      "core.note:read offline_access",
    );
    const rotated = await refresh(ctx, clientId, first.refresh_token as string);
    expect(typeof rotated.refresh_token).toBe("string");
    // Rotation marks the old row and keeps it, so a client that revokes with
    // the token it stored before refreshing presents exactly this.
    expect((await grantRows(ctx, clientId, authUserId)).refreshTokens).toEqual([
      { revoked: true },
      { revoked: false },
    ]);

    const res = await revoke(ctx, first.refresh_token as string, clientId);
    // The plugin treats the stale token as a replay and answers 400 while
    // deleting every token of the grant; the grant records follow.
    expect(res.status).toBe(400);
    const after = await grantRows(ctx, clientId, authUserId);
    expect(after.consents).toBe(0);
    expect(after.accessTokens).toBe(0);
    expect(after.refreshTokens).toEqual([]);
    expect((await onlyGrant(ctx)).properties.status).toBe("revoked");
    const audits = await waitForAudit(
      () => revokedAudits(ctx!),
      (result) => result.data.length >= 1,
    );
    expect(audits.data[0]!.details.source).toBe("client");
    expect(
      await authorizeOutcome(ctx, clientId, cookie, "core.note:read"),
    ).toBe("consent_screen");
  });

  it("a token sent with its Authorization scheme is revoked and cascaded like a bare one", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx, "Header Shaped App");
    const cookie = await signInUser(ctx, "scheme@example.com");
    const authUserId = await authUserIdFor(ctx, "scheme@example.com");
    const tokens = await codeGrant(
      ctx,
      clientId,
      cookie,
      "core.note:read offline_access",
    );

    // The plugin strips the scheme before it looks the token up, so the
    // hook has to see the same string or it skips a revocation the plugin
    // performed.
    const res = await revoke(
      ctx,
      `Bearer ${tokens.refresh_token as string}`,
      clientId,
    );
    expect(res.status).toBe(200);
    const after = await grantRows(ctx, clientId, authUserId);
    expect(after.consents).toBe(0);
    expect((await onlyGrant(ctx)).properties.status).toBe("revoked");
  });

  it("an access-token revoke stays token-only", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx, "Signing Out App");
    const cookie = await signInUser(ctx, "signout@example.com");
    const authUserId = await authUserIdFor(ctx, "signout@example.com");
    const tokens = await codeGrant(
      ctx,
      clientId,
      cookie,
      "core.note:read offline_access",
    );
    const accessToken = tokens.access_token as string;
    const live = await request(ctx.app, "GET", "/items?type=core.note", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(live.status).toBe(200);

    const res = await revoke(ctx, accessToken, clientId, "access_token");
    expect(res.status).toBe(200);

    const dead = await request(ctx.app, "GET", "/items?type=core.note", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(dead.status).toBe(401);
    const rows = await grantRows(ctx, clientId, authUserId);
    expect(rows.consents).toBe(1);
    expect(rows.refreshTokens).toEqual([{ revoked: false }]);
    expect((await onlyGrant(ctx)).properties.status).toBe("active");
    expect((await revokedAudits(ctx)).data).toEqual([]);
  });
});

describe("resolveRevokeClientId follows the plugin's precedence", () => {
  const basic = (clientId: string) =>
    new Headers({
      authorization: `Basic ${Buffer.from(`${clientId}:secret`).toString("base64")}`,
    });

  it("takes the Basic credential over a body client_id, so the body cannot speak for the credential", () => {
    expect(
      resolveRevokeClientId({
        body: { client_id: "victim", token: "x" },
        headers: basic("attacker"),
      }),
    ).toBe("attacker");
  });

  it("falls back to the body for a public client", () => {
    expect(
      resolveRevokeClientId({
        body: { client_id: "public-app" },
        headers: new Headers(),
      }),
    ).toBe("public-app");
    expect(
      resolveRevokeClientId({ body: {}, headers: undefined }),
    ).toBeUndefined();
  });

  it("answers undefined for an assertion, whose verification is the plugin's", () => {
    expect(
      resolveRevokeClientId({
        body: { client_id: "jwt-client", client_assertion: "eyJ..." },
        headers: undefined,
      }),
    ).toBeUndefined();
  });

  it("form-decodes the Basic user the way the plugin does", () => {
    const headers = new Headers({
      authorization: `Basic ${Buffer.from("my%20app+id:s").toString("base64")}`,
    });
    expect(resolveRevokeClientId({ body: {}, headers })).toBe("my app id");
  });
});
