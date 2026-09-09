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
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

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
    form: {
      user_code,
      decision: "approve",
      // Everything ticked, which is what the screen submits untouched: the
      // approval form carries a checkbox per requested scope, so a post with
      // none is a denial rather than a full approval.
      scopes: scope.split(" ").filter(Boolean),
    },
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
/** An authorization code the plugin would have minted: a verification row
 *  whose value names the client and the user, never exchanged. */
async function seedAuthorizationCode(
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
  const op = db.insert(schema.auth_verification).values({
    id: `ver_${randomBytes(5).toString("hex")}`,
    identifier: `code_${randomBytes(8).toString("hex")}`,
    value: JSON.stringify({
      type: "authorization_code",
      query: { client_id: clientId, scope: "core.note:read" },
      userId: authUserId,
    }),
    expiresAt: new Date(now.getTime() + 600_000),
    createdAt: now,
    updatedAt: now,
  });
  await (op.run ? op.run() : op.execute!());
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

/**
 * A credential holding every space permission there is, in a space of its own.
 * The one a widened gate would admit: it is everything a hosted sign-up can
 * hand an app, and it is still not the operator key, because operator
 * authority is authority confined to no space at all.
 *
 * Bound to a space rather than left space-less, because the row constraint
 * makes a space-less credential an operator credential — which would be the
 * very thing this fixture has to not be.
 */
async function spaceAdminKey(c: TestContext): Promise<string> {
  const suffix = randomBytes(5).toString("hex");
  const raw = `marfa_k1_spaceadmin_${suffix}`;
  const space = await c.storage.spaces!.create(`oauth-client-admin-${suffix}`);
  await c.storage.keys.create(
    {
      label: `space-admin-${suffix}`,
      source: `space-admin-${suffix}`,
      space_permissions: [...SPACE_PERMISSIONS],
      type_permissions: { "*": "write" },
      default_tier: "library",
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    space.id,
  );
  return raw;
}

/** A credential with no administrative reach at all, in a space of its own. */
async function memberKey(c: TestContext): Promise<string> {
  const suffix = randomBytes(5).toString("hex");
  const raw = `marfa_k1_member_${suffix}`;
  const space = await c.storage.spaces!.create(`oauth-client-member-${suffix}`);
  await c.storage.keys.create(
    {
      label: `member-${suffix}`,
      source: `member-${suffix}`,
      space_permissions: [],
      type_permissions: { "core.note": "read" },
      default_tier: "library",
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    space.id,
  );
  return raw;
}

describe("POST /admin/oauth-clients/{client_id}/delete", () => {
  it("is operator-key only and refuses a confirm that is not the client id", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);

    const forbidden = await deleteClient(
      ctx,
      clientId,
      clientId,
      await memberKey(ctx),
    );
    expect(forbidden.status).toBe(403);
    // The whole space-permission set is what the first person in a space
    // holds, and what a gate widened to `requireAuth` would admit; this
    // route walks every space, so it has to be refused too.
    const asSpaceAdmin = await deleteClient(
      ctx,
      clientId,
      clientId,
      await spaceAdminKey(ctx),
    );
    expect(asSpaceAdmin.status).toBe(403);

    const mismatch = await deleteClient(
      ctx,
      clientId,
      "not-the-id",
      ctx.spaceKey,
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

    const res = await deleteClient(ctx, clientId, clientId, ctx.spaceKey);
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

    const res = await deleteClient(ctx, clientId, clientId, ctx.spaceKey);
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

    // A second call finds nothing carrying the id: 404, and no second audit
    // row, so a repeat or a typo is not recorded as a removal.
    const again = await deleteClient(ctx, clientId, clientId, ctx.spaceKey);
    expect(again.status).toBe(404);
    const rows = await ctx.storage.audit.list({
      action: "auth.client.deleted",
      limit: 10,
    });
    expect(rows.data.filter((r) => r.resource_id === clientId)).toHaveLength(1);
  });

  it("sweeps what no projection named, and a pending device code", async () => {
    // The orphan shape proper: plugin rows for a user whose projection is
    // gone, and a device code nobody approved, which is bound to no grant.
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "stray@example.com");
    await deviceGrant(ctx, clientId, cookie, "core.note:read offline_access");
    // The device approval wrote the consent row itself; an authorization
    // code never exchanged is seeded directly, since a code is a
    // verification row the per-grant cascade reaches only through a
    // projection.
    const strayUser = await authUserIdFor(ctx, "stray@example.com");
    await seedAuthorizationCode(ctx, clientId, strayUser);
    const [projection] =
      await ctx.storage.oauthProvider!.listGrantItemsForClient(clientId);
    await ctx.storage.items.transition(
      projection!.id,
      "revoked",
      projection!.spaceId ?? undefined,
    );
    await ctx.storage.items.purge(
      projection!.id,
      projection!.spaceId ?? undefined,
    );
    const pending = await request(ctx.app, "POST", "/auth/device", {
      body: { client_id: clientId, scope: "core.note:read" },
      headers: { origin: ORIGIN },
    });
    expect(pending.status).toBe(200);
    const before = await clientRows(ctx, clientId);
    expect(before).toMatchObject({
      accessTokens: 1,
      refreshTokens: 1,
      consents: 1,
      projections: 0,
    });

    const res = await deleteClient(ctx, clientId, clientId, ctx.spaceKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grants_removed: number;
      stray_records_deleted: number;
    };
    expect(body.grants_removed).toBe(0);
    // An access token, a refresh token, a consent row, an authorization code,
    // and two device codes: the approved one, which the per-grant sweep would
    // have taken had the projection still been there to name it, and the
    // pending one, which is bound to no grant and only the client-wide sweep
    // reaches.
    expect(body.stray_records_deleted).toBe(6);
    const audit = await ctx.storage.audit.list({
      action: "auth.client.deleted",
      limit: 10,
    });
    expect(audit.data[0]!.details.stray_authorization_codes_deleted).toBe(1);
    expect(await clientRows(ctx, clientId)).toEqual({
      clients: 0,
      accessTokens: 0,
      refreshTokens: 0,
      consents: 0,
      projections: 0,
    });
  });

  it("takes a projection's edges with it, writes a revoke row per grant, and names the operator", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "edges@example.com");
    await deviceGrant(ctx, clientId, cookie, "core.note:read");
    const [projection] =
      await ctx.storage.oauthProvider!.listGrantItemsForClient(clientId);
    const note = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { title: "points at the grant", body: "x" },
      },
    });
    expect(note.status).toBe(201);
    const noteId = ((await note.json()) as { item: { id: string } }).item.id;
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.spaceKey,
      body: {
        source_id: noteId,
        target_id: projection!.id,
        edge_type: "references",
      },
    });
    expect(edge.status).toBe(201);
    const edgeId = ((await edge.json()) as { edge: { id: string } }).edge.id;

    const res = await deleteClient(ctx, clientId, clientId, ctx.spaceKey);
    expect(res.status).toBe(200);
    // Edges are not foreign keys to items; they go explicitly, with the row.
    expect(await ctx.storage.edges.get(edgeId)).toBeNull();
    expect(
      await ctx.storage.items.getIncludingTrashed(projection!.id),
    ).toBeNull();
    // The grant's own space hears the revoke, the same row every other door
    // writes, and the platform row names the operator's key.
    // The revoke row is fire-and-forget by contract, so it is awaited into
    // view rather than read once.
    const revoked = await waitForAudit(
      () =>
        ctx!.storage.audit.list({ action: "auth.grant.revoked", limit: 10 }),
      (r) => r.data.some((row) => row.details.grant_item_id === projection!.id),
    );
    const mine = revoked.data.filter(
      (r) => r.details.grant_item_id === projection!.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.details.source).toBe("admin");
    expect(mine[0]!.space_id).toBe(projection!.spaceId);
    const deleted = await ctx.storage.audit.list({
      action: "auth.client.deleted",
      limit: 10,
    });
    const row = deleted.data.find((r) => r.resource_id === clientId);
    const operator = (await ctx.storage.keys.list()).find(
      (k) => k.is_operator && !k.space_id,
    );
    expect(operator).toBeDefined();
    expect(row?.key_id).toBe(operator!.id);
    // The space's own row names the operator too, not only the surface.
    expect(mine[0]!.key_id).toBe(operator!.id);
  });

  it("a client id nothing carries answers 404 and writes no audit row", async () => {
    ctx = await createTestContext();
    const res = await deleteClient(
      ctx,
      "client_never_was",
      "client_never_was",
      ctx.spaceKey,
    );
    expect(res.status).toBe(404);
    const rows = await ctx.storage.audit.list({
      action: "auth.client.deleted",
      limit: 10,
    });
    expect(rows.data).toEqual([]);
  });
});
