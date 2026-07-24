/**
 * Tests for the consent-skip path on GET /auth/authorize.
 *
 * When a signed authorize request lands on the consent page and the
 * user's prior grant for the client already covers every requested
 * scope, the route must NOT render the consent screen again — it
 * performs the accept server-side (proxying `{ accept: true }` to the
 * plugin's /oauth2/consent) and 302s the browser straight back to the
 * client's redirect_uri with a fresh authorization code.
 *
 * Coverage:
 *   - second authorize with the SAME scopes skips consent (302 + code,
 *     no HTML) — the regression this fix exists for
 *   - requested ⊂ prior (subset) skips
 *   - requested ⊃ prior (superset) renders the re-consent diff
 *   - prompt=consent always renders, even when covered
 *   - prompt=none with a covering grant silently mints a code
 *   - prompt=none without a covering grant 302s to redirect_uri with
 *     error=consent_required (never renders UI)
 *   - a revoked grant renders (revocation deletes the consent row)
 *   - the skip emits `auth.grant.reused` (and does NOT touch the
 *     projected grant record or re-emit `auth.grant.created`)
 *
 * These tests drive the REAL signed-query flow: GET /auth/oauth2/authorize
 * produces a plugin-signed query (via the consent/login redirect), the
 * decision POST performs a genuine first consent, and the second
 * authorize replays the signed query against /auth/authorize the way a
 * post-sign-in return_to does. prompt=none queries are minted locally
 * with better-auth's `makeSignature` against the fixed test auth secret.
 */
import { describe, it, expect, afterEach } from "vitest";
import { makeSignature } from "better-auth/crypto";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForAudit,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";

/** Mirrors the `authSecret` default in `createTestContext` — needed to
 *  mint locally signed queries the plugin's sig verification accepts. */
const TEST_AUTH_SECRET =
  "test-auth-secret-change-in-production-not-required-here";

/** Seed an `auth_oauth_client` row directly (same shape the plugin's DCR
 *  endpoint would write). Public client, PKCE-bound, one callback URI. */
async function seedClient(c: TestContext): Promise<string> {
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  const clientPk = `pk_${Math.random().toString(36).slice(2, 10)}`;
  if (!c.storage.betterAuthDb) {
    throw new Error("seedClient: storage.betterAuthDb missing");
  }
  const schemaModule =
    c.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const now = new Date();
  // PG has native `text[]` columns for the plugin's `string[]` fields;
  // SQLite stays on `text` with JSON-serialized arrays.
  const redirectUris: unknown =
    c.storage.betterAuthDialect === "pg"
      ? [CALLBACK]
      : JSON.stringify([CALLBACK]);
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: clientPk,
    clientId,
    name: "Skip Test Client",
    redirectUris,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: true,
    tokenEndpointAuthMethod: "none",
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

/** Sign up + verify + sign in; returns the session cookie (`name=value`). */
async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  const signUpRes = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Test User" },
    headers: { origin: ORIGIN },
  });
  if (signUpRes.status !== 200) {
    const text = await signUpRes.text();
    throw new Error(
      `sign-up failed (${String(signUpRes.status)}): ${text.slice(0, 300)}`,
    );
  }
  await markEmailVerified(c.storage, email);
  const signInRes = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (signInRes.status !== 200) {
    const text = await signInRes.text();
    throw new Error(
      `sign-in failed (${String(signInRes.status)}): ${text.slice(0, 300)}`,
    );
  }
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  const cookies = setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/);
  for (const c2 of cookies) {
    const head = c2.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("sign-in: session_token cookie not found in Set-Cookie");
}

/** Kick off the real authorize flow at the plugin's endpoint. */
async function beginAuthorize(
  c: TestContext,
  clientId: string,
  scope: string,
  cookie?: string,
  extra?: Record<string, string>,
): Promise<Response> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope,
    state: "skip-state",
    code_challenge: "0123456789012345678901234567890123456789012",
    code_challenge_method: "S256",
    ...extra,
  });
  return request(c.app, "GET", `/auth/oauth2/authorize?${params.toString()}`, {
    headers: cookie ? { cookie } : {},
  });
}

/** Extract the plugin-signed query string from a redirect Location. */
function signedQueryOf(res: Response): string {
  const location = res.headers.get("location") ?? "";
  const idx = location.indexOf("?");
  if (idx < 0) throw new Error(`no query in Location: ${location}`);
  return location.slice(idx + 1);
}

/**
 * Run the full first-consent dance for `scopes` and return the signed
 * query it used (still valid for replay within the plugin's exp window):
 * plugin authorize → consent-page redirect → decision POST accept →
 * 302 back to the callback with a code.
 */
async function grantFirstConsent(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
  scopes: string[],
): Promise<string> {
  const authorizeRes = await beginAuthorize(c, clientId, scope, cookie);
  expect(authorizeRes.status).toBe(302);
  const location = authorizeRes.headers.get("location") ?? "";
  expect(location).toContain("/auth/authorize?");
  const signedQuery = signedQueryOf(authorizeRes);

  const decisionRes = await request(c.app, "POST", "/auth/authorize/decision", {
    form: { accept: "true", oauth_query: signedQuery, scopes },
    headers: { cookie },
  });
  expect(decisionRes.status).toBe(302);
  const cbLocation = decisionRes.headers.get("location") ?? "";
  expect(cbLocation.startsWith(CALLBACK)).toBe(true);
  expect(new URL(cbLocation).searchParams.get("code")).toBeTruthy();
  return signedQuery;
}

/** Mint a locally signed query the plugin's before-hook verifies. */
async function mintSignedQuery(
  fields: Record<string, string>,
): Promise<string> {
  const params = new URLSearchParams(fields);
  params.set("exp", String(Math.floor(Date.now() / 1000) + 600));
  params.set("ba_iat", String(Date.now()));
  const sig = await makeSignature(params.toString(), TEST_AUTH_SECRET);
  params.append("sig", sig);
  return params.toString();
}

function expectCodeRedirect(res: Response): void {
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  expect(location.startsWith(CALLBACK)).toBe(true);
  expect(new URL(location).searchParams.get("code")).toBeTruthy();
  expect(new URL(location).searchParams.get("error")).toBeNull();
}

// ---------------------------------------------------------------------------
// Skip-when-already-granted
// ---------------------------------------------------------------------------

describe("GET /auth/authorize (consent skip)", () => {
  it("REGRESSION: second authorize with the same scopes skips consent — 302 straight to redirect_uri with a code, no HTML", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-equal@example.com");
    const scope = "openid core.note:read";

    const signedQuery = await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    // Replay the signed query at the consent page, the way a post-sign-in
    // return_to lands there. The grant already covers the request, so no
    // consent screen — a silent 302 back to the app with a fresh code.
    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${signedQuery}`,
      { headers: { cookie } },
    );
    expectCodeRedirect(res);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("skips when the requested scopes are a subset of the prior grant", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-subset@example.com");

    await grantFirstConsent(
      ctx,
      clientId,
      cookie,
      "openid core.note:read core.note:write",
      ["openid", "core.note:read", "core.note:write"],
    );

    // Obtain a signed query for the NARROWER request via the login-redirect
    // path (no cookie → the plugin signs the params and bounces to
    // /auth/sign-in?<signed>), then land on the consent page signed in.
    const loginRedirect = await beginAuthorize(
      ctx,
      clientId,
      "openid core.note:read",
    );
    expect(loginRedirect.status).toBe(302);
    expect(loginRedirect.headers.get("location") ?? "").toContain(
      "/auth/sign-in?",
    );
    const subsetSignedQuery = signedQueryOf(loginRedirect);

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${subsetSignedQuery}`,
      { headers: { cookie } },
    );
    expectCodeRedirect(res);
  });

  it("renders the re-consent diff when the request widens the prior grant (superset)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-superset@example.com");

    await grantFirstConsent(ctx, clientId, cookie, "openid core.note:read", [
      "openid",
      "core.note:read",
    ]);

    // Widened request: the plugin's own consent check misses (scopes not
    // covered) and redirects to the consent page; the page must render
    // the diff, not silently approve scopes the user never granted.
    const authorizeRes = await beginAuthorize(
      ctx,
      clientId,
      "openid core.note:read core.note:write",
      cookie,
    );
    expect(authorizeRes.status).toBe(302);
    expect(authorizeRes.headers.get("location") ?? "").toContain(
      "/auth/authorize?",
    );
    const supersetSignedQuery = signedQueryOf(authorizeRes);

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${supersetSignedQuery}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    // Diff sections from the re-consent renderer.
    expect(html).toContain(">New</p>");
    expect(html).toContain("Already allowed");
  });

  it("prompt=consent forces a render even when the grant covers the request", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-prompt-consent@example.com");
    const scope = "openid core.note:read";

    await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    // prompt=consent rides the signed query: the plugin redirects to the
    // consent page even with a covering grant, and the page must render.
    const authorizeRes = await beginAuthorize(ctx, clientId, scope, cookie, {
      prompt: "consent",
    });
    expect(authorizeRes.status).toBe(302);
    expect(authorizeRes.headers.get("location") ?? "").toContain(
      "/auth/authorize?",
    );
    const signedQuery = signedQueryOf(authorizeRes);

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${signedQuery}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  it("prompt=none with a covering grant silently mints a code", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-none-grant@example.com");
    const scope = "openid core.note:read";

    await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    // The plugin never routes prompt=none to the consent page itself, so
    // mint a validly signed query to exercise the route's own handling of
    // a direct hit.
    const signedQuery = await mintSignedQuery({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      scope,
      state: "none-state",
      code_challenge: "0123456789012345678901234567890123456789012",
      code_challenge_method: "S256",
      prompt: "none",
    });

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${signedQuery}`,
      { headers: { cookie } },
    );
    expectCodeRedirect(res);
  });

  it("prompt=none without a covering grant redirects with error=consent_required and never renders", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-none-nogrant@example.com");

    // No prior consent. Signature validity is irrelevant on this path —
    // the route redirects (against the client's REGISTERED redirect_uri)
    // without proxying anything; only sig presence is required.
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      scope: "openid core.note:read",
      state: "none-err-state",
      code_challenge: "0123456789012345678901234567890123456789012",
      code_challenge_method: "S256",
      prompt: "none",
      exp: String(Math.floor(Date.now() / 1000) + 600),
      sig: "fake",
    });

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${params.toString()}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(CALLBACK)).toBe(true);
    const url = new URL(location);
    expect(url.searchParams.get("error")).toBe("consent_required");
    expect(url.searchParams.get("state")).toBe("none-err-state");
    expect(url.searchParams.get("code")).toBeNull();
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("prompt=none with an unregistered redirect_uri 400s instead of redirecting", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-none-baduri@example.com");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example.com/steal",
      scope: "openid",
      prompt: "none",
      exp: String(Math.floor(Date.now() / 1000) + 600),
      sig: "fake",
    });

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${params.toString()}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });

  it("renders after the grant is revoked (revocation deletes the consent row)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-revoked@example.com");
    const scope = "openid core.note:read";

    const signedQuery = await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    // Resolve the consenting user from the projection, then revoke the
    // grant the way /auth/grants/:id/revoke does.
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    const authUserId = items.data[0]!.properties.user_id as string;
    await ctx.storage.oauthProvider!.revokeTokensForGrant(clientId, authUserId);

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${signedQuery}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  it("emits auth.grant.reused on skip and leaves the grant record untouched", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-audit@example.com");
    const scope = "openid core.note:read";

    const signedQuery = await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    const before = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(before.data.length).toBe(1);
    const grantBefore = before.data[0]!;

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${signedQuery}`,
      { headers: { cookie }, peer: "203.0.113.7" },
    );
    expectCodeRedirect(res);

    // Distinct audit action for the silent path. Fire-and-forget emit —
    // poll briefly.
    const storage = ctx.storage;
    const reused = await waitForAudit(
      () => storage.audit.list({ action: "auth.grant.reused", limit: 10 }),
      (result) => result.data.length >= 1,
    );
    expect(reused.data.length).toBe(1);
    const row = reused.data[0]!;
    expect(row.resource_id).toBe(clientId);
    expect(row.resource_type).toBe("oauth_grant");
    expect(row.client_ip).toBe("203.0.113.7");
    const details = row.details;
    expect(details.client_id).toBe(clientId);
    expect(details.user_id).toBe(grantBefore.properties.user_id);
    expect(details.scopes).toEqual(["openid", "core.note:read"]);
    expect(details.grant_item_id).toBe(grantBefore.id);

    // No second auth.grant.created — the skip is a reuse, not a grant.
    const created = await storage.audit.list({
      action: "auth.grant.created",
      limit: 10,
    });
    expect(created.data.length).toBe(1);

    // The projected grant record is untouched: same version, same
    // granted_at, same scopes.
    const after = await ctx.storage.items.get(grantBefore.id);
    expect(after).not.toBeNull();
    expect(after!.version).toBe(grantBefore.version);
    expect(after!.properties.granted_at).toBe(
      grantBefore.properties.granted_at,
    );
    expect(after!.properties.scopes).toEqual(grantBefore.properties.scopes);
  });
});
