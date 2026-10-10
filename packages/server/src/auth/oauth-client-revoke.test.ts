/**
 * A refresh token handed to `POST /auth/oauth2/revoke` ends the grant it
 * belongs to, not just the token.
 *
 * A grant is two records, the plugin's consent row and Marfa's
 * `system.connection` projection, and the plugin's revoke endpoint used to
 * reach neither: it marked the presented refresh token revoked and deleted
 * the access tokens under it, and stopped. The app had done the one thing
 * RFC 7009 gives it for "forget me", the Manage Marfa page still listed it,
 * the consent row still stood, and the next authorize was answered
 * silently with a fresh code. The credential adapter runs the same cascade
 * as the person's own Disconnect in the provider mutation's transaction.
 * The presented token identifies the pair; the authenticated provider
 * mutation establishes that the cascade may run.
 *
 * Two bounds beside the positive case. A refresh token presented under a
 * different registered client is a no-op for the plugin and has to stay a
 * no-op here, or a stolen refresh token becomes a denial-of-service on
 * somebody else's grant. And an access-token revoke stays token-only: that
 * is a sign-out, not a disconnect.
 *
 * The last pair is about a token carrying a NULL `reference_id`, which is
 * what an earlier build issued and what its rows still hold. Revoking with
 * one has to reach the projection anyway, and rotating one has to be refused
 * rather than answered with another token nothing accepts.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "../middleware/logger.js";
import { itemWrites } from "../storage/item-writes.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request } from "../test-utils.js";
import { consentLockDepth, withConsentLock } from "./consent-lock.js";
import { resolvePresentedClientId } from "./oauth-provider.js";

import type { InStatement } from "@libsql/client";
const acknowledgment = vi.hoisted(() => ({
  mode: "none",
  action: "",
  armed: false,
  fired: false,
  inserts: 0,
}));
vi.mock("@libsql/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libsql/client")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args),
        execute = client.execute.bind(client);
      client.execute = async (
        statement: InStatement | string,
        ...rest: unknown[]
      ) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        const values =
          typeof statement === "string"
            ? []
            : Object.values(statement.args ?? {});
        const audit =
          acknowledgment.mode !== "none" &&
          sql.startsWith('insert into "audit_log"') &&
          values.includes(acknowledgment.action);
        const target =
          sql === "COMMIT" && acknowledgment.armed && !acknowledgment.fired;
        if (target && acknowledgment.mode === "before") {
          acknowledgment.fired = true;
          throw new Error("credential commit acknowledgment");
        }
        const result = await execute(statement, ...(rest as []));
        if (audit) {
          acknowledgment.armed = true;
          acknowledgment.inserts++;
        }
        if (target) {
          acknowledgment.fired = true;
          throw new Error("credential commit acknowledgment");
        }
        return result;
      };
      return client;
    },
  };
});

// Every case signs a user up and in and drives a full authorization-code
// grant before asserting anything, which is more than the default budget
// allows on a machine running the rest of the suite beside it.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  Object.assign(acknowledgment, {
    mode: "none",
    action: "",
    armed: false,
    fired: false,
    inserts: 0,
  });
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";

function betterAuthSchema() {
  return import("../storage/sqlite/schema.js");
}

/** A public PKCE client with no scope ceiling, registered for the code and
 *  refresh grants. */
async function seedClient(c: TestContext, name: string): Promise<string> {
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
async function prepareCode(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
) {
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
  return {
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    client_id: clientId,
    code_verifier: verifier,
  };
}
async function codeGrant(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
): Promise<Record<string, unknown>> {
  const form = await prepareCode(c, clientId, cookie, scope);
  const tokenRes = await request(c.app, "POST", "/auth/oauth2/token", {
    form,
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
  const schemaModule = await betterAuthSchema();
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
    // Ordered, because the select is not: rotated (revoked) rows first.
    refreshTokens: refresh
      .map((r) => ({ revoked: Boolean(r.revoked) }))
      .sort((a, b) => Number(b.revoked) - Number(a.revoked)),
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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, "Revoking App");
    const cookie = await signInUser(ctx);
    const authUserId = ctx.owner.id;
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

    const audits = await revokedAudits(ctx);
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
    ctx = await createTestContext({});
    const owner = await seedClient(ctx, "Owner App");
    const other = await seedClient(ctx, "Other App");
    const cookie = await signInUser(ctx);
    const authUserId = ctx.owner.id;
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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, "Rotating App");
    const cookie = await signInUser(ctx);
    const authUserId = ctx.owner.id;
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
    // The plugin treats the stale token as a replay, deleting every token of
    // the grant, and the grant records follow. The token was already revoked,
    // which RFC 7009 answers 200.
    expect(res.status).toBe(200);
    const after = await grantRows(ctx, clientId, authUserId);
    expect(after.consents).toBe(0);
    expect(after.accessTokens).toBe(0);
    expect(after.refreshTokens).toEqual([]);
    expect((await onlyGrant(ctx)).properties.status).toBe("revoked");
    const audits = await revokedAudits(ctx);
    expect(audits.data[0]!.details.source).toBe("client");
    expect(
      await authorizeOutcome(ctx, clientId, cookie, "core.note:read"),
    ).toBe("consent_screen");
  });

  it("a request the plugin refuses moves nothing, even with a live token and a matching client_id", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, "Refused App");
    const cookie = await signInUser(ctx);
    const authUserId = ctx.owner.id;
    const tokens = await codeGrant(
      ctx,
      clientId,
      cookie,
      "core.note:read offline_access",
    );

    // A non-Basic Authorization header: the plugin refuses the request
    // before it authenticates anyone, while the resolver ignores the header
    // and reads the matching body client_id. No provider mutation reaches
    // the adapter, so the resolved pair must not trigger a cascade.
    const res = await request(ctx.app, "POST", "/auth/oauth2/revoke", {
      form: { token: tokens.refresh_token as string, client_id: clientId },
      headers: {
        origin: ORIGIN,
        authorization: "Bearer not-a-basic-credential",
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await grantRows(ctx, clientId, authUserId);
    expect(rows.consents).toBe(1);
    expect(rows.refreshTokens).toEqual([{ revoked: false }]);
    expect((await onlyGrant(ctx)).properties.status).toBe("active");
    expect((await revokedAudits(ctx)).data).toEqual([]);
  });

  it("a grant whose projection is already gone still loses its consent row and tokens", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, "Projectionless App");
    const cookie = await signInUser(ctx);
    const authUserId = ctx.owner.id;
    const tokens = await codeGrant(
      ctx,
      clientId,
      cookie,
      "core.note:read offline_access",
    );

    // The shape a hand-deleted record leaves: plugin rows, no projection.
    const grant = await onlyGrant(ctx);
    await itemWrites(ctx.storage).transition(grant.id, "revoked");
    await itemWrites(ctx.storage).purge(grant.id);

    const res = await revoke(ctx, tokens.refresh_token as string, clientId);
    expect(res.status).toBe(200);
    const after = await grantRows(ctx, clientId, authUserId);
    expect(after.consents).toBe(0);
    expect(after.refreshTokens).toEqual([]);
    const audits = await revokedAudits(ctx);
    expect(audits.data[0]!.details.grant_item_id).toBeNull();
    expect(audits.data[0]!.details.source).toBe("client");
  });

  it("a token sent with its Authorization scheme is revoked and cascaded like a bare one", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, "Header Shaped App");
    const cookie = await signInUser(ctx);
    const authUserId = ctx.owner.id;
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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, "Signing Out App");
    const cookie = await signInUser(ctx);
    const authUserId = ctx.owner.id;
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

describe("POST /auth/oauth2/revoke answers 200 for a token that is already gone", () => {
  it("answers 200 for a token this server never issued, of either kind or none", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, "Forgetful App");
    for (const token of [
      `marfa_rt_${randomBytes(16).toString("hex")}`,
      `marfa_at_${randomBytes(16).toString("hex")}`,
      "not a token of any kind",
    ]) {
      for (const hint of [
        undefined,
        "refresh_token",
        "access_token",
      ] as const) {
        const res = await revoke(ctx, token, clientId, hint);
        expect(res.status, `${token} ${String(hint)}`).toBe(200);
      }
    }
  });

  it("answers 200 for a token revoked before, and still refuses a request with no token", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, "Twice Revoking App");
    const cookie = await signInUser(ctx);
    const tokens = await codeGrant(
      ctx,
      clientId,
      cookie,
      "core.note:read offline_access",
    );
    const accessToken = tokens.access_token as string;
    expect((await revoke(ctx, accessToken, clientId)).status).toBe(200);
    expect((await revoke(ctx, accessToken, clientId)).status).toBe(200);

    const missing = await request(ctx.app, "POST", "/auth/oauth2/revoke", {
      form: { client_id: clientId },
      headers: { origin: ORIGIN },
    });
    expect(missing.status).toBe(400);
  });

  it("keeps the plugin's refusal of a live token it did not revoke", async () => {
    // The witness that the 200 is decided by the token being gone, not by
    // the refusal: a live access token named as a refresh token is refused
    // by the plugin and is still live afterwards, so a 200 would report a
    // revocation that did not happen.
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, "Mislabeling App");
    const cookie = await signInUser(ctx);
    const tokens = await codeGrant(
      ctx,
      clientId,
      cookie,
      "core.note:read offline_access",
    );
    const accessToken = tokens.access_token as string;
    const res = await revoke(ctx, accessToken, clientId, "refresh_token");
    expect(res.status).toBe(400);
    const still = await request(ctx.app, "GET", "/items?type=core.note", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(still.status).toBe(200);
  });
});

/**
 * Mint the token pair an earlier build issued: both rows carry a NULL
 * `reference_id`, and nothing rewrites them, so this is the live shape on an
 * upgraded instance until the tokens expire.
 *
 * Hashes are computed the way the plugin computes them, prefix stripped, so
 * the presented string resolves through the same lookup a real token does.
 */
async function seedUnboundTokenPair(
  c: TestContext,
  clientId: string,
  authUserId: string,
  scopes: string[],
): Promise<{ accessToken: string; refreshToken: string }> {
  const provider = c.storage.oauthProvider;
  if (typeof provider?.mintTokenPair !== "function") {
    throw new Error("seedUnboundTokenPair: mintTokenPair missing");
  }
  const { hashApiKey } = await import("../middleware/auth.js");
  const { TEST_API_KEY_SALT } = await import("../test-utils.js");
  const accessToken = `marfa_at_${randomBytes(12).toString("hex")}`;
  const refreshToken = `marfa_rt_${randomBytes(12).toString("hex")}`;
  await provider.mintTokenPair({
    accessTokenHash: hashApiKey(
      accessToken.slice("marfa_at_".length),
      TEST_API_KEY_SALT,
    ),
    refreshTokenHash: hashApiKey(
      refreshToken.slice("marfa_rt_".length),
      TEST_API_KEY_SALT,
    ),
    clientId,
    authUserId,
    scopes,
    accessTtlMs: 3600_000,
  });
  return { accessToken, refreshToken };
}

describe("a token carrying no reference_id", () => {
  it("still ends the grant it belongs to when the client revokes it", async () => {
    // The cascade used to key on the presented token's `reference_id`, and
    // this token has none. Keyed on the token alone the lookup finds nothing, `revokeProjectedGrant` takes its no-op arm, and
    // the endpoint answers 200 over a grant the Manage Marfa page still lists as
    // active. A revoke that reports success and ends nothing is the failure
    // this whole change exists to close.
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, "Upgraded App");
    const cookie = await signInUser(ctx);
    const authUserId = ctx.owner.id;
    const scope = "core.note:read offline_access";
    await codeGrant(ctx, clientId, cookie, scope);

    const grantBefore = await onlyGrant(ctx);
    expect(grantBefore.properties.status).toBe("active");

    const legacy = await seedUnboundTokenPair(ctx, clientId, authUserId, [
      "core.note:read",
      "offline_access",
    ]);
    const res = await revoke(ctx, legacy.refreshToken, clientId);
    expect(res.status).toBe(200);

    expect((await onlyGrant(ctx)).properties.status).toBe("revoked");
    const rows = await grantRows(ctx, clientId, authUserId);
    expect(rows.consents).toBe(0);
    expect(rows.accessTokens).toBe(0);
  });
});

describe("resolvePresentedClientId follows the plugin's precedence", () => {
  const basic = (clientId: string) =>
    new Headers({
      authorization: `Basic ${Buffer.from(`${clientId}:secret`).toString("base64")}`,
    });

  it("takes the Basic credential over a body client_id, so the body cannot speak for the credential", () => {
    expect(
      resolvePresentedClientId({
        body: { client_id: "victim", token: "x" },
        headers: basic("attacker"),
      }),
    ).toBe("attacker");
  });

  it("falls back to the body for a public client", () => {
    expect(
      resolvePresentedClientId({
        body: { client_id: "public-app" },
        headers: new Headers(),
      }),
    ).toBe("public-app");
    expect(
      resolvePresentedClientId({ body: {}, headers: undefined }),
    ).toBeUndefined();
  });

  it("answers undefined for an assertion, whose verification is the plugin's", () => {
    expect(
      resolvePresentedClientId({
        body: { client_id: "jwt-client", client_assertion: "eyJ..." },
        headers: undefined,
      }),
    ).toBeUndefined();
  });

  it("form-decodes the Basic user the way the plugin does", () => {
    const headers = new Headers({
      authorization: `Basic ${Buffer.from("my%20app+id:s").toString("base64")}`,
    });
    expect(resolvePresentedClientId({ body: {}, headers })).toBe("my app id");
  });
});

function nativeAuditFixture(c: TestContext) {
  return c.storage as typeof c.storage & {
    __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    __sqliteAll(sql: string): Promise<Record<string, unknown>[]>;
  };
}
it.each(["browser", "client"])(
  "keeps every grant record and bearer on a native %s revoke audit fault",
  async (door) => {
    ctx = await createTestContext();
    const clientId = await seedClient(ctx, "Audit Revoke");
    const cookie = await signInUser(ctx);
    const userId = ctx.owner.id;
    const tokens = await codeGrant(
      ctx,
      clientId,
      cookie,
      "core.note:read offline_access",
    );
    const grant = await onlyGrant(ctx);
    const before = await grantRows(ctx, clientId, userId);
    const db = nativeAuditFixture(ctx);
    await db.__sqliteRun(
      "CREATE TRIGGER reject_grant_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.grant.revoked' BEGIN SELECT RAISE(ABORT, 'grant audit fault'); END",
      [],
    );
    const remove = () =>
      door === "client"
        ? revoke(ctx!, tokens.refresh_token as string, clientId)
        : request(ctx!.app, "DELETE", `/auth/grants/${grant.id}`, {
            key: ctx!.workingKey,
          });
    const refused = await remove();
    expect(refused.status).toBe(500);
    expect(await grantRows(ctx, clientId, userId)).toEqual(before);
    expect((await onlyGrant(ctx)).properties.status).toBe("active");
    expect(
      (
        await request(ctx.app, "GET", "/items", {
          key: tokens.access_token as string,
        })
      ).status,
    ).toBe(200);
    expect((await revokedAudits(ctx)).data).toHaveLength(0);
    await db.__sqliteRun("DROP TRIGGER reject_grant_audit", []);
    expect((await remove()).status).toBe(door === "client" ? 200 : 204);
    expect((await grantRows(ctx, clientId, userId)).accessTokens).toBe(0);
    expect((await onlyGrant(ctx)).properties.status).toBe("revoked");
    expect((await revokedAudits(ctx)).data).toHaveLength(1);
  },
);
it("rolls rotation back when the final issuance audit is refused, preserving the usable refresh token", async () => {
  ctx = await createTestContext();
  const clientId = await seedClient(ctx, "Audit Rotation");
  const cookie = await signInUser(ctx);
  const userId = ctx.owner.id;
  const tokens = await codeGrant(
    ctx,
    clientId,
    cookie,
    "core.note:read offline_access",
  );
  const before = await grantRows(ctx, clientId, userId);
  const db = nativeAuditFixture(ctx);
  await db.__sqliteRun(
    "CREATE TRIGGER reject_issue_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.token.issued' BEGIN SELECT RAISE(ABORT, 'issue audit fault'); END",
    [],
  );
  const rotate = () =>
    request(ctx!.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token as string,
        client_id: clientId,
      },
      headers: { origin: ORIGIN },
    });
  const refused = await rotate();
  expect(refused.status).toBe(500);
  expect(refused.headers.get("set-cookie")).toBeNull();
  expect(await grantRows(ctx, clientId, userId)).toEqual(before);
  await db.__sqliteRun("DROP TRIGGER reject_issue_audit", []);
  expect((await rotate()).status).toBe(200);
  expect((await grantRows(ctx, clientId, userId)).refreshTokens).toHaveLength(
    2,
  );
});
it("keeps replay withdrawal and its observation together even though the token response is refused", async () => {
  ctx = await createTestContext();
  const clientId = await seedClient(ctx, "Audit Replay");
  const cookie = await signInUser(ctx);
  const userId = ctx.owner.id;
  const tokens = await codeGrant(
    ctx,
    clientId,
    cookie,
    "core.note:read offline_access",
  );
  await refresh(ctx, clientId, tokens.refresh_token as string);
  const before = await grantRows(ctx, clientId, userId);
  expect(before.accessTokens).toBeGreaterThan(0);
  const db = nativeAuditFixture(ctx);
  await db.__sqliteRun(
    "CREATE TRIGGER reject_replay_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.refresh.replayed' BEGIN SELECT RAISE(ABORT, 'replay audit fault'); END",
    [],
  );
  const replay = () =>
    request(ctx!.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token as string,
        client_id: clientId,
      },
      headers: { origin: ORIGIN },
    });
  expect((await replay()).status).toBe(500);
  expect(await grantRows(ctx, clientId, userId)).toEqual(before);
  await db.__sqliteRun("DROP TRIGGER reject_replay_audit", []);
  expect((await replay()).status).toBe(400);
  expect((await grantRows(ctx, clientId, userId)).accessTokens).toBe(0);
  expect(
    (await ctx.storage.audit.list({ action: "auth.refresh.replayed" })).data,
  ).toHaveLength(1);
});
it("rolls provider consent and code back together with a refused browser grant audit", async () => {
  ctx = await createTestContext();
  const clientId = await seedClient(ctx, "Audit Consent");
  const cookie = await signInUser(ctx);
  const userId = ctx.owner.id;
  const pair = pkcePair();
  const auth = await request(
    ctx.app,
    "GET",
    `/auth/oauth2/authorize?${authorizeParams(clientId, "core.note:read", pair.challenge).toString()}`,
    { headers: { cookie } },
  );
  const signed = new URL(auth.headers.get("location")!, ORIGIN).search.slice(1);
  const decide = () =>
    request(ctx!.app, "POST", "/auth/authorize/decision", {
      form: { accept: "true", oauth_query: signed, scopes: ["core.note:read"] },
      headers: { cookie, origin: ORIGIN },
    });
  const db = nativeAuditFixture(ctx);
  await db.__sqliteRun(
    "CREATE TRIGGER reject_consent_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.grant.created' BEGIN SELECT RAISE(ABORT, 'consent audit fault'); END",
    [],
  );
  const refused = await decide();
  expect(refused.status).toBe(500);
  expect(refused.headers.get("location")).toBeNull();
  expect((await grantRows(ctx, clientId, userId)).consents).toBe(0);
  expect(
    (await ctx.storage.items.list({ type: "system.connection" })).data,
  ).toHaveLength(0);
  expect(
    await db.__sqliteAll(
      "SELECT id FROM auth_verification WHERE json_extract(value, '$.type')='authorization_code'",
    ),
  ).toHaveLength(0);
  await db.__sqliteRun("DROP TRIGGER reject_consent_audit", []);
  expect((await decide()).status).toBe(302);
  expect((await grantRows(ctx, clientId, userId)).consents).toBe(1);
  expect(
    await db.__sqliteAll(
      "SELECT id FROM auth_verification WHERE json_extract(value, '$.type')='authorization_code'",
    ),
  ).toHaveLength(1);
});

it("rolls a caught token persistence failure back with its one-use authorization code", async () => {
  ctx = await createTestContext();
  const clientId = await seedClient(ctx, "One-use audit");
  const cookie = await signInUser(ctx);
  const form = await prepareCode(
    ctx,
    clientId,
    cookie,
    "core.note:read offline_access",
  );
  const db = nativeAuditFixture(ctx);
  const before = await db.__sqliteAll("SELECT id FROM auth_verification");
  await db.__sqliteRun(
    "CREATE TRIGGER reject_token_row_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.oauthAccessToken.create' BEGIN SELECT RAISE(ABORT, 'token row audit fault'); END",
    [],
  );
  const exchange = () =>
    request(ctx!.app, "POST", "/auth/oauth2/token", {
      form,
      headers: { origin: ORIGIN },
    });
  const refused = await exchange();
  expect(refused.status).toBe(500);
  expect(await refused.text()).not.toContain("marfa_at_");
  expect(await db.__sqliteAll("SELECT id FROM auth_verification")).toEqual(
    before,
  );
  expect(
    await db.__sqliteAll("SELECT id FROM auth_oauth_access_token"),
  ).toEqual([]);
  expect(
    await db.__sqliteAll("SELECT id FROM auth_oauth_refresh_token"),
  ).toEqual([]);
  await db.__sqliteRun("DROP TRIGGER reject_token_row_audit", []);
  const accepted = await exchange();
  expect(accepted.status).toBe(200);
  const token = (await accepted.json()) as { access_token: string };
  expect(
    (await request(ctx.app, "GET", "/items", { key: token.access_token }))
      .status,
  ).toBe(200);
  expect((await exchange()).status).toBe(400);
  expect(
    (await request(ctx.app, "GET", "/items", { key: token.access_token }))
      .status,
  ).toBe(401);
});

it("takes the consent lock before the RFC 7009 writer under concurrent consent", async () => {
  ctx = await createTestContext();
  const clientId = await seedClient(ctx, "Concurrent revoke");
  const cookie = await signInUser(ctx);
  const userId = ctx.owner.id;
  const tokens = await codeGrant(
    ctx,
    clientId,
    cookie,
    "core.note:read offline_access",
  );
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const consent = withConsentLock(clientId, userId, async () => {
    entered();
    await gate;
    expect(
      await authorizeOutcome(ctx!, clientId, cookie, "core.note:read"),
    ).toBe("silent_code");
  });
  await held;
  const revoked = revoke(ctx, tokens.refresh_token as string, clientId);
  await vi.waitFor(() => {
    expect(consentLockDepth(clientId, userId)).toBe(2);
  });
  release();
  await consent;
  expect((await revoked).status).toBe(200);
  expect(
    await nativeAuditFixture(ctx).__sqliteAll(
      "SELECT id FROM auth_verification WHERE json_extract(value, '$.type')='authorization_code'",
    ),
  ).toEqual([]);
  expect((await onlyGrant(ctx)).properties.status).toBe("revoked");
  expect((await grantRows(ctx, clientId, userId)).accessTokens).toBe(0);
});

it.each(["before", "after", "unknown"])(
  "returns tokens only after confirmed %s commit acknowledgment",
  async (mode) => {
    ctx = await createTestContext();
    const clientId = await seedClient(ctx, "Token outcome");
    const cookie = await signInUser(ctx);
    const form = await prepareCode(
      ctx,
      clientId,
      cookie,
      "core.note:read offline_access",
    );
    if (mode === "unknown")
      vi.spyOn(ctx.storage.audit, "has").mockRejectedValue(
        new Error("witness unavailable"),
      );
    acknowledgment.mode = mode;
    acknowledgment.action = "auth.token.issued";
    const exchange = () =>
      request(ctx!.app, "POST", "/auth/oauth2/token", {
        form,
        headers: { origin: ORIGIN },
      });
    const response = await exchange();
    expect(acknowledgment.fired).toBe(true);
    expect(acknowledgment.inserts).toBe(1);
    expect(response.status).toBe(mode === "after" ? 200 : 500);
    if (mode === "after") {
      const token = (await response.json()) as { access_token: string };
      expect(
        (await request(ctx.app, "GET", "/items", { key: token.access_token }))
          .status,
      ).toBe(200);
    } else expect(await response.text()).not.toContain("marfa_at_");
    const db = nativeAuditFixture(ctx);
    expect(
      await db.__sqliteAll("SELECT id FROM auth_oauth_access_token"),
    ).toHaveLength(mode === "before" ? 0 : 1);
    expect(
      (await ctx.storage.audit.list({ action: "auth.token.issued" })).data,
    ).toHaveLength(mode === "before" ? 0 : 1);
    acknowledgment.mode = "none";
    vi.restoreAllMocks();
    if (mode === "before") expect((await exchange()).status).toBe(200);
  },
);

it.each(["before", "after", "unknown"])(
  "returns a browser authorization code only after confirmed %s commit acknowledgment",
  async (mode) => {
    ctx = await createTestContext();
    const clientId = await seedClient(ctx, "Consent outcome");
    const cookie = await signInUser(ctx);
    const pair = pkcePair();
    const authorization = await request(
      ctx.app,
      "GET",
      `/auth/oauth2/authorize?${authorizeParams(clientId, "core.note:read", pair.challenge).toString()}`,
      { headers: { cookie } },
    );
    const signed = new URL(
      authorization.headers.get("location")!,
      ORIGIN,
    ).search.slice(1);
    if (mode === "unknown")
      vi.spyOn(ctx.storage.audit, "has").mockRejectedValue(
        new Error("witness unavailable"),
      );
    acknowledgment.mode = mode;
    acknowledgment.action = "auth.grant.created";
    const decide = () =>
      request(ctx!.app, "POST", "/auth/authorize/decision", {
        form: {
          accept: "true",
          oauth_query: signed,
          scopes: ["core.note:read"],
        },
        headers: { cookie, origin: ORIGIN },
      });
    const response = await decide();
    expect(acknowledgment.fired).toBe(true);
    expect(acknowledgment.inserts).toBe(1);
    expect(response.status).toBe(mode === "after" ? 302 : 500);
    if (mode !== "after") expect(response.headers.get("location")).toBeNull();
    else
      expect(
        new URL(response.headers.get("location")!).searchParams.get("code"),
      ).not.toBeNull();
    expect(
      (await ctx.storage.audit.list({ action: "auth.grant.created" })).data,
    ).toHaveLength(mode === "before" ? 0 : 1);
    expect(
      await nativeAuditFixture(ctx).__sqliteAll(
        "SELECT id FROM auth_verification WHERE json_extract(value, '$.type')='authorization_code'",
      ),
    ).toHaveLength(mode === "before" ? 0 : 1);
    acknowledgment.mode = "none";
    vi.restoreAllMocks();
    if (mode === "before") expect((await decide()).status).toBe(302);
  },
);

it("keeps the entire RFC 7009 provider tail in the grant transaction", async () => {
  ctx = await createTestContext();
  const clientId = await seedClient(ctx, "Revoke tail");
  const cookie = await signInUser(ctx);
  const userId = ctx.owner.id;
  const tokens = await codeGrant(
    ctx,
    clientId,
    cookie,
    "core.note:read offline_access",
  );
  const before = await grantRows(ctx, clientId, userId);
  const db = nativeAuditFixture(ctx);
  await db.__sqliteRun(
    "CREATE TRIGGER reject_revoke_tail BEFORE INSERT ON audit_log WHEN NEW.action='auth.credentials.revoked' BEGIN SELECT RAISE(ABORT, 'revoke tail audit fault'); END",
    [],
  );
  expect(
    (await revoke(ctx, tokens.refresh_token as string, clientId)).status,
  ).toBe(500);
  expect(await grantRows(ctx, clientId, userId)).toEqual(before);
  expect((await onlyGrant(ctx)).properties.status).toBe("active");
  expect(
    (
      await request(ctx.app, "GET", "/items", {
        key: tokens.access_token as string,
      })
    ).status,
  ).toBe(200);
  await db.__sqliteRun("DROP TRIGGER reject_revoke_tail", []);
  expect(
    (await revoke(ctx, tokens.refresh_token as string, clientId)).status,
  ).toBe(200);
  expect((await onlyGrant(ctx)).properties.status).toBe("revoked");
  expect(
    (
      await request(ctx.app, "GET", "/items", {
        key: tokens.access_token as string,
      })
    ).status,
  ).toBe(401);
});

it("keeps remote client key retrieval outside the credential writer", async () => {
  ctx = await createTestContext({
    corsOrigins: ["https://client.example.test"],
  });
  const clientId = await seedClient(ctx, "Remote client key");
  const remoteCookie = await signInUser(ctx);
  const remoteTokens = await codeGrant(
    ctx,
    clientId,
    remoteCookie,
    "core.note:read offline_access",
  );
  const db = nativeAuditFixture(ctx);
  await db.__sqliteRun(
    "UPDATE auth_oauth_client SET token_endpoint_auth_method='private_key_jwt', public=0, jwks_uri='https://client.example.test/keys' WHERE client_id=?",
    [clientId],
  );
  const { transactionControl } =
    await import("../storage/sqlite/transaction-control.js");
  let fetches = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    expect(input instanceof Request ? input.url : input.toString()).toBe(
      "https://client.example.test/keys",
    );
    expect(transactionControl.getStore()).toBeUndefined();
    await ctx!.storage.settings.set("credential.remote-probe", "available");
    fetches++;
    return Response.json({ keys: [] });
  });
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const assertion = `${part({ alg: "RS256", kid: "fixture" })}.${part({ sub: clientId, iss: clientId, aud: `${ORIGIN}/auth/oauth2/token`, exp: Math.floor(Date.now() / 1000) + 60 })}.AA`;
  const response = await request(ctx.app, "POST", "/auth/oauth2/token", {
    form: {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: remoteTokens.refresh_token as string,
      client_assertion: assertion,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    },
  });
  expect(response.status).toBe(400);
  expect(fetches).toBeGreaterThan(0);
  expect(await ctx.storage.settings.get("credential.remote-probe")).toBe(
    "available",
  );
  expect(
    await db.__sqliteAll("SELECT id FROM auth_oauth_refresh_token"),
  ).toHaveLength(1);
  vi.restoreAllMocks();
  const publicClient = await seedClient(ctx, "Public control");
  const cookie = await signInUser(ctx);
  expect(
    (await codeGrant(ctx, publicClient, cookie, "core.note:read")).access_token,
  ).toBeTruthy();
});
