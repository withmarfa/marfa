/**
 * Tests for the /auth/authorize consent route + the
 * /auth/authorize/decision proxy handler.
 *
 * Coverage:
 *   - GET /auth/authorize without a session redirects to /auth/sign-in
 *   - GET /auth/authorize 4xxs when the plugin's signed query (`sig`)
 *     or `client_id` is missing
 *   - POST /auth/authorize/decision without a session redirects to /auth/sign-in
 *   - POST decision reads client_id from oauth_query, not the form
 *   - POST decision accept=true with zero scopes → 302 to consent with error
 *   - auth.grant.created audit row carries client_ip
 *   - GET /authorize render carries Cache-Control: no-store
 *   - POST decision without session preserves oauth_query in return_to
 *   - GET /authorize renders 200 for clients with null client_name
 *     (DCR registration without client_name is RFC 7591-compliant)
 */
import { describe, it, expect, afterEach } from "vitest";
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

/**
 * Seed an `auth_oauth_client` row directly (the plugin's DCR endpoint
 * would write the same row). Optionally with `name: null` to exercise
 * the F12 fallback path.
 */
async function seedClient(
  c: TestContext,
  opts: {
    name?: string | null;
    /** When set, marks the client confidential (a verified client that
     *  authenticates with a secret). Omitted → the DCR/public default
     *  shape (`public: true`, `token_endpoint_auth_method: none`). */
    confidential?: boolean;
  } = {},
): Promise<string> {
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
  // PG has native `text[]` columns for the plugin's `string[]` fields
  // (see migration 0059); SQLite stays on `text` with JSON-serialized
  // arrays via the Better Auth adapter (`supportsArrays: false`).
  const redirectUris: unknown =
    c.storage.betterAuthDialect === "pg"
      ? ["http://localhost:0/callback"]
      : JSON.stringify(["http://localhost:0/callback"]);
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: clientPk,
    clientId,
    name: opts.name === undefined ? "Test Client" : opts.name,
    redirectUris,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: opts.confidential ? false : true,
    tokenEndpointAuthMethod: opts.confidential ? "client_secret_basic" : "none",
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

/**
 * Sign up + verify + sign in. Returns the better-auth session cookie
 * value (already in `name=value` form, ready to thread into a `Cookie`
 * header on subsequent requests).
 */
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
  // set-cookie can be multi-valued; the session cookie is the one whose
  // name contains `session_token` (better-auth convention).
  const cookies = setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/);
  for (const c of cookies) {
    const head = c.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("sign-in: session_token cookie not found in Set-Cookie");
}

/**
 * Build a plausible-looking oauth_query string. The plugin's sig won't
 * validate (we use "fake" as sig), so anything that proxies to
 * /auth/oauth2/consent will get a 4xx — that's fine for tests asserting
 * on the projection/audit side-effects, which run BEFORE the proxy.
 */
function buildOauthQuery(clientId: string, scope: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://localhost:0/callback",
    scope,
    state: "test-state",
    code_challenge: "test-challenge",
    code_challenge_method: "S256",
    exp: String(Math.floor(Date.now() / 1000) + 600),
    sig: "fake",
  });
  return params.toString();
}

// ---------------------------------------------------------------------------
// GET /auth/authorize
// ---------------------------------------------------------------------------

describe("GET /auth/authorize (consent page)", () => {
  it("redirects to /auth/sign-in when no session is present", async () => {
    ctx = await createTestContext();
    const res = await request(
      ctx.app,
      "GET",
      "/auth/authorize?response_type=code&client_id=client_x&redirect_uri=http%3A%2F%2Flocalhost%2F&scope=core.note%3Aread&state=s&code_challenge=c&code_challenge_method=S256&exp=1&sig=fake",
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/sign-in?return_to=");
  });

  it("400s when client_id or sig is missing", async () => {
    ctx = await createTestContext();
    // sig present, client_id missing
    const r1 = await request(
      ctx.app,
      "GET",
      "/auth/authorize?response_type=code&scope=core.note:read&sig=fake",
    );
    expect(r1.status).toBe(400);
    // client_id present, sig missing — would not have come from the plugin
    const r2 = await request(
      ctx.app,
      "GET",
      "/auth/authorize?response_type=code&client_id=client_x&scope=core.note:read",
    );
    expect(r2.status).toBe(400);
  });

  it("F9: sets Cache-Control: no-store on the rendered consent page", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f9@example.com");

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${buildOauthQuery(clientId, "openid")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("no-store");
    expect(cc).toContain("no-cache");
    expect(cc).toContain("private");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("F12: renders 200 for clients with null client_name (uses clientId as display)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx, { name: null });
    const cookie = await signInUser(ctx, "f12@example.com");

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${buildOauthQuery(clientId, "openid")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The page renders with clientId as the displayed name when name is null.
    expect(html).toContain(clientId);
  });

  it("flags a public/DCR client as unverified on the consent screen", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // Default seedClient shape is public (token_endpoint_auth_method: none).
    const clientId = await seedClient(ctx, { name: "Google Drive" });
    const cookie = await signInUser(ctx, "unverified-app@example.com");

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${buildOauthQuery(clientId, "openid")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="callout"');
    expect(html).toContain("Marfa hasn't verified this app");
  });

  it("does NOT flag a confidential client as unverified", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx, {
      name: "Vetted App",
      confidential: true,
    });
    const cookie = await signInUser(ctx, "verified-app@example.com");

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${buildOauthQuery(clientId, "openid")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('class="callout"');
    expect(html).not.toContain("Marfa hasn't verified");
  });

  it("404s when client genuinely does not exist", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // Don't seed the client.
    const cookie = await signInUser(ctx, "missing-client@example.com");
    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${buildOauthQuery("client_nonexistent_xxx", "openid")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });

  it("renders OIDC scopes as profile toggles plus hidden mechanism fields", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f11-oidc@example.com");

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${buildOauthQuery(clientId, "openid profile email offline_access")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Your profile");
    expect(html).toContain("<span>Your name</span>");
    expect(html).toContain("<span>Your email address</span>");
    // openid + offline_access are OAuth mechanisms, not data permissions —
    // they ride along as always-on hidden fields rather than toggles.
    expect(html).toMatch(
      /<input type="checkbox" name="scopes" value="openid" checked hidden>/,
    );
    expect(html).toMatch(
      /<input type="checkbox" name="scopes" value="offline_access" checked hidden>/,
    );
  });

  it("renders an edge scope as a per-type toggle carrying the concrete literal", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f11-edge@example.com");

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${buildOauthQuery(clientId, "edge.parent-of:read")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The concrete scope is the submittable checkbox value, rendered as a
    // labeled per-type toggle row (not a raw scope string).
    expect(html).toContain('value="edge.parent-of:read"');
    expect(html).toMatch(/<div class="subrow"><span>[^<]+<\/span>/);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/authorize/decision
// ---------------------------------------------------------------------------

describe("POST /auth/authorize/decision (consent decision proxy)", () => {
  it("redirects to /auth/sign-in when no session is present", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: "response_type=code&client_id=client_x&sig=fake",
        client_id: "client_x",
      },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/sign-in");
  });

  it("F10: session-expired redirect preserves oauth_query as return_to", async () => {
    ctx = await createTestContext();
    const oauthQuery =
      "response_type=code&client_id=client_x&scope=openid&sig=fake";
    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: "client_x",
      },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/sign-in?return_to=");
    // The return_to is URL-encoded; decode and check it points back at
    // /auth/authorize with the same oauth_query.
    const returnTo = decodeURIComponent(location.split("return_to=")[1] ?? "");
    expect(returnTo).toContain("/auth/authorize?");
    expect(returnTo).toContain("client_id=client_x");
    expect(returnTo).toContain("sig=fake");
  });

  it("F10: session-expired redirect falls back to bare /sign-in when oauth_query is missing", async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: { accept: "true", client_id: "client_x" },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("/auth/sign-in");
  });

  it("F2: accept=true with zero selected scopes redirects to consent with error (no projection)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f2@example.com");
    const oauthQuery = buildOauthQuery(clientId, "openid core.note:read");

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: { accept: "true", oauth_query: oauthQuery, client_id: clientId },
      headers: { cookie },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/auth/authorize?");
    expect(location).toContain("error=no_scopes_selected");

    // No projection should have been written — confirm via items list.
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(0);

    // No audit row either.
    const audits = await ctx.storage.audit.list({
      action: "auth.grant.created",
      limit: 10,
    });
    expect(audits.data.length).toBe(0);
  });

  it("F1+F7: projection uses client_id from oauth_query (NOT the form's client_id) + audit row carries client_ip", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const realClientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f1@example.com");

    // Hostile form: oauth_query (the signed source-of-truth) names the
    // REAL client, but the form's client_id field claims a different one.
    // The projection MUST follow oauth_query, not the form.
    const oauthQuery = buildOauthQuery(realClientId, "openid core.note:read");
    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: "ATTACKER_CONTROLLED_VALUE",
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie },
      peer: "203.0.113.42",
    });
    // The proxy to /auth/oauth2/consent fails (bogus sig) — but the
    // projection runs BEFORE the proxy. Expect a non-2xx but verify
    // the projection landed correctly.
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Projection should exist for the REAL client_id (from oauth_query),
    // not "ATTACKER_CONTROLLED_VALUE".
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    const grant = items.data[0];
    expect(grant?.properties.client_id).toBe(realClientId);
    expect(grant?.properties.client_id).not.toBe("ATTACKER_CONTROLLED_VALUE");

    // Audit row exists with the real client_id + the resolved client_ip.
    // Audit insert is fire-and-forget — poll briefly.
    const storage = ctx.storage;
    const audits = await waitForAudit(
      () =>
        storage.audit.list({
          action: "auth.grant.created",
          limit: 10,
        }),
      (result) => result.data.length >= 1,
    );
    expect(audits.data.length).toBe(1);
    const audit = audits.data[0];
    expect(audit?.resource_id).toBe(realClientId);
    expect(audit?.client_ip).toBe("203.0.113.42");
  });

  it("F3+F6: re-consent updates projection in place (no duplicate) + flips status to active + clears revoked_at + bumps version", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f3@example.com");
    const oauthQuery = buildOauthQuery(clientId, "openid core.note:read");

    // First consent — projection gets created in active state.
    const r1 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie },
    });
    // Proxy 400 expected (bogus sig); projection runs before proxy.
    expect(r1.status).toBeGreaterThanOrEqual(400);
    let items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    const grantId = items.data[0]!.id;
    const v1 = items.data[0]!.version;

    // Simulate the user revoking the grant via /security (sets status=revoked).
    const revokedUpdate = await ctx.storage.items.update(
      grantId,
      {
        properties: {
          ...items.data[0]!.properties,
          status: "revoked",
          revoked_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    expect("error" in revokedUpdate).toBe(false);
    const revoked = await ctx.storage.items.get(grantId);
    expect(revoked!.properties.status).toBe("revoked");
    expect(revoked!.properties.revoked_at).toBeDefined();

    // Re-consent — F3 should flip status back to "active" + drop revoked_at.
    const r2 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie },
    });
    expect(r2.status).toBeGreaterThanOrEqual(400);

    const after = await ctx.storage.items.get(grantId);
    expect(after).not.toBeNull();
    expect(after!.properties.status).toBe("active");
    expect(after!.properties.revoked_at).toBeUndefined();
    // F6 — items.update bumps version on each call.
    expect(after!.version).toBeGreaterThan(v1);

    // Single projection row — re-consent updated in place, didn't insert.
    items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
  });

  it("F4: re-consent with narrowed scopes revokes the grant's existing access tokens", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f4@example.com");

    const oauthQuery = buildOauthQuery(
      clientId,
      "openid core.note:read core.note:write core.task:read",
    );
    // First consent with wide scopes.
    const r1 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: [
          "openid",
          "core.note:read",
          "core.note:write",
          "core.task:read",
        ],
      },
      headers: { cookie },
    });
    expect(r1.status).toBeGreaterThanOrEqual(400);

    // Look up authUserId from the projection.
    const items1 = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items1.data.length).toBe(1);
    const authUserId = items1.data[0]!.properties.user_id as string;

    // Seed an access token row directly (simulates the token a real
    // /oauth2/token call would have minted at the wide scope).
    if (!ctx.storage.betterAuthDb) throw new Error("no betterAuthDb");
    const schemaModule =
      ctx.storage.betterAuthDialect === "pg"
        ? await import("../storage/pg/schema.js")
        : await import("../storage/sqlite/schema.js");
    const db = ctx.storage.betterAuthDb as unknown as {
      insert: (table: unknown) => {
        values: (v: Record<string, unknown>) => {
          run?: () => Promise<unknown>;
          execute?: () => Promise<unknown>;
        };
      };
    };
    const now = new Date();
    const tokenId = `at_${Math.random().toString(36).slice(2)}`;
    const tokenHash = `hash_${Math.random().toString(36).slice(2)}`;
    // PG: `scopes` is native `text[]`; SQLite: JSON-serialized text.
    // See migration 0059 + `auth_oauth_client.scopes` schema comment.
    const wideScopes = [
      "openid",
      "core.note:read",
      "core.note:write",
      "core.task:read",
    ];
    const op = db.insert(schemaModule.auth_oauth_access_token).values({
      id: tokenId,
      token: tokenHash,
      clientId,
      userId: authUserId,
      referenceId: null,
      expiresAt: new Date(now.getTime() + 3600_000),
      createdAt: now,
      scopes:
        ctx.storage.betterAuthDialect === "pg"
          ? wideScopes
          : JSON.stringify(wideScopes),
    });
    await (op.execute?.() ?? op.run?.() ?? Promise.resolve());

    // Verify the token exists (sanity).
    const beforeRow =
      await ctx.storage.oauthProvider?.validateAccessToken(tokenHash);
    expect(beforeRow).not.toBeNull();

    // Re-consent with narrowed scopes.
    const r2 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"], // narrowed
      },
      headers: { cookie },
    });
    expect(r2.status).toBeGreaterThanOrEqual(400);

    // F4 — the wider-scope access token must be revoked.
    const afterRow =
      await ctx.storage.oauthProvider?.validateAccessToken(tokenHash);
    expect(afterRow).toBeNull();
  });

  it("F4: re-consent with SAME scopes leaves access tokens alone (no narrowing → no revoke)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f4-same@example.com");

    const oauthQuery = buildOauthQuery(clientId, "openid core.note:read");
    const r1 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie },
    });
    expect(r1.status).toBeGreaterThanOrEqual(400);

    const items1 = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    const authUserId = items1.data[0]!.properties.user_id as string;

    if (!ctx.storage.betterAuthDb) throw new Error("no betterAuthDb");
    const schemaModule =
      ctx.storage.betterAuthDialect === "pg"
        ? await import("../storage/pg/schema.js")
        : await import("../storage/sqlite/schema.js");
    const db = ctx.storage.betterAuthDb as unknown as {
      insert: (table: unknown) => {
        values: (v: Record<string, unknown>) => {
          run?: () => Promise<unknown>;
          execute?: () => Promise<unknown>;
        };
      };
    };
    const tokenHash = `hash_${Math.random().toString(36).slice(2)}`;
    const sameScopes = ["openid", "core.note:read"];
    const op = db.insert(schemaModule.auth_oauth_access_token).values({
      id: `at_${Math.random().toString(36).slice(2)}`,
      token: tokenHash,
      clientId,
      userId: authUserId,
      referenceId: null,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      // PG: native `text[]`; SQLite: JSON-serialized text.
      scopes:
        ctx.storage.betterAuthDialect === "pg"
          ? sameScopes
          : JSON.stringify(sameScopes),
    });
    await (op.execute?.() ?? op.run?.() ?? Promise.resolve());

    // Re-consent with the SAME scope set.
    const r2 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie },
    });
    expect(r2.status).toBeGreaterThanOrEqual(400);

    // Token should survive — no narrowing happened.
    const after =
      await ctx.storage.oauthProvider?.validateAccessToken(tokenHash);
    expect(after).not.toBeNull();
  });

  it("F1: scopes outside the signed set are filtered (form can only narrow, not widen)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f1-scope@example.com");
    const oauthQuery = buildOauthQuery(clientId, "openid core.note:read");

    // Form claims to approve a scope NOT in the signed set. It must
    // be dropped before projection.
    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read", "core.note:write"], // last one is unsigned
      },
      headers: { cookie },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    const projectedScopes = items.data[0]?.properties.scopes as
      | string[]
      | undefined;
    expect(projectedScopes).toEqual(["openid", "core.note:read"]);
    expect(projectedScopes).not.toContain("core.note:write");
  });
});

// ---------------------------------------------------------------------------
// POST /auth/authorize/decision — Origin/Referer CSRF guard
//
// Defense-in-depth: an independent check beneath SameSite=Lax + the
// downstream better-auth Origin check. A *present, non-allowlisted* origin
// is rejected with 403 BEFORE any projection runs; an allowlisted origin
// (authBaseUrl or a CORS_ORIGINS entry) or an absent origin proceeds.
// ---------------------------------------------------------------------------

describe("POST /auth/authorize/decision (Origin/Referer CSRF guard)", () => {
  it("rejects a cross-origin POST (non-allowlisted Origin) with 403, before any projection", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "csrf-origin@example.com");
    const oauthQuery = buildOauthQuery(clientId, "openid core.note:read");

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);

    // The guard runs before the projection — no grant row written.
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(0);
  });

  it("rejects a cross-origin POST inferred from Referer (no Origin header) with 403", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "csrf-referer@example.com");
    const oauthQuery = buildOauthQuery(clientId, "openid core.note:read");

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, referer: "https://evil.example.com/attack" },
    });
    expect(res.status).toBe(403);

    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(0);
  });

  it("allows a same-origin POST (Origin = authBaseUrl) through to the proxy", async () => {
    // Default test config: authBaseUrl = http://localhost:0, corsOrigins = [].
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "csrf-same@example.com");
    const oauthQuery = buildOauthQuery(clientId, "openid core.note:read");

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: ORIGIN },
    });
    // Passes the guard, reaches the proxy, which 4xxs on the bogus sig —
    // but the projection (which runs before the proxy) lands, proving the
    // request was NOT rejected by the Origin guard.
    expect(res.status).not.toBe(403);
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
  });

  it("allows a same-origin POST whose Origin is a CORS_ORIGINS entry", async () => {
    const allowedOrigin = "https://app.example.com";
    ctx = await createTestContext({
      authAllowSignup: true,
      corsOrigins: [allowedOrigin],
    });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "csrf-cors@example.com");
    const oauthQuery = buildOauthQuery(clientId, "openid core.note:read");

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: allowedOrigin },
    });
    expect(res.status).not.toBe(403);
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
  });

  it("passes a POST with no Origin or Referer to the proxy hop, where Better Auth refuses it", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "csrf-absent@example.com");
    const oauthQuery = buildOauthQuery(clientId, "openid core.note:read");

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie },
    });

    // This handler's own guard rejects only a *present, non-allowlisted*
    // origin, so the request gets through it — the projection landing
    // proves that. Better Auth is the layer that refuses an origin-less
    // cookie-bearing POST, and this handler deliberately forwards the
    // request's own headers so it can. (The consent-skip path is the
    // exception: a top-level navigation has no origin to forward, so it
    // stamps the issuer's own. See `routes/forward-headers.ts`.)
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    expect(res.status).toBe(403);
  });
});
