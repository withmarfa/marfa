/**
 * `POST /admin/oauth-clients/{client_id}/delete` removes a client and every
 * grant made to it, and repairs a client whose row was deleted by hand.
 *
 * A grant is two records with the app's tokens hanging off the pair, so the
 * route runs the grant cascade for every projection carrying the client id,
 * purges each record, sweeps what no projection named, and deletes the
 * client row last. The four-table hand deletion this replaces left grants
 * standing on both environments; the idempotent shape is what makes the
 * repair the same call as the removal.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForAudit,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function betterAuthSchema(c: TestContext) {
  return c.storage.betterAuthDialect === "pg"
    ? await import("../storage/pg/schema.js")
    : await import("../storage/sqlite/schema.js");
}

async function seedClient(c: TestContext): Promise<string> {
  const clientId = `client_${randomBytes(5).toString("hex")}`;
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  await oauth.createClient({
    clientId,
    name: "Deletable App",
    isPublic: true,
    grantTypes: [DEVICE_GRANT, "authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes: null,
    redirectUris: [`${ORIGIN}/callback`],
    postLogoutRedirectUris: [`${ORIGIN}/`],
    referenceId: null,
  });
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
  const match = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error("sign-in: session_token cookie not found");
  return match[1];
}

/** A device grant with tokens: initiate, approve, poll once. */
async function deviceGrant(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
): Promise<string> {
  const init = await request(c.app, "POST", "/auth/device", {
    body: { client_id: clientId, scope },
    headers: { origin: ORIGIN },
  });
  expect(init.status).toBe(200);
  const { device_code, user_code } = (await init.json()) as {
    device_code: string;
    user_code: string;
  };
  const approve = await request(c.app, "POST", "/auth/device/consent", {
    form: { user_code, decision: "approve" },
    headers: { origin: ORIGIN, cookie },
  });
  expect(approve.status).toBe(200);
  const poll = await request(c.app, "POST", "/auth/device/token", {
    form: {
      grant_type: DEVICE_GRANT,
      device_code,
      client_id: clientId,
    },
    headers: { origin: ORIGIN },
  });
  expect(poll.status).toBe(200);
  return ((await poll.json()) as { access_token: string }).access_token;
}

interface ClientRows {
  clients: number;
  accessTokens: number;
  refreshTokens: number;
  consents: number;
  projections: number;
}

/** Every table a client can leave a row in, counted for one client id. */
async function clientRows(
  c: TestContext,
  clientId: string,
): Promise<ClientRows> {
  const schema = await betterAuthSchema(c);
  const { eq } = await import("drizzle-orm");
  type Column = Parameters<typeof eq>[0];
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> };
    };
  };
  const count = async (table: unknown, column: Column) =>
    (await db.select().from(table).where(eq(column, clientId))).length;
  const projections = (
    await c.storage.oauthProvider!.listGrantItemsForClient(clientId)
  ).length;
  return {
    clients: await count(
      schema.auth_oauth_client,
      schema.auth_oauth_client.clientId,
    ),
    accessTokens: await count(
      schema.auth_oauth_access_token,
      schema.auth_oauth_access_token.clientId,
    ),
    refreshTokens: await count(
      schema.auth_oauth_refresh_token,
      schema.auth_oauth_refresh_token.clientId,
    ),
    consents: await count(
      schema.auth_oauth_consent,
      schema.auth_oauth_consent.clientId,
    ),
    projections,
  };
}

async function deleteClient(
  c: TestContext,
  clientId: string,
  confirm: string,
  key: string,
): Promise<Response> {
  return request(c.app, "POST", `/admin/oauth-clients/${clientId}/delete`, {
    body: { confirm },
    key,
  });
}

/** The consent row a code-flow grant carries. A device approval writes its
 *  own only from the change that lands beside this one, so the row is
 *  seeded here so the cascade has one to delete. */
async function seedConsent(
  c: TestContext,
  clientId: string,
  authUserId: string,
): Promise<void> {
  const schema = await betterAuthSchema(c);
  const db = c.storage.betterAuthDb as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const now = new Date();
  const op = db.insert(schema.auth_oauth_consent).values({
    id: `cons_${randomBytes(5).toString("hex")}`,
    clientId,
    userId: authUserId,
    scopes:
      c.storage.betterAuthDialect === "pg"
        ? ["core.note:read"]
        : JSON.stringify(["core.note:read"]),
    consentGiven: true,
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
}

async function authUserIdFor(c: TestContext, email: string): Promise<string> {
  const schema = await betterAuthSchema(c);
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
    .from(schema.auth_user)
    .where(eq(schema.auth_user.email, email));
  const id = rows[0]?.id;
  if (!id) throw new Error(`authUserIdFor: no auth_user for ${email}`);
  return id;
}

async function memberKey(c: TestContext): Promise<string> {
  const suffix = randomBytes(5).toString("hex");
  const raw = `marfa_k1_member_${suffix}`;
  await c.storage.keys.create(
    {
      label: `member-${suffix}`,
      source: `member-${suffix}`,
      role: "member",
      type_permissions: { "core.note": "read" },
      default_tier: "library",
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return raw;
}

describe("POST /admin/oauth-clients/{client_id}/delete", () => {
  it("is platform-admin only and refuses a confirm that is not the client id", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);

    const forbidden = await deleteClient(
      ctx,
      clientId,
      clientId,
      await memberKey(ctx),
    );
    expect(forbidden.status).toBe(403);

    const mismatch = await deleteClient(
      ctx,
      clientId,
      "not-the-id",
      ctx.adminKey,
    );
    expect(mismatch.status).toBe(400);
    expect((await clientRows(ctx, clientId)).clients).toBe(1);
  });

  it("removes the client, every grant made to it and every token, and writes the audit row", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "delete-client@example.com");
    const accessToken = await deviceGrant(
      ctx,
      clientId,
      cookie,
      "core.note:read offline_access",
    );
    await seedConsent(
      ctx,
      clientId,
      await authUserIdFor(ctx, "delete-client@example.com"),
    );
    const live = await request(ctx.app, "GET", "/items?type=core.note", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(live.status).toBe(200);
    const before = await clientRows(ctx, clientId);
    expect(before).toMatchObject({
      clients: 1,
      accessTokens: 1,
      refreshTokens: 1,
      consents: 1,
      projections: 1,
    });
    const [projection] =
      await ctx.storage.oauthProvider!.listGrantItemsForClient(clientId);

    const res = await deleteClient(ctx, clientId, clientId, ctx.adminKey);
    expect(res.status).toBe(200);
    // The grant's cascade took its tokens, consent and codes, so nothing is
    // left for the client-wide sweep to count as a stray.
    expect(await res.json()).toEqual({
      deleted: true,
      client_row_deleted: true,
      grants_removed: 1,
      stray_records_deleted: 0,
    });

    expect(await clientRows(ctx, clientId)).toEqual({
      clients: 0,
      accessTokens: 0,
      refreshTokens: 0,
      consents: 0,
      projections: 0,
    });
    // The record is gone, not tombstoned: nothing lists it and the row
    // itself no longer exists.
    expect(
      await ctx.storage.items.getIncludingTrashed(projection!.id),
    ).toBeNull();
    const dead = await request(ctx.app, "GET", "/items?type=core.note", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(dead.status).toBe(401);

    const audits = await waitForAudit(
      () =>
        ctx!.storage.audit.list({ action: "auth.client.deleted", limit: 10 }),
      (r) => r.data.length >= 1,
    );
    expect(audits.data.length).toBe(1);
    expect(audits.data[0]!.resource_id).toBe(clientId);
    expect(audits.data[0]!.details.grants_removed).toBe(1);
    expect(audits.data[0]!.details.client_row_deleted).toBe(true);
  });

  it("repairs a client whose row was deleted by hand, and a second call is a no-op", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "orphan@example.com");
    await deviceGrant(ctx, clientId, cookie, "core.note:read");

    // The hand deletion that produced the orphans on both environments:
    // the client row goes, the grant's records stay.
    expect(await ctx.storage.oauthProvider!.deleteClient(clientId)).toBe(true);
    expect((await clientRows(ctx, clientId)).projections).toBe(1);

    const res = await deleteClient(ctx, clientId, clientId, ctx.adminKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      deleted: true,
      client_row_deleted: false,
      grants_removed: 1,
    });
    expect(await clientRows(ctx, clientId)).toEqual({
      clients: 0,
      accessTokens: 0,
      refreshTokens: 0,
      consents: 0,
      projections: 0,
    });

    const again = await deleteClient(ctx, clientId, clientId, ctx.adminKey);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      deleted: true,
      client_row_deleted: false,
      grants_removed: 0,
      stray_records_deleted: 0,
    });
  });
});
