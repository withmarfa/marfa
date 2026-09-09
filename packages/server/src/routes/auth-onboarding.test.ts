import { describe, it, expect, afterEach } from "vitest";
import {
  createTestContext,
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

/**
 * Onboarding provisioning + self-serve key tests (T-326).
 *
 * Two guarantees:
 *   1. A Marfa space + users row is provisioned for EVERY new account,
 *      on both the programmatic `POST /auth/sign-up/email` path and the
 *      server-rendered `POST /auth/sign-up` form — owned by the
 *      `databaseHooks.user.create.after` hook, not the form wrapper.
 *   2. A signed-in space owner can mint a working long-lived `marfa_k1_`
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

describe("onboarding space provisioning (T-326)", () => {
  it("provisions a space + derived handle on the programmatic sign-up path", async () => {
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
    // The headline fix: a space exists, anchored to the new account.
    expect(row?.space_id).toBeTruthy();
    const space = await ctx.storage.spaces?.get(row?.space_id ?? "");
    expect(space).toBeTruthy();
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

    // The form-chosen handle is claimed, with a space anchored to it.
    const row = await ctx.storage.users?.getByHandle("bobby");
    expect(row?.handle).toBe("bobby");
    expect(row?.space_id).toBeTruthy();
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
    expect(firstRow?.space_id).toBeTruthy();

    // A duplicate sign-up must not create a second users row / space for
    // the same account (Better Auth returns the existing user id).
    await signUp();
    const stillRow = await ctx.storage.users?.getByAuthUserId(firstId ?? "");
    expect(stillRow?.space_id).toBe(firstRow?.space_id);
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
      (k) => k.space_id === row?.space_id,
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

/**
 * A person who signs up owns their space, and until this landed they could not
 * fill it. The self-serve console minted a `member` key carrying only
 * `type_permissions` and never set `edge_permissions`, so a self-serve key
 * writing an edge got `403 edge_permission_denied`. Edges are the substance of
 * the data model, so that key could not seed, migrate or restore a space, and
 * every seeding job had to be done for the owner by the operator key — the
 * exact dependency a space-bound working credential exists to remove.
 *
 * The ceiling is the other half and is not optional: a self-serve credential
 * must never exceed the permission set of whoever made it, so both directions
 * are pinned here.
 */
describe("self-serve keys can fill their own space", () => {
  async function ownerCookie(tc: TestContext, email: string): Promise<string> {
    await request(tc.app, "POST", "/auth/sign-up/email", {
      body: { email, password: "correct horse battery", name: "Owner" },
      headers: { origin: ORIGIN },
    });
    await markEmailVerified(tc.storage, email);
    const cookie = await signIn(tc, email, "correct horse battery");
    expect(cookie).toBeTruthy();
    return cookie ?? "";
  }

  it("mints a key that can write an edge, not just an item", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "edges@example.com");

    const mintRes = await request(ctx.app, "POST", "/auth/keys", {
      form: { label: "seeder", scopes: "core.note:write" },
      headers: { origin: ORIGIN, cookie },
    });
    expect(mintRes.status).toBe(200);
    const rawKey = extractRawKey(await mintRes.text());
    expect(rawKey).toBeTruthy();
    const key = rawKey ?? "";

    const a = await request(ctx.app, "POST", "/items", {
      key,
      body: { type: "core.note", properties: { body: "one" } },
    });
    const b = await request(ctx.app, "POST", "/items", {
      key,
      body: { type: "core.note", properties: { body: "two" } },
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const aId = ((await a.json()) as { item: { id: string } }).item.id;
    const bId = ((await b.json()) as { item: { id: string } }).item.id;

    // This is the assertion the whole ticket turns on. Before the fix it was
    // 403 edge_permission_denied — "Missing edge.references:write permission".
    const edgeRes = await request(ctx.app, "POST", "/edges", {
      key,
      body: { source_id: aId, target_id: bId, edge_type: "references" },
    });
    // Surface the server's own error on failure; a bare status makes a
    // permission refusal and a malformed request look identical.
    expect(
      edgeRes.status,
      `POST /edges -> ${String(edgeRes.status)}: ${await edgeRes.clone().text()}`,
    ).toBe(201);
  });

  it("grants full access at the owner's own role and never above it", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "full@example.com");

    const mintRes = await request(ctx.app, "POST", "/auth/keys", {
      form: { label: "migration", full_access: "on" },
      headers: { origin: ORIGIN, cookie },
    });
    expect(mintRes.status).toBe(200);
    const rawKey = extractRawKey(await mintRes.text());
    expect(rawKey).toBeTruthy();

    const minted = (await ctx.storage.keys.list()).find(
      (k) => k.label === "migration",
    );
    expect(minted).toBeTruthy();

    // Sideways, never up. The first person in a space holds every space
    // permission in it, so full access hands that whole set down — and the
    // operator flag (authority bounded by no space at all) stays unreachable
    // from a self-serve form whatever the form says.
    expect(new Set(minted?.space_permissions)).toEqual(
      new Set(SPACE_PERMISSIONS),
    );
    expect(minted?.is_operator).toBe(false);

    // And it can actually do the job it exists for.
    const noteRes = await request(ctx.app, "POST", "/items", {
      key: rawKey ?? "",
      body: { type: "core.note", properties: { body: "seeded" } },
    });
    expect(noteRes.status).toBe(201);
  });

  it("hands a scoped key no space permissions even though the owner holds them all", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "scoped@example.com");

    await request(ctx.app, "POST", "/auth/keys", {
      form: { label: "read only", scopes: "core.note:read" },
      headers: { origin: ORIGIN, cookie },
    });
    const minted = (await ctx.storage.keys.list()).find(
      (k) => k.label === "read only",
    );
    // Not ticking full access must not quietly inherit the owner's authority.
    expect(minted?.space_permissions ?? []).toEqual([]);
  });
});

/**
 * What the console form mints on the edge axis is decided by what the owner
 * picked, and picking is done in permissions rather than in characters.
 *
 * The form's own submissions are content permissions and a full-access
 * switch, but the handler accepts any valid permission the request carries,
 * and it decided the key's edge reach by asking whether some literal ended in
 * `:write`. `metadata.types:write` ends that way and registers a type;
 * `edge.parent-of:write` ends that way and names one relation. Neither says
 * the owner asked for write across the space's whole edge graph, and both
 * produced a key holding exactly that.
 */
describe("a self-serve key's edge reach follows the permissions picked", () => {
  async function ownerCookie(tc: TestContext, email: string): Promise<string> {
    await request(tc.app, "POST", "/auth/sign-up/email", {
      body: { email, password: "correct horse battery", name: "Owner" },
      headers: { origin: ORIGIN },
    });
    await markEmailVerified(tc.storage, email);
    const cookie = await signIn(tc, email, "correct horse battery");
    expect(cookie).toBeTruthy();
    return cookie ?? "";
  }

  async function mint(
    tc: TestContext,
    cookie: string,
    label: string,
    scopes: string[],
  ): Promise<Record<string, string> | undefined> {
    const res = await request(tc.app, "POST", "/auth/keys", {
      form: { label, scopes },
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.status).toBe(200);
    const minted = (await tc.storage.keys.list()).find(
      (k) => k.label === label,
    );
    expect(minted).toBeTruthy();
    return minted?.edge_permissions;
  }

  it("does not read a metadata permission as a content write", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "metadata-scope@example.com");

    // Read-only on notes, plus the ability to register a type. Nothing here
    // asks to change anything, and the key held write on every edge type in
    // the space, including the ones the space registers later.
    const edges = await mint(ctx, cookie, "type registrar", [
      "core.note:read",
      "metadata.types:write",
    ]);
    expect(edges).toEqual({ "*": "read" });
  });

  it("keeps an edge permission to the relation it names", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "one-edge@example.com");

    const edges = await mint(ctx, cookie, "one relation", [
      "edge.parent-of:write",
    ]);
    expect(edges).toEqual({ "parent-of": "write" });
  });

  // The wildcard and a named relation both survive only when the named one is
  // the wider of the two, and that branch has to be exercised from both
  // sides. `edgePermissionCovers` resolves an exact edge type ahead of any
  // pattern, so a `parent-of` entry dropped here would leave the wildcard
  // deciding it, and a `parent-of` entry kept at the wrong level would deny
  // writes on the single relation the owner actually named.
  it("keeps a named relation that outranks the mirrored wildcard", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "named-beats-mirror@example.com");

    const edges = await mint(ctx, cookie, "reader plus one relation", [
      "core.note:read",
      "edge.parent-of:write",
    ]);
    expect(edges).toEqual({ "*": "read", "parent-of": "write" });
  });

  it("keeps a named relation that outranks a named wildcard", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "named-beats-named@example.com");

    const edges = await mint(ctx, cookie, "edge reader plus one writer", [
      "edge.*:read",
      "edge.parent-of:write",
    ]);
    expect(edges).toEqual({ "*": "read", "parent-of": "write" });
  });

  it("grants nothing on the edge axis when nothing was picked", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "no-content@example.com");

    const edges = await mint(ctx, cookie, "registrar only", [
      "metadata.types:write",
    ]);
    expect(edges).toEqual({});
  });

  // The other half, and the reason the wildcard is here at all: a key scoped
  // to content the owner can change has to be able to build the relations
  // between it, including relation types the space registers later.
  it("still mirrors a content write across every edge type", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "content-write@example.com");

    const edges = await mint(ctx, cookie, "seeder", ["core.note:write"]);
    expect(edges).toEqual({ "*": "write" });
  });

  it("mirrors a content read as edge read, not edge write", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "content-read@example.com");

    const edges = await mint(ctx, cookie, "reader", ["core.note:read"]);
    expect(edges).toEqual({ "*": "read" });
  });

  // The reveal page names what the key can do, and the fallback said "can
  // access your content" for a key whose content permissions are empty.
  it("tells the owner when a minted key reaches none of their content", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "no-content-copy@example.com");

    const res = await request(ctx.app, "POST", "/auth/keys", {
      form: { label: "registrar", scopes: ["metadata.types:write"] },
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("reach none of your content");
    expect(html).not.toContain("access your content");
  });

  it("gives full access the whole edge graph", async () => {
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const cookie = await ownerCookie(ctx, "full-edges@example.com");

    const res = await request(ctx.app, "POST", "/auth/keys", {
      form: { label: "migration", full_access: "on" },
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.status).toBe(200);
    const minted = (await ctx.storage.keys.list()).find(
      (k) => k.label === "migration",
    );
    expect(minted?.edge_permissions).toEqual({ "*": "write" });
  });
});
