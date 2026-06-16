import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Onboarding provisioning + self-serve key tests (T-326).
 *
 * Two guarantees:
 *   1. A Marfa tenant + users row is provisioned for EVERY new account,
 *      on both the programmatic `POST /auth/sign-up/email` path and the
 *      server-rendered `POST /auth/sign-up` form — owned by the
 *      `databaseHooks.user.create.after` hook, not the form wrapper.
 *   2. A signed-in tenant owner can mint a working long-lived `marfa_k1_`
 *      key self-serve at `/auth/keys`, with the data plane still
 *      bearer-only.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

function extractRawKey(html: string): string | null {
  return /marfa_k1_[a-f0-9]{64}/.exec(html)?.[0] ?? null;
}

async function signIn(
  c: TestContext,
  email: string,
  password: string,
): Promise<string | null> {
  const res = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  return res.headers.get("set-cookie")?.split(";")[0] ?? null;
}

describe("onboarding tenant provisioning (T-326)", () => {
  it("provisions a tenant + derived handle on the programmatic sign-up path", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const res = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "alice@example.com",
        password: "correct horse battery",
        name: "Alice",
      },
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { id?: string } };
    const authUserId = body.user?.id;
    expect(authUserId).toBeTruthy();

    const users = ctx.storage.users;
    expect(users).toBeTruthy();
    const row = await users?.getByAuthUserId(authUserId ?? "");
    // The headline fix: a tenant exists, anchored to the new account.
    expect(row?.tenant_id).toBeTruthy();
    const tenant = await ctx.storage.tenants?.get(row?.tenant_id ?? "");
    expect(tenant).toBeTruthy();
    // No username was supplied, so the handle is derived from the email.
    expect(row?.handle).toBe("alice");
  });

  it("claims the chosen handle on the HTML form sign-up path", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const res = await request(ctx.app, "POST", "/auth/sign-up", {
      form: {
        email: "bob@example.com",
        name: "Bob",
        username: "bobby",
        password: "correct horse battery",
        password_confirm: "correct horse battery",
      },
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(302);

    // The form-chosen handle is claimed, with a tenant anchored to it.
    const row = await ctx.storage.users?.getByHandle("bobby");
    expect(row?.handle).toBe("bobby");
    expect(row?.tenant_id).toBeTruthy();
  });

  it("does not double-provision when the same email signs up twice", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const signUp = (): Promise<Response> =>
      request(ctx!.app, "POST", "/auth/sign-up/email", {
        body: {
          email: "carol@example.com",
          password: "correct horse battery",
          name: "Carol",
        },
        headers: { origin: ORIGIN },
      });
    const first = await signUp();
    expect(first.status).toBe(200);
    const firstId = ((await first.json()) as { user?: { id?: string } }).user
      ?.id;
    const firstRow = await ctx.storage.users?.getByAuthUserId(firstId ?? "");
    expect(firstRow?.tenant_id).toBeTruthy();

    // A duplicate sign-up must not create a second users row / tenant for
    // the same account (Better Auth returns the existing user id).
    await signUp();
    const stillRow = await ctx.storage.users?.getByAuthUserId(firstId ?? "");
    expect(stillRow?.tenant_id).toBe(firstRow?.tenant_id);
  });
});

describe("self-serve API keys at /auth/keys (T-326)", () => {
  it("redirects to sign-in when unauthenticated", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const res = await request(ctx.app, "GET", "/auth/keys", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/sign-in");
  });

  it("mints a working marfa_k1_ key for a signed-in owner", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "dana@example.com",
        password: "correct horse battery",
        name: "Dana",
      },
      headers: { origin: ORIGIN },
    });
    await markEmailVerified(ctx.storage, "dana@example.com");
    const cookie = await signIn(
      ctx,
      "dana@example.com",
      "correct horse battery",
    );
    expect(cookie).toBeTruthy();

    const mintRes = await request(ctx.app, "POST", "/auth/keys", {
      form: { label: "laptop CLI", scopes: "core.note:read" },
      headers: { origin: ORIGIN, cookie: cookie ?? "" },
    });
    expect(mintRes.status).toBe(200);
    const html = await mintRes.text();
    const rawKey = extractRawKey(html);
    expect(rawKey).toBeTruthy();

    // The minted key actually authenticates the bearer-only data plane.
    const itemsRes = await request(ctx.app, "GET", "/items", {
      key: rawKey ?? "",
    });
    expect(itemsRes.status).toBe(200);
  });

  it("revokes a key the owner created", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: {
        email: "erin@example.com",
        password: "correct horse battery",
        name: "Erin",
      },
      headers: { origin: ORIGIN },
    });
    await markEmailVerified(ctx.storage, "erin@example.com");
    const cookie = await signIn(
      ctx,
      "erin@example.com",
      "correct horse battery",
    );

    const mintRes = await request(ctx.app, "POST", "/auth/keys", {
      form: { label: "throwaway", scopes: "core.note:read" },
      headers: { origin: ORIGIN, cookie: cookie ?? "" },
    });
    const rawKey = extractRawKey(await mintRes.text());
    expect(rawKey).toBeTruthy();

    const row = await ctx.storage.users?.getByHandle("erin");
    const keys = (await ctx.storage.keys.list()).filter(
      (k) => k.tenant_id === row?.tenant_id,
    );
    expect(keys.length).toBe(1);
    const keyId = keys[0]?.id ?? "";

    const revokeRes = await request(
      ctx.app,
      "POST",
      `/auth/keys/${keyId}/revoke`,
      { headers: { origin: ORIGIN, cookie: cookie ?? "" } },
    );
    expect(revokeRes.status).toBe(200);

    // The revoked key no longer authenticates.
    const itemsRes = await request(ctx.app, "GET", "/items", {
      key: rawKey ?? "",
    });
    expect(itemsRes.status).toBe(401);
  });
});
