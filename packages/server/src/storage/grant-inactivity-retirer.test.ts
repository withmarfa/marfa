/**
 * A grant nobody has used for the window is retired through the grant
 * cascade with an audit row saying why; a recent one is left alone; a
 * disabled window retires nothing.
 *
 * Driven through a real device grant rather than seeded rows, so the
 * cascade has real tokens and a real consent row to remove, and the
 * projection is backdated afterwards the way time would have.
 */
import { itemWrites } from "./item-writes.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createTestContext,
  createTestAccount,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { GrantInactivityRetirer } from "./retention.js";
import type { Storage } from "./interface.js";

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
    // The refresh grant too: the plugin mints a refresh token for
    // `offline_access` only when the client is registered for it.
    grantTypes: [DEVICE_GRANT, "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    scopes: null,
    redirectUris: [`${ORIGIN}/callback`],
    postLogoutRedirectUris: [`${ORIGIN}/`],
  });
  return clientId;
}

async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  await createTestAccount(c, email, password, "Test User");
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
  const init = await request(c.app, "POST", "/auth/device/code", {
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
  const poll = await request(c.app, "POST", "/auth/oauth2/token", {
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

/** The app grant projected for one client, when others are stored beside it. */
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
  await itemWrites(c.storage).update(grant.id, { properties: props });
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
  it("retires a grant unused for longer than the window, with an audit row, and leaves a recent one alone", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "forgotten@example.com");
    const accessToken = await deviceGrant(ctx, clientId, cookie);
    expect(await tokenRows(ctx, clientId)).toBe(2);
    expect(await consentRows(ctx, clientId)).toBe(1);

    // Beside it: a grant used today, so a widened window shows.
    const freshClientId = await seedClient(ctx);
    const freshCookie = await signInUser(ctx, "present@example.com");
    await deviceGrant(ctx, freshClientId, freshCookie);

    // Recent: nothing to retire.
    const retirer = new GrantInactivityRetirer(ctx.storage, 365);
    expect(await retirer.runOnce()).toBe(0);
    expect((await grantOf(ctx, clientId)).properties.status).toBe("active");

    // Used long ago, approved longer ago: retired, and only it.
    await backdate(ctx, clientId, 400, ["granted_at", "last_used_at"]);
    const raw = ctx.storage as Storage & {
      __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun(
      "CREATE TRIGGER reject_retired_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'auth.grant.retired' BEGIN SELECT RAISE(ABORT, 'retirement audit refused'); END",
      [],
    );
    expect(await retirer.runOnce()).toBe(0);
    expect((await grantOf(ctx, clientId)).properties.status).toBe("active");
    expect(await tokenRows(ctx, clientId)).toBe(2);
    expect(await consentRows(ctx, clientId)).toBe(1);
    expect(
      (await request(ctx.app, "GET", "/items", { key: accessToken })).status,
    ).toBe(200);
    expect(
      (await ctx.storage.audit.list({ action: "auth.grant.retired" })).data,
    ).toHaveLength(0);
    await raw.__sqliteRun("DROP TRIGGER reject_retired_audit", []);
    // The live-token control above counts as use. Age it again for the retry.
    await backdate(ctx, clientId, 400, ["granted_at", "last_used_at"]);
    expect(await retirer.runOnce()).toBe(1);
    const grant = await grantOf(ctx, clientId);
    expect(grant.properties.status).toBe("revoked");
    expect((await grantOf(ctx, freshClientId)).properties.status).toBe(
      "active",
    );
    expect(await tokenRows(ctx, freshClientId)).toBe(2);
    expect(await tokenRows(ctx, clientId)).toBe(0);
    expect(await consentRows(ctx, clientId)).toBe(0);
    const dead = await request(ctx.app, "GET", "/items?type=core.note", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(dead.status).toBe(401);

    const audits = await ctx.storage.audit.list({
      action: "auth.grant.retired",
      limit: 10,
    });
    expect(audits.data.length >= 1).toBe(true);
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

  it.each(["last_used_at", "granted_at"] as const)(
    "leaves a grant alone whose %s moved after the list was read",
    async (field) => {
      ctx = await createTestContext({});
      const clientId = await seedClient(ctx);
      const cookie = await signInUser(ctx, `moved-${field}@example.com`);
      await deviceGrant(ctx, clientId, cookie);
      await backdate(ctx, clientId, 400, ["granted_at", "last_used_at"]);
      const dormant = async () => {
        await backdate(ctx!, clientId, 400, ["granted_at", "last_used_at"]);
        // Never used: the approval is the clock that counts.
        if (field === "granted_at") {
          const grant = await grantOf(ctx!, clientId);
          const props: Record<string, unknown> = { ...grant.properties };
          Reflect.deleteProperty(props, "last_used_at");
          await itemWrites(ctx!.storage).update(grant.id, {
            properties: props,
            properties_mode: "replace",
          });
        }
      };
      await dormant();
      const retirer = new GrantInactivityRetirer(ctx.storage, 365);
      const listed = ctx.storage.items.listInactiveAppGrants.bind(
        ctx.storage.items,
      );
      const moveAfterList = vi
        .spyOn(ctx.storage.items, "listInactiveAppGrants")
        .mockImplementationOnce(async (cutoff) => {
          const rows = await listed(cutoff);
          expect(rows).toHaveLength(1);
          const grant = await grantOf(ctx!, clientId);
          await itemWrites(ctx!.storage).update(grant.id, {
            properties: {
              ...grant.properties,
              [field]: new Date().toISOString(),
            },
          });
          return rows;
        });
      expect(await retirer.runOnce()).toBe(0);
      expect(moveAfterList).toHaveBeenCalledOnce();
      expect((await grantOf(ctx, clientId)).properties.status).toBe("active");
      expect(await tokenRows(ctx, clientId)).toBe(2);
      expect(await consentRows(ctx, clientId)).toBe(1);
      expect(
        (await ctx.storage.audit.list({ action: "auth.grant.retired" })).data,
      ).toHaveLength(0);

      // The witness: with nothing moved, the same grant is retired.
      await dormant();
      expect(await retirer.runOnce()).toBe(1);
      expect((await grantOf(ctx, clientId)).properties.status).toBe("revoked");
    },
  );

  it("counts from the approval when the grant was never used, and a disabled window retires nothing", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "never-used@example.com");
    await deviceGrant(ctx, clientId, cookie);

    // The poll stamps last_used_at; clear it so the fallback to granted_at
    // is what decides. A merge keeps a key the patch omits and drops a null
    // on an optional field, so the key goes with a replace that leaves it
    // out. Then move the approval past the window.
    const grant = await onlyGrant(ctx);
    const props: Record<string, unknown> = { ...grant.properties };
    Reflect.deleteProperty(props, "last_used_at");
    props.granted_at = new Date(Date.now() - 400 * DAY_MS).toISOString();
    await itemWrites(ctx.storage).update(grant.id, {
      properties: props,
      properties_mode: "replace",
    });

    const disabled = new GrantInactivityRetirer(ctx.storage, 0);
    expect(await disabled.runOnce()).toBe(0);
    expect((await onlyGrant(ctx)).properties.status).toBe("active");

    const retirer = new GrantInactivityRetirer(ctx.storage, 365);
    expect(await retirer.runOnce()).toBe(1);
    expect((await onlyGrant(ctx)).properties.status).toBe("revoked");
  });

  it("passes over a grant that cannot be revoked, but ends the sweep when the client is gone", async () => {
    // Two dormant grants with no plugin rows behind them, so the cascade is
    // one update each; the first update fails, and what the sweep does
    // next depends on how.
    const inactive = [
      { id: "grant-a", properties: {}, clientId: null, authUserId: null },
      { id: "grant-b", properties: {}, clientId: null, authUserId: null },
    ];
    const storageFailingWith = (code: string) => {
      const updated: string[] = [];
      const storage = {
        runInTransaction: <T>(fn: () => Promise<T>) => fn(),
        items: {
          listInactiveAppGrants: () => Promise.resolve(inactive),
          get: (id: string) =>
            Promise.resolve({
              id,
              state: "active",
              properties: {
                status: "active",
                last_used_at: "2000-01-01T00:00:00.000Z",
              },
            }),
          getIncludingTrashed: (id: string) =>
            Promise.resolve({
              id,
              type: "system.connection",
              state: "active",
              properties: {},
              version: 1,
            }),
          update: (id: string) => {
            updated.push(id);
            return id === "grant-a"
              ? Promise.reject(Object.assign(new Error(code), { code }))
              : Promise.resolve({ id });
          },
        },
        metadata: { get: () => Promise.resolve(null) },
        audit: { log: () => Promise.resolve() },
      } as unknown as Storage;
      return { storage, updated };
    };
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      // An ordinary fault on one grant is logged and the next is retired.
      const faulty = storageFailingWith("SQLITE_CONSTRAINT");
      expect(
        await new GrantInactivityRetirer(faulty.storage, 365).runOnce(),
      ).toBe(1);
      expect(faulty.updated).toEqual(["grant-a", "grant-b"]);

      // A lost client ends the sweep at the grant it met, for the scheduler
      // to classify.
      const lost = storageFailingWith("CLIENT_CLOSED");
      await expect(
        new GrantInactivityRetirer(lost.storage, 365).runOnce(),
      ).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
      expect(lost.updated).toEqual(["grant-a"]);
    } finally {
      stdout.mockRestore();
    }
  });
});
