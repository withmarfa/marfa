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
import { makeSignature } from "better-auth/crypto";
import {
  createTestContext,
  markEmailVerified,
  request,
  waitForAudit,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { __test_internals } from "./auth-consent.js";
import { setActivePermissionBundles } from "../config.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGIN = "http://localhost:0";
const TEST_AUTH_SECRET =
  "test-auth-secret-change-in-production-not-required-here";

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
  const schemaModule = await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const now = new Date();
  // The plugin's `string[]` fields are `text` columns holding JSON-serialized
  // arrays via the Better Auth adapter (`supportsArrays: false`).
  const redirectUris: unknown = JSON.stringify(["http://localhost:0/callback"]);
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
 * Build a plausible-looking authorize query carrying a signature the
 * plugin never produced. For the tests that mean to send one; every
 * render test uses `buildSignedOauthQuery`, because a page rendered from
 * an unsigned query is the defect, not the fixture.
 */
function buildForgedOauthQuery(clientId: string, scope: string): string {
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

/**
 * Assert the refusal page an authorize request gets when its signature
 * doesn't verify.
 *
 * What it says matters less than what it doesn't. On the forged path
 * every value in the query is the attacker's to choose, so the test that
 * catches a regression to rendering consent is the one that pins their
 * absence: no client name, no scope list, no `state`, no form to submit.
 */
async function expectRefusedAuthorizePage(
  res: Response,
  fromTheQuery: readonly string[],
  // A signature we did not make and a request that timed out are different
  // events and now say so. Callers that forge a query assert the former.
  expected: "expired" | "unverifiable" = "unverifiable",
): Promise<void> {
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain(
    expected === "expired"
      ? "This request has expired"
      : "We could not verify this request",
  );
  for (const value of fromTheQuery) expect(body).not.toContain(value);
  expect(body).not.toContain("oauth_query");
  expect(body).not.toContain("code=");
}

/** Build a signed oauth_query accepted by both Marfa and the provider. */
async function buildSignedOauthQuery(
  clientId: string,
  scope: string,
  extra?: Record<string, string>,
): Promise<string> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://localhost:0/callback",
    scope,
    state: "test-state",
    code_challenge: "0123456789012345678901234567890123456789012",
    code_challenge_method: "S256",
    ...extra,
  });
  params.set("exp", extra?.exp ?? String(Math.floor(Date.now() / 1000) + 600));
  params.set("ba_iat", extra?.ba_iat ?? String(Date.now()));
  params.set(
    "sig",
    await makeSignature(
      __test_internals.canonicalizeOAuthQueryParams(params).toString(),
      TEST_AUTH_SECRET,
    ),
  );
  return params.toString();
}

/** Reverse `escapeHtml` for a value read back out of a rendered form. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function seedAccessToken(
  c: TestContext,
  clientId: string,
  authUserId: string,
  scopes: string[],
): Promise<string> {
  if (!c.storage.betterAuthDb) throw new Error("no betterAuthDb");
  const schemaModule = await import("../storage/sqlite/schema.js");
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const tokenHash = `hash_${Math.random().toString(36).slice(2)}`;
  const op = db.insert(schemaModule.auth_oauth_access_token).values({
    id: `at_${Math.random().toString(36).slice(2)}`,
    token: tokenHash,
    clientId,
    userId: authUserId,
    referenceId: null,
    expiresAt: new Date(Date.now() + 3600_000),
    createdAt: new Date(),
    scopes: JSON.stringify(scopes),
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return tokenHash;
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
      `/auth/authorize?${await buildSignedOauthQuery("client_x", "core.note:read")}`,
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

  it("REGRESSION: refuses to render for a query the plugin never signed", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // An attacker picks the client and the scope list; the page they get
    // back is served by the real issuer on the real origin, with the real
    // chrome. Rejecting the submit later does not undo that: the page is
    // the payload.
    const clientId = await seedClient(ctx, { name: "Marfa Drive" });
    const cookie = await signInUser(ctx, "forged-render@example.com");

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${buildForgedOauthQuery(clientId, "openid core.note:read")}`,
      { headers: { cookie } },
    );

    await expectRefusedAuthorizePage(res, [
      "Marfa Drive",
      "core.note:read",
      "test-state",
      clientId,
    ]);
  });

  it("REGRESSION: refuses to render a genuinely signed query past its exp", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "expired-render@example.com");
    const oauthQuery = await buildSignedOauthQuery(clientId, "openid", {
      exp: String(Math.floor(Date.now() / 1000) - 1),
    });

    const res = await request(ctx.app, "GET", `/auth/authorize?${oauthQuery}`, {
      headers: { cookie },
    });

    // A genuinely signed request past its exp is refused like a forged
    // one, and says so in its own words: this one really did time out,
    // which is the ordinary case and the one the copy is written for.
    // Either way there is nothing to render a consent screen for and the
    // user's only move is to start again at the app.
    await expectRefusedAuthorizePage(
      res,
      ["Test Client", "test-state"],
      "expired",
    );
  });

  it("REGRESSION: refuses a forged query before bouncing an anonymous visitor to sign-in", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx, { name: "Marfa Drive" });

    // No session. The sign-in bounce is reached from the same forged URL,
    // so it is the same phishing surface one hop earlier — the credential
    // prompt is the more valuable half.
    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${buildForgedOauthQuery(clientId, "openid")}`,
    );

    expect(res.status).toBe(400);
  });

  it("F9: sets Cache-Control: no-store on the rendered consent page", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f9@example.com");

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "openid")}`,
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
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "openid")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The page renders with clientId as the displayed name when name is null.
    expect(html).toContain(clientId);
  });

  it("enumerates the space's custom types under a requested user.* wildcard", async () => {
    // Hosted mode: the enumeration resolves the consenting user's space
    // through the `users` store, which only hosted-mode sign-up provisions.
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const clientId = await seedClient(ctx, { name: "Custom Types App" });

    // Sign up capturing the auth user id, so the space the enumeration
    // reads from is resolvable — the shared signInUser helper discards it.
    const email = "custom-types@example.com";
    const password = "correct horse battery";
    const signUpRes = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: { email, password, name: "Test User" },
      headers: { origin: ORIGIN },
    });
    expect(signUpRes.status).toBe(200);
    const authUserId = ((await signUpRes.json()) as { user?: { id?: string } })
      .user?.id;
    await markEmailVerified(ctx.storage, email);
    const signInRes = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: { email, password },
      headers: { origin: ORIGIN },
    });
    expect(signInRes.status).toBe(200);
    const setCookie = signInRes.headers.get("set-cookie") ?? "";
    const cookie = setCookie
      .split(/,\s*(?=[a-zA-Z0-9_-]+=)/)
      .map((c) => c.split(";")[0])
      .find((head) => head?.includes("session_token"));
    expect(cookie).toBeTruthy();

    const userRow = await ctx.storage.users?.getByAuthUserId(authUserId ?? "");
    const spaceId = userRow?.space_id;
    expect(spaceId).toBeTruthy();
    await ctx.storage.types.create(
      {
        id: "user.recipe",
        version: 1,
        label: "Recipes",
        fields: { title: { type: "string", required: true } },
      },
      spaceId ?? undefined,
    );

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "user.*:read openid")}`,
      { headers: { cookie: cookie ?? "" } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The wildcard is what the grant carries; the screen has to say what
    // it matches today, and that later types are covered without a re-ask.
    expect(html).toContain('value="user.*:read"');
    expect(html).toContain("Today this covers Recipes");
    expect(html).toContain("plus any you add later");
  });

  it("offers a space's own handle namespace through the custom bundle, never a sibling's", async () => {
    // Hosted-mode registrations never land in the space-less custom-types
    // bucket, so a derivation reading that bucket leaves a space's
    // registered types out of the custom tile entirely and the coverage
    // collapses back to `user.*`.
    // The registration goes through the real hosted path (`POST /types`
    // under the caller's claimed handle), and the sibling space's
    // registration proves the derivation never crosses the space fence.
    ctx = await createTestContext({
      authMode: "hosted",
      authAllowSignup: true,
    });
    const clientId = await seedClient(ctx, { name: "Handle Types App" });

    const email = "handle-types@example.com";
    const password = "correct horse battery";
    const signUpRes = await request(ctx.app, "POST", "/auth/sign-up/email", {
      body: { email, password, name: "Test User" },
      headers: { origin: ORIGIN },
    });
    expect(signUpRes.status).toBe(200);
    const authUserId = ((await signUpRes.json()) as { user?: { id?: string } })
      .user?.id;
    await markEmailVerified(ctx.storage, email);
    const signInRes = await request(ctx.app, "POST", "/auth/sign-in/email", {
      body: { email, password },
      headers: { origin: ORIGIN },
    });
    expect(signInRes.status).toBe(200);
    const cookie = (signInRes.headers.get("set-cookie") ?? "")
      .split(/,\s*(?=[a-zA-Z0-9_-]+=)/)
      .map((c) => c.split(";")[0])
      .find((head) => head?.includes("session_token"));
    expect(cookie).toBeTruthy();

    const userRow = await ctx.storage.users?.getByAuthUserId(authUserId ?? "");
    expect(userRow).toBeTruthy();
    const spaceId = userRow?.space_id;
    expect(spaceId).toBeTruthy();
    await ctx.storage.users?.setHandle(userRow?.id ?? "", "acme");

    // Register through the API, exercising the handle-ownership gate the
    // way a real space would.
    const rawKey = "marfa_k1_test_handle_offer";
    await ctx.storage.keys.create(
      {
        label: "handle-offer",
        source: "test",
        type_permissions: { "*": "write" },
        metadata_permissions: { types: "write" },
      },
      hashApiKey(rawKey, TEST_API_KEY_SALT),
      spaceId ?? undefined,
    );
    const registerRes = await request(ctx.app, "POST", "/types", {
      key: rawKey,
      body: {
        id: "acme.gadget",
        version: 1,
        label: "Gadgets",
        fields: { name: { type: "string", required: true } },
      },
    });
    expect(registerRes.status).toBe(201);

    // A sibling space's registration, which must stay invisible here.
    const sibling = await ctx.storage.spaces!.create("sibling-space");
    await ctx.storage.types.create(
      {
        id: "rivalco.thing",
        version: 1,
        fields: { name: { type: "string", required: true } },
      },
      sibling.id,
    );

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "acme.*:read rivalco.*:read openid")}`,
      { headers: { cookie: cookie ?? "" } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();

    // The space's own root groups under the custom bundle tile.
    const customTileStart = html.indexOf("Things with your own custom types");
    expect(customTileStart).toBeGreaterThan(-1);
    const customTile = html.slice(
      customTileStart,
      html.indexOf("</details>", customTileStart),
    );
    expect(customTile).toContain('value="acme.*:read"');
    expect(customTile).toContain("Today this covers Gadgets");
    // The sibling's root renders as an ungrouped fallback row — grantable
    // if the space ever holds such types, but never presented as the
    // consenting space's own.
    expect(customTile).not.toContain("rivalco");
    expect(html).toContain('value="rivalco.*:read"');
  });

  it("flags a public/DCR client as unverified on the consent screen", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    // Default seedClient shape is public (token_endpoint_auth_method: none).
    const clientId = await seedClient(ctx, { name: "Google Drive" });
    const cookie = await signInUser(ctx, "unverified-app@example.com");

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "openid")}`,
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
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "openid")}`,
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
      `/auth/authorize?${await buildSignedOauthQuery("client_nonexistent_xxx", "openid")}`,
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
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "openid profile email offline_access")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Your profile");
    expect(html).toContain("<span>Your name and picture</span>");
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
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "edge.parent-of:read")}`,
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
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: { accept: "true", oauth_query: oauthQuery, client_id: clientId },
      headers: { cookie, origin: ORIGIN },
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

  it("REGRESSION: the zero-scope bounce keeps the signed query intact, so the retry works", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "zero-scope-retry@example.com");
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

    const bounced = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: { accept: "true", oauth_query: oauthQuery },
      headers: { cookie, origin: ORIGIN },
    });
    expect(bounced.status).toBe(302);
    const location = bounced.headers.get("location") ?? "";

    // Follow the bounce the way the browser does, and read back the
    // query the form will actually resubmit.
    const page = await request(ctx.app, "GET", location, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("at least one permission");
    const match = /name="oauth_query" value="([^"]*)"/.exec(html);
    expect(match).not.toBeNull();
    const resubmitted = decodeHtmlEntities(match![1]!);

    // The user ticks a box and submits. The recovery redirect must not
    // have edited the query the plugin signed — every retry after a
    // zero-scope slip dies on signature verification if it did.
    const retry = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: { accept: "true", oauth_query: resubmitted, scopes: ["openid"] },
      headers: { cookie, origin: ORIGIN },
    });
    expect(retry.status).toBe(302);
    expect(retry.headers.get("location") ?? "").toContain("code=");
  });

  it.each(["forged", "expired"] as const)(
    "%s oauth_query causes no projection, audit, or token-revocation side effects",
    async (failureMode) => {
      ctx = await createTestContext({ authAllowSignup: true });
      const clientId = await seedClient(ctx);
      const cookie = await signInUser(
        ctx,
        `invalid-query-${failureMode}@example.com`,
      );
      const wideScopes = ["openid", "core.note:read", "core.note:write"];

      const firstQuery = await buildSignedOauthQuery(
        clientId,
        wideScopes.join(" "),
      );
      const first = await request(ctx.app, "POST", "/auth/authorize/decision", {
        form: {
          accept: "true",
          oauth_query: firstQuery,
          scopes: wideScopes,
        },
        headers: { cookie, origin: ORIGIN },
      });
      expect(first.status).toBe(302);

      const beforeItems = await ctx.storage.items.list({
        type: "system.connection",
        state: "active",
      });
      expect(beforeItems.data.length).toBe(1);
      const grantBefore = beforeItems.data[0]!;
      const authUserId = grantBefore.properties.user_id as string;
      const tokenHash = await seedAccessToken(
        ctx,
        clientId,
        authUserId,
        wideScopes,
      );
      const storage = ctx.storage;
      await waitForAudit(
        () => storage.audit.list({ action: "auth.grant.created", limit: 10 }),
        (result) => result.data.length === 1,
      );

      let invalidQuery: string;
      if (failureMode === "expired") {
        invalidQuery = await buildSignedOauthQuery(
          clientId,
          "openid core.note:read",
          { exp: String(Math.floor(Date.now() / 1000) - 60) },
        );
      } else {
        const params = new URLSearchParams(
          await buildSignedOauthQuery(clientId, "openid core.note:read"),
        );
        params.set("state", "tampered-after-signing");
        invalidQuery = params.toString();
      }

      const invalid = await request(
        ctx.app,
        "POST",
        "/auth/authorize/decision",
        {
          form: {
            accept: "true",
            oauth_query: invalidQuery,
            scopes: ["openid", "core.note:read"],
          },
          headers: { cookie, origin: ORIGIN },
        },
      );
      expect(invalid.status).toBe(400);
      // A form submit from a browser, so it gets the themed page rather
      // than a developer's sentence, and the page names which check
      // failed: the tampered query never timed out, and saying it had
      // would send an honest user looking for a clock problem.
      expect(await invalid.text()).toContain(
        failureMode === "expired"
          ? "This request has expired"
          : "We could not verify this request",
      );

      const grantAfter = await ctx.storage.items.get(grantBefore.id);
      expect(grantAfter?.version).toBe(grantBefore.version);
      expect(grantAfter?.properties.scopes).toEqual(wideScopes);
      expect(
        await ctx.storage.oauthProvider?.validateAccessToken(tokenHash),
      ).not.toBeNull();
      const audits = await ctx.storage.audit.list({
        action: "auth.grant.created",
        limit: 10,
      });
      expect(audits.data.length).toBe(1);
    },
  );

  it("stamps Cache-Control: no-store on the redirect it hands back, accepted or refused", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "decision-no-store@example.com");

    // The accepted decision is the primary code-bearing redirect on the
    // whole auth surface: its `Location` carries a single-use
    // authorization code, which is exactly what `withNoStore` documents
    // itself as existing for.
    const accepted = await request(
      ctx.app,
      "POST",
      "/auth/authorize/decision",
      {
        form: {
          accept: "true",
          oauth_query: await buildSignedOauthQuery(clientId, "openid"),
          scopes: ["openid"],
        },
        headers: { cookie, origin: ORIGIN },
      },
    );
    expect(accepted.status).toBe(302);
    expect(
      new URL(accepted.headers.get("location") ?? "").searchParams.get("code"),
    ).toBeTruthy();
    expect(accepted.headers.get("cache-control") ?? "").toContain("no-store");
    expect(accepted.headers.get("pragma")).toBe("no-cache");

    // The refused one carries no code, and is stamped for the same reason
    // every other auth response is. Stamping one exit and not the other
    // is how the exception gets missed.
    const denied = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "false",
        oauth_query: await buildSignedOauthQuery(clientId, "openid"),
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(denied.headers.get("cache-control") ?? "").toContain("no-store");
    expect(denied.headers.get("pragma")).toBe("no-cache");
  });

  it("F1+F7: projection uses client_id from oauth_query (NOT the form's client_id) + audit row carries client_ip", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const realClientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f1@example.com");

    // Hostile form: oauth_query (the signed source-of-truth) names the
    // REAL client, but the form's client_id field claims a different one.
    // The projection MUST follow oauth_query, not the form.
    const oauthQuery = await buildSignedOauthQuery(
      realClientId,
      "openid core.note:read",
    );
    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: "ATTACKER_CONTROLLED_VALUE",
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: ORIGIN },
      peer: "203.0.113.42",
    });
    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location") ?? "").searchParams.get("code"),
    ).toBeTruthy();

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
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

    // First consent — projection gets created in active state.
    const r1 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(r1.status).toBe(302);
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
      headers: { cookie, origin: ORIGIN },
    });
    expect(r2.status).toBe(302);

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

    const oauthQuery = await buildSignedOauthQuery(
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
      headers: { cookie, origin: ORIGIN },
    });
    expect(r1.status).toBe(302);

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
    const schemaModule = await import("../storage/sqlite/schema.js");
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
    // `scopes` is JSON-serialized text; see the `auth_oauth_client.scopes`
    // schema comment.
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
      scopes: JSON.stringify(wideScopes),
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
      headers: { cookie, origin: ORIGIN },
    });
    expect(r2.status).toBe(302);

    // F4 — the wider-scope access token must be revoked.
    const afterRow =
      await ctx.storage.oauthProvider?.validateAccessToken(tokenHash);
    expect(afterRow).toBeNull();
  });

  it("REGRESSION: a narrowing whose token revocation fails does not report success", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "revoke-fails@example.com");
    const wide = ["openid", "core.note:read", "core.note:write"];
    const oauthQuery = await buildSignedOauthQuery(clientId, wide.join(" "));

    const first = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: { accept: "true", oauth_query: oauthQuery, scopes: wide },
      headers: { cookie, origin: ORIGIN },
    });
    expect(first.status).toBe(302);

    const granted = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(granted.data.length).toBe(1);
    const grantItem = granted.data[0]!;
    const authUserId = grantItem.properties.user_id as string;
    const tokenHash = await seedAccessToken(ctx, clientId, authUserId, wide);

    // The revocation the narrowing depends on cannot be performed.
    const store = ctx.storage.oauthProvider!;
    store.revokeAccessTokensForGrant = () =>
      Promise.reject(new Error("token store unavailable"));

    const narrowed = await request(
      ctx.app,
      "POST",
      "/auth/authorize/decision",
      {
        form: {
          accept: "true",
          oauth_query: oauthQuery,
          scopes: ["openid", "core.note:read"],
        },
        headers: { cookie, origin: ORIGIN },
      },
    );

    // Handing back the code-bearing redirect tells the user the narrowing
    // took effect. It did not: the wider-scope token is still live.
    expect(narrowed.headers.get("location") ?? "").not.toContain("code=");
    expect(narrowed.status).toBeGreaterThanOrEqual(500);

    // The token that carries the scopes the user just removed still works,
    // which is exactly why the request must not be reported as successful.
    expect(await store.validateAccessToken(tokenHash)).not.toBeNull();

    // And the record still says what is actually true — the wider grant.
    const after = await ctx.storage.items.get(grantItem.id);
    expect(after!.properties.scopes).toEqual(wide);
  });

  it("F4: re-consent with SAME scopes leaves access tokens alone (no narrowing → no revoke)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f4-same@example.com");

    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );
    const r1 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(r1.status).toBe(302);

    const items1 = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    const authUserId = items1.data[0]!.properties.user_id as string;

    if (!ctx.storage.betterAuthDb) throw new Error("no betterAuthDb");
    const schemaModule = await import("../storage/sqlite/schema.js");
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
      // JSON-serialized text.
      scopes: JSON.stringify(sameScopes),
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
      headers: { cookie, origin: ORIGIN },
    });
    expect(r2.status).toBe(302);

    // Token should survive — no narrowing happened.
    const after =
      await ctx.storage.oauthProvider?.validateAccessToken(tokenHash);
    expect(after).not.toBeNull();
  });

  /**
   * The destructive half of comparing scopes as text.
   *
   * A narrowing is a promise: the access the user took away stops working,
   * so the client's live tokens are revoked. Reading a WIDENING as a
   * narrowing keeps that promise about access nobody gave up — a user who
   * upgrades an app from "your notes" to "all your content" has every one
   * of that app's tokens revoked as the reward.
   *
   * There was no test for this direction, which is why it survived. The two
   * F4 cases beside it cover a real narrowing and an unchanged set, and both
   * pass either way.
   */
  it("F4: re-consent that widens a grant leaves access tokens alone", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f4-widen@example.com");

    const narrowQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );
    const r1 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: narrowQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(r1.status).toBe(302);

    const items1 = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    const authUserId = items1.data[0]!.properties.user_id as string;

    if (!ctx.storage.betterAuthDb) throw new Error("no betterAuthDb");
    const schemaModule = await import("../storage/sqlite/schema.js");
    const db = ctx.storage.betterAuthDb as unknown as {
      insert: (table: unknown) => {
        values: (v: Record<string, unknown>) => {
          run?: () => Promise<unknown>;
          execute?: () => Promise<unknown>;
        };
      };
    };
    const tokenHash = `hash_${Math.random().toString(36).slice(2)}`;
    const heldScopes = ["openid", "core.note:read"];
    const op = db.insert(schemaModule.auth_oauth_access_token).values({
      id: `at_${Math.random().toString(36).slice(2)}`,
      token: tokenHash,
      clientId,
      userId: authUserId,
      referenceId: null,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      scopes: JSON.stringify(heldScopes),
    });
    await (op.execute?.() ?? op.run?.() ?? Promise.resolve());

    // The token has to be live before the widening, or `not.toBeNull()`
    // after it proves nothing: a dialect branch that silently failed to
    // insert would leave this test green either way.
    const before =
      await ctx.storage.oauthProvider?.validateAccessToken(tokenHash);
    expect(before).not.toBeNull();
    expect(before).toBeDefined();

    // Re-consent to a STRICTLY WIDER set. The form can only narrow against
    // the signed query, so the widening arrives by the client asking for
    // more in a freshly signed request — which is what an app does when a
    // release adds a feature.
    const wideQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.*:read",
    );
    const r2 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: wideQuery,
        client_id: clientId,
        scopes: ["openid", "core.*:read"],
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(r2.status).toBe(302);

    // `core.*:read` covers `core.note:read`, so nothing was given up and
    // the token that carries it is still good.
    const after =
      await ctx.storage.oauthProvider?.validateAccessToken(tokenHash);
    expect(after).not.toBeNull();
    expect(after).toBeDefined();
  });

  it("F1: scopes outside the signed set are filtered (form can only narrow, not widen)", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "f1-scope@example.com");
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

    // Form claims to approve a scope NOT in the signed set. It must
    // be dropped before projection.
    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read", "core.note:write"], // last one is unsigned
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(302);

    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    const projectedScopes = items.data[0]?.properties.scopes as
      string[] | undefined;
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
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

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
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

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
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(302);
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
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: allowedOrigin },
    });
    expect(res.status).toBe(302);
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
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

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
    // origin, so the request reaches Better Auth. Better Auth refuses the
    // origin-less cookie-bearing POST, and that refusal must leave no grant
    // projection behind. (The consent-skip GET path is the exception: a
    // top-level navigation has no origin to forward, so it stamps the
    // issuer's own. See `routes/forward-headers.ts`.)
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(0);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// default_on, end to end
//
// The renderer tests prove an off-by-default bundle renders unticked and the
// decision handler's tests prove only the submitted scopes are granted.
// Neither proves the composition, and the composition is the claim: that an
// untouched Continue produces a GRANT without those scopes. This drives the
// handler with what the renderer actually emitted rather than a hand-written
// form, so a renderer change that quietly re-ticks the group fails here too.
// ---------------------------------------------------------------------------

describe("an off-by-default bundle grants nothing without a tick", () => {
  /** What an untouched form submits: every checked `name="scopes"` input. */
  const untouchedSubmission = (html: string): string[] => {
    const out: string[] = [];
    for (const tag of html.match(/<input[^>]*name="scopes"[^>]*>/g) ?? []) {
      if (!/\schecked(\s|>)/.test(tag)) continue;
      const value = /value="([^"]*)"/.exec(tag)?.[1];
      if (value !== undefined) out.push(value);
    }
    return out;
  };

  const BUNDLES = [
    {
      id: "read",
      label: "Read your content",
      description: "",
      scopes: ["core.note:read"],
      default_on: true,
    },
    {
      id: "manage",
      label: "Manage your space",
      description: "",
      scopes: ["core.task:write"],
      default_on: false,
    },
  ];

  it("keeps the unticked bundle's scopes off the projected grant", async () => {
    ctx = await createTestContext({ authAllowSignup: true });
    setActivePermissionBundles(BUNDLES);
    try {
      const clientId = await seedClient(ctx);
      const cookie = await signInUser(ctx, "default-on@example.com");
      const requested = "openid core.note:read core.task:write";
      const oauthQuery = await buildSignedOauthQuery(clientId, requested);

      // Render exactly what the person is shown, then submit exactly what
      // their browser would send if they pressed Continue and touched
      // nothing.
      const page = await request(
        ctx.app,
        "GET",
        `/auth/authorize?${oauthQuery}`,
        { headers: { cookie, origin: ORIGIN } },
      );
      expect(page.status).toBe(200);
      const submitted = untouchedSubmission(await page.text());
      expect(submitted).toContain("core.note:read");
      expect(submitted).not.toContain("core.task:write");

      const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
        form: { accept: "true", oauth_query: oauthQuery, scopes: submitted },
        headers: { cookie, origin: ORIGIN },
      });
      expect(res.status).toBe(302);

      const items = await ctx.storage.items.list({
        type: "system.connection",
        state: "active",
      });
      expect(items.data.length).toBe(1);
      const granted = items.data[0]!.properties.scopes as string[];
      expect(granted).toContain("core.note:read");
      // The whole point: the scope reached the screen, was never ticked, and
      // is absent from the grant the token is built from.
      expect(granted).not.toContain("core.task:write");
    } finally {
      setActivePermissionBundles(null);
    }
  });

  it("does not drop an already-granted scope when the user returns", async () => {
    // The revocation half, and the consequence this change leads with.
    //
    // On a second visit the diff's "Already allowed" tile is collapsed and
    // sits below "New", so an off-by-default scope rendered unticked there
    // is a choice nobody sees. The decision route reads the resulting
    // submission as a narrowing, and a narrowing is treated as a promise
    // that the removed access stops working, so it revokes the client's live
    // tokens. An untouched Continue killed a working integration, and a
    // space permission granted once would evaporate at the next re-consent.
    //
    // First consent ticks the off bundle by hand; the return visit touches
    // nothing. The grant has to survive it.
    ctx = await createTestContext({ authAllowSignup: true });
    setActivePermissionBundles(BUNDLES);
    try {
      const clientId = await seedClient(ctx);
      const cookie = await signInUser(ctx, "reconsent@example.com");
      const requested = "openid core.note:read core.task:write";

      const firstQuery = await buildSignedOauthQuery(clientId, requested);
      const first = await request(ctx.app, "POST", "/auth/authorize/decision", {
        form: {
          accept: "true",
          oauth_query: firstQuery,
          // The user reaches for the off-by-default bundle and ticks it.
          scopes: ["openid", "core.note:read", "core.task:write"],
        },
        headers: { cookie, origin: ORIGIN },
      });
      expect(first.status).toBe(302);

      // Second visit, asking for one more thing. A request the prior grant
      // already covers is approved silently with no screen, so widening is
      // what renders the diff — and it is the ordinary case: the app wants
      // something new and the old grant rides along in "Already allowed".
      const widened = `${requested} core.bookmark:read`;
      const secondQuery = await buildSignedOauthQuery(clientId, widened);
      const page = await request(
        ctx.app,
        "GET",
        `/auth/authorize?${secondQuery}`,
        { headers: { cookie, origin: ORIGIN } },
      );
      expect(page.status).toBe(200);
      const submitted = untouchedSubmission(await page.text());
      expect(submitted).toContain("core.task:write");

      const second = await request(
        ctx.app,
        "POST",
        "/auth/authorize/decision",
        {
          form: {
            accept: "true",
            oauth_query: secondQuery,
            scopes: submitted,
          },
          headers: { cookie, origin: ORIGIN },
        },
      );
      expect(second.status).toBe(302);

      const items = await ctx.storage.items.list({
        type: "system.connection",
        state: "active",
      });
      expect(items.data.length).toBe(1);
      const granted = items.data[0]!.properties.scopes as string[];
      expect(granted).toContain("core.note:read");
      expect(granted).toContain("core.task:write");
    } finally {
      setActivePermissionBundles(null);
    }
  });
});

// ---------------------------------------------------------------------------
// A literal named twice
//
// The rendering half is in `consent-operation.test.ts`, against the renderer.
// This is the half that made this more than a tidy-up: the
// duplicate did not stop at the screen. `formScopes` kept both copies,
// `projectGrantOnConsent` wrote them verbatim into `properties.scopes` on the
// `system.connection` item, and every surface that later reads or diffs that
// list inherited the duplicate.
// ---------------------------------------------------------------------------

describe("a scope named twice is stored once", () => {
  it("writes one copy when the request names the literal twice", async () => {
    ctx = await createTestContext();
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "dupe-request@example.com");
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "core.note:read core.note:read core.task:read",
    );

    // The precondition, and it is the rendering fix stated end to end: the
    // screen a person is actually served emits one checkbox for the repeated
    // literal, so an honest browser cannot submit it twice.
    const page = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${oauthQuery}`,
      {
        headers: { cookie, origin: ORIGIN },
      },
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    const noteInputs = (html.match(/value="core\.note:read"/g) ?? []).length;
    expect(noteInputs).toBe(1);

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        scopes: ["core.note:read", "core.task:read"],
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(302);

    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    const granted = items.data[0]!.properties.scopes as string[];
    expect(granted).toEqual(["core.note:read", "core.task:read"]);
  });

  it("writes one copy when the form posts the literal twice", async () => {
    // The second source, and the reason deduplicating at the parse is not
    // enough on its own. A form is client-controlled: `getAll` returns
    // whatever was posted, and `signedScopes` is a `Set`, so both copies of
    // a hand-crafted duplicate pass the membership test regardless of what
    // the screen rendered.
    ctx = await createTestContext();
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "dupe-form@example.com");
    const oauthQuery = await buildSignedOauthQuery(clientId, "core.note:read");

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        scopes: ["core.note:read", "core.note:read"],
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(302);

    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    expect(items.data[0]!.properties.scopes).toEqual(["core.note:read"]);
  });
});
