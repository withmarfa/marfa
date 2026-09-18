/**
 * A grant nobody has used for the window is retired through the grant
 * cascade with an audit row saying why; a recent one is left alone; a
 * disabled window retires nothing.
 *
 * Driven through a real device grant rather than seeded rows, so the
 * cascade has real tokens and a real consent row to remove, and the
 * projection is backdated afterwards the way time would have.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { GrantInactivityRetirer } from "./retention.js";

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DAY_MS = 86_400_000;

function betterAuthSchema() {
  return import("../storage/sqlite/schema.js");
}

async function seedClient(c: TestContext): Promise<string> {
  const clientId = `client_${randomBytes(5).toString("hex")}`;
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  await oauth.createClient({
    clientId,
    name: "Forgotten App",
    isPublic: true,
    grantTypes: [DEVICE_GRANT],
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

/** Initiate, approve and poll once: a grant with a live access token. */
async function deviceGrant(
  c: TestContext,
  clientId: string,
  cookie: string,
): Promise<string> {
  const init = await request(c.app, "POST", "/auth/device", {
    body: { client_id: clientId, scope: "core.note:read offline_access" },
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
      // Everything ticked, which is what the screen submits untouched:
      // the approval form carries a checkbox per requested scope, so a
      // post with none is a denial rather than a full approval.
      scopes: "core.note:read offline_access".split(" ").filter(Boolean),
    },
    headers: { origin: ORIGIN, cookie },
  });
  expect(approve.status).toBe(200);
  const poll = await request(c.app, "POST", "/auth/device/token", {
    form: { grant_type: DEVICE_GRANT, device_code, client_id: clientId },
    headers: { origin: ORIGIN },
  });
  expect(poll.status).toBe(200);
  return ((await poll.json()) as { access_token: string }).access_token;
}

async function onlyGrant(c: TestContext) {
  const items = await c.storage.items.list({ type: "system.connection" });
  expect(items.data.length).toBe(1);
  return items.data[0]!;
}

/** The app grant projected for one client, when the space holds others. */
async function grantOf(c: TestContext, clientId: string) {
  const items = await c.storage.items.list({ type: "system.connection" });
  const own = items.data.filter(
    (i) => i.properties.kind === "app" && i.properties.client_id === clientId,
  );
  expect(own.length).toBe(1);
  return own[0]!;
}

async function consentRows(c: TestContext, clientId: string): Promise<number> {
  const schema = await betterAuthSchema();
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> };
    };
  };
  const rows = await db
    .select()
    .from(schema.auth_oauth_consent)
    .where(eq(schema.auth_oauth_consent.clientId, clientId));
  return rows.length;
}

/** Move the grant's clocks back, the way time would have. */
async function backdate(
  c: TestContext,
  clientId: string,
  daysAgo: number,
  fields: ("granted_at" | "last_used_at")[],
): Promise<void> {
  const grant = await grantOf(c, clientId);
  const then = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  const props = { ...grant.properties };
  for (const f of fields) props[f] = then;
  await c.storage.items.update(
    grant.id,
    { properties: props },
    grant.space_id ?? undefined,
  );
}

async function tokenRows(c: TestContext, clientId: string): Promise<number> {
  const schema = await betterAuthSchema();
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> };
    };
  };
  const access = await db
    .select()
    .from(schema.auth_oauth_access_token)
    .where(eq(schema.auth_oauth_access_token.clientId, clientId));
  const refresh = await db
    .select()
    .from(schema.auth_oauth_refresh_token)
    .where(eq(schema.auth_oauth_refresh_token.clientId, clientId));
  return access.length + refresh.length;
}

describe("GrantInactivityRetirer.runOnce", () => {
  it("retires a grant unused for longer than the window, with an audit row, and leaves a recent one and an integration alone", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "forgotten@example.com");
    const accessToken = await deviceGrant(ctx, clientId, cookie);
    expect(await tokenRows(ctx, clientId)).toBe(2);
    expect(await consentRows(ctx, clientId)).toBe(1);

    // Beside it: a grant used today, and a connection that is not a grant at
    // all. The sweep's predicate is `kind = 'app'` and a window; both have to
    // be there for a widened predicate to show.
    const freshClientId = await seedClient(ctx);
    const freshCookie = await signInUser(ctx, "present@example.com");
    await deviceGrant(ctx, freshClientId, freshCookie);
    const integration = await ctx.storage.items.create({
      type: "system.connection",
      tier: "library",
      state: "active",
      properties: {
        kind: "integration",
        integration_id: "int_dormant",
        status: "active",
        granted_at: new Date(Date.now() - 400 * DAY_MS).toISOString(),
        last_used_at: new Date(Date.now() - 400 * DAY_MS).toISOString(),
      },
      source: "test/retirer",
    });

    // Recent: nothing to retire.
    const retirer = new GrantInactivityRetirer(ctx.storage, 365, DAY_MS);
    expect(await retirer.runOnce()).toBe(0);
    expect((await grantOf(ctx, clientId)).properties.status).toBe("active");

    // Used long ago, approved longer ago: retired, and only it.
    await backdate(ctx, clientId, 400, ["granted_at", "last_used_at"]);
    expect(await retirer.runOnce()).toBe(1);
    const grant = await grantOf(ctx, clientId);
    expect(grant.properties.status).toBe("revoked");
    expect((await grantOf(ctx, freshClientId)).properties.status).toBe(
      "active",
    );
    expect(await tokenRows(ctx, freshClientId)).toBe(2);
    const untouched = await ctx.storage.items.get(integration.id);
    expect(untouched?.properties.status).toBe("active");
    expect(await tokenRows(ctx, clientId)).toBe(0);
    expect(await consentRows(ctx, clientId)).toBe(0);
    const dead = await request(ctx.app, "GET", "/items?type=core.note", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(dead.status).toBe(401);

    const audits = await waitForAudit(
      () =>
        ctx!.storage.audit.list({ action: "auth.grant.retired", limit: 10 }),
      (r) => r.data.length >= 1,
    );
    expect(audits.data.length).toBe(1);
    const row = audits.data[0]!;
    expect(row.resource_id).toBe(clientId);
    expect(row.details.client_id).toBe(clientId);
    expect(typeof row.details.user_id).toBe("string");
    expect(row.details.reason).toBe("inactive");
    expect(row.details.grant_item_id).toBe(grant.id);
    expect(row.details.inactivity_days).toBe(365);
    expect(typeof row.details.last_used_at).toBe("string");

    // Already retired: a second run finds nothing.
    expect(await retirer.runOnce()).toBe(0);
  });

  it("counts from the approval when the grant was never used, and a disabled window retires nothing", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "never-used@example.com");
    await deviceGrant(ctx, clientId, cookie);

    // The poll stamps last_used_at; clear it so the fallback to granted_at
    // is what decides. A merge keeps a key the patch omits and ignores a
    // null unless told to clear on it, so say so. Then move the approval
    // past the window.
    const grant = await onlyGrant(ctx);
    const props: Record<string, unknown> = {
      ...grant.properties,
      last_used_at: null,
    };
    props.granted_at = new Date(Date.now() - 400 * DAY_MS).toISOString();
    await ctx.storage.items.update(
      grant.id,
      { properties: props, null_clears: true },
      grant.space_id ?? undefined,
    );

    const disabled = new GrantInactivityRetirer(ctx.storage, 0, DAY_MS);
    expect(await disabled.runOnce()).toBe(0);
    expect((await onlyGrant(ctx)).properties.status).toBe("active");

    const retirer = new GrantInactivityRetirer(ctx.storage, 365, DAY_MS);
    expect(await retirer.runOnce()).toBe(1);
    expect((await onlyGrant(ctx)).properties.status).toBe("revoked");
  });
});
