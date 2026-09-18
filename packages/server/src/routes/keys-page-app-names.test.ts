/**
 * The keys page resolves an app's client id to the app's name.
 *
 * The renderer groups by a display name, and the route is what turns the
 * client id stamped on the key into one. The two halves fail differently and
 * both fail quietly: a route that forgot to resolve would head a group with a
 * machine string, and a route that dropped the field would tell a person they
 * made a credential an app made.
 *
 * The fallback is the case worth pinning. An app whose registration has since
 * been removed leaves keys behind with a client id nothing can name, and the
 * heading is then the id — which is poor, and better than the alternative of
 * quietly filing the key under the person's own.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

const ORIGIN = "http://localhost:0";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/** Sign a person up, verify them, and return their session cookie. */
async function ownerCookie(c: TestContext, email: string): Promise<string> {
  await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password: "correct horse battery", name: "Owner" },
    headers: { origin: ORIGIN },
  });
  await markEmailVerified(c.storage, email);
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password: "correct horse battery" },
    headers: { origin: ORIGIN },
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeTruthy();
  return cookie ?? "";
}

/** Register an OAuth client so `getClientName` has a name to answer with. */
async function seedClient(c: TestContext, name: string): Promise<string> {
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  if (!c.storage.betterAuthDb) throw new Error("betterAuthDb missing");
  const schemaModule = await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const asColumn = (v: readonly string[]): unknown => JSON.stringify(v);
  const now = new Date();
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: `pk_${Math.random().toString(36).slice(2, 10)}`,
    clientId,
    name,
    redirectUris: asColumn([`${ORIGIN}/callback`]),
    grantTypes: asColumn(["authorization_code"]),
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: true,
    tokenEndpointAuthMethod: "none",
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

/**
 * Mint a key the person made themselves, through the console form, and answer
 * with the space it landed in.
 *
 * The space comes from the key rather than from a lookup because that is the
 * same space the page will list, and it puts a row in the person's own group
 * so the headings have both halves to tell apart.
 */
async function ownKeySpace(c: TestContext, cookie: string): Promise<string> {
  const res = await request(c.app, "POST", "/auth/keys", {
    form: { label: "my-own", scopes: "core.note:read" },
    headers: { origin: ORIGIN, cookie },
  });
  expect(res.status).toBe(200);
  const keys = await c.storage.keys.list();
  const mine = keys.find((k) => k.label === "my-own");
  expect(mine?.space_id).toBeTruthy();
  return mine?.space_id ?? "";
}

/** Put a key stamped with `clientId` into that space. */
async function seedAppKey(
  c: TestContext,
  spaceId: string,
  clientId: string,
): Promise<void> {
  const all = await c.storage.keys.list();
  const suffix = Math.random().toString(36).slice(2, 10);
  await c.storage.keys.create(
    {
      label: "made-by-an-app",
      source: `app-name-test-${suffix}`,
      space_permissions: [],
      type_permissions: { "core.note": "read" },
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      default_tier: "library",
      is_operator: false,
      oauth_client_id: clientId,
    },
    hashApiKey(`marfa_k1_app_${suffix}`, TEST_API_KEY_SALT),
    spaceId,
  );
  expect((await c.storage.keys.list()).length).toBe(all.length + 1);
}

describe("GET /auth/keys names the app that made a key", () => {
  it("heads the group with the registered app's name", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const email = "app-names@example.com";
    const cookie = await ownerCookie(ctx, email);
    const spaceId = await ownKeySpace(ctx, cookie);
    const clientId = await seedClient(ctx, "Notes for Marfa");
    await seedAppKey(ctx, spaceId, clientId);

    const res = await request(ctx.app, "GET", "/auth/keys", {
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Your keys");
    expect(html).toContain("Made by Notes for Marfa");
    expect(html).toContain("my-own");
    // The machine string never reaches the page when a name exists for it.
    expect(html).not.toContain(clientId);
  });

  it("falls back to the client id when the registration is gone", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const email = "app-names-gone@example.com";
    const cookie = await ownerCookie(ctx, email);
    const spaceId = await ownKeySpace(ctx, cookie);
    await seedAppKey(ctx, spaceId, "client_no_longer_registered");

    const res = await request(ctx.app, "GET", "/auth/keys", {
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Made by client_no_longer_registered");
  });
});
