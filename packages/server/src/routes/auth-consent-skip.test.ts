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
 * **Header realism is load-bearing here.** The skip is an internal
 * cookie-bearing POST synthesized from a browser GET, and Better Auth
 * refuses a cookie-bearing POST it can't attribute to a trusted origin.
 * A top-level navigation sends no `Origin` at all, and the `Referer` it
 * does send belongs to whoever linked to the authorize endpoint — the
 * relying party, on the ordinary cross-site start. So every GET below
 * is issued the way a browser would issue it (no `Origin`, and a
 * `Referer` that varies by entry point) rather than with headers that
 * happen to make the dispatch pass. The first test in the file pins
 * that the origin check is actually running: Better Auth disables it
 * whenever it detects a test environment, and with it disabled every
 * other assertion here measures nothing.
 *
 * Coverage:
 *   - the origin check is live (guards everything below)
 *   - second authorize with the SAME scopes skips consent (302 + code,
 *     no HTML) from every entry point: no referer at all (magic link,
 *     `Referrer-Policy: no-referrer`), a relying-party referer (the
 *     ordinary cross-site start), and a same-origin referer (the
 *     post-password-sign-in return_to)
 *   - requested ⊂ prior (subset) skips; requested ⊃ prior renders
 *   - scope coverage is literal: a wildcard or parent-type grant does
 *     not cover a concrete or child scope
 *   - empty requested scope set is never "already granted"
 *   - a forged signature renders consent, never mints
 *   - another user's grant and another client's grant don't satisfy
 *     this request
 *   - prompt=consent always renders; prompt=none never renders, in any
 *     outcome (code / login_required / consent_required)
 *   - refusals (disabled client, unsatisfied prompt=login) emit no
 *     `auth.grant.reused`
 *   - a narrowing skip leaves the stored grant at the scopes the user
 *     approved
 *   - code-bearing and error-bearing redirects carry no-store
 *
 * These tests drive the REAL signed-query flow: GET /auth/oauth2/authorize
 * produces a plugin-signed query (via the consent/login redirect), the
 * decision POST performs a genuine first consent, and the second
 * authorize replays the signed query against /auth/authorize the way a
 * post-sign-in return_to does. Queries the plugin never produces itself
 * (prompt=none, prompt=login, empty scope) are minted locally with
 * better-auth's `makeSignature` against the fixed test auth secret.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { makeSignature } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import {
  createTestContext,
  createTestAccount,
  request,
  waitForAudit,
  waitForConsentLockDepth,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { __test_internals } from "./auth-consent.js";

// Every test here boots a server, signs a user up and in (two password
// hashes), and drives a full consent round trip before it asserts
// anything. That is a lot of real work to fit inside the default budget
// on a machine running the rest of the suite beside it, and an overrun
// reports as a timeout — a result that says nothing about the property
// the test exists to check.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Marfa's own origin under the default test config (`authBaseUrl`). */
const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";
const RESPONSE_PARAM_NAMES = new Set([
  "code",
  "error",
  "error_description",
  "iss",
  "state",
]);
const RESERVED_COLLISIONS =
  "state=fixed-state&code=fixed-code&error=fixed-error" +
  "&error_description=fixed-description&iss=https%3A%2F%2Fissuer.example";
/** Where a relying party sends the user from, on a cross-site start. */
const RP_REFERER = "https://rp.example.com/sign-in";

/** Mirrors the `authSecret` default in `createTestContext` — needed to
 *  mint locally signed queries the plugin's sig verification accepts. */
const TEST_AUTH_SECRET =
  "test-auth-secret-change-in-production-not-required-here";

function betterAuthSchema() {
  return import("../storage/sqlite/schema.js");
}

/** Seed an `auth_oauth_client` row directly (same shape the plugin's DCR
 *  endpoint would write). Public client, PKCE-bound. */
async function seedClient(
  c: TestContext,
  redirectUri: string | readonly string[] = CALLBACK,
): Promise<string> {
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  const clientPk = `pk_${Math.random().toString(36).slice(2, 10)}`;
  if (!c.storage.betterAuthDb) {
    throw new Error("seedClient: storage.betterAuthDb missing");
  }
  const schemaModule = await betterAuthSchema();
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
  // arrays.
  const registeredRedirectUris =
    typeof redirectUri === "string" ? [redirectUri] : [...redirectUri];
  const redirectUris: unknown = JSON.stringify(registeredRedirectUris);
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

/** Flip an existing client to `disabled` — the operator kill switch. */
async function disableClient(c: TestContext, clientId: string): Promise<void> {
  const schemaModule = await betterAuthSchema();
  const db = c.storage.betterAuthDb as {
    update: (table: unknown) => {
      set: (v: Record<string, unknown>) => {
        where: (cond: unknown) => {
          run?: () => Promise<unknown>;
          execute?: () => Promise<unknown>;
        };
      };
    };
  };
  const op = db
    .update(schemaModule.auth_oauth_client)
    .set({ disabled: true })
    .where(eq(schemaModule.auth_oauth_client.clientId, clientId));
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
}

/** Sign up + verify + sign in; returns the session cookie (`name=value`). */
async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  await createTestAccount(c, email, password, "Test User");
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
 * Land on the consent page the way a browser does: a top-level
 * navigation, which carries a session cookie but never an `Origin`.
 * `referer` is opt-in per entry point — omitted entirely for a magic
 * link or a `Referrer-Policy: no-referrer` client.
 */
function landOnConsentPage(
  c: TestContext,
  signedQuery: string,
  options?: { cookie?: string; referer?: string; peer?: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "text/html,application/xhtml+xml",
  };
  if (options?.cookie) headers.cookie = options.cookie;
  if (options?.referer) headers.referer = options.referer;
  return request(c.app, "GET", `/auth/authorize?${signedQuery}`, {
    headers,
    ...(options?.peer ? { peer: options.peer } : {}),
  });
}

/**
 * Run the full first-consent dance for `scopes` and return the signed
 * query it used (still valid for replay within the plugin's exp window):
 * plugin authorize → consent-page redirect → decision POST accept →
 * 302 back to the callback with a code.
 *
 * The decision POST carries an `Origin`, because a browser attaches one
 * to every form submission. The GET that precedes it does not.
 */
async function grantFirstConsent(
  c: TestContext,
  clientId: string,
  cookie: string,
  scope: string,
  scopes: string[],
  redirectUri = CALLBACK,
): Promise<string> {
  const authorizeRes = await beginAuthorize(c, clientId, scope, cookie, {
    redirect_uri: redirectUri,
  });
  expect(authorizeRes.status).toBe(302);
  const location = authorizeRes.headers.get("location") ?? "";
  expect(location).toContain("/auth/authorize?");
  const signedQuery = signedQueryOf(authorizeRes);

  const decisionRes = await request(c.app, "POST", "/auth/authorize/decision", {
    form: { accept: "true", oauth_query: signedQuery, scopes },
    headers: { cookie, origin: ORIGIN },
  });
  expect(decisionRes.status).toBe(302);
  const cbLocation = decisionRes.headers.get("location") ?? "";
  expectCallbackBase(cbLocation, redirectUri);
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
  const sig = await makeSignature(
    __test_internals.canonicalizeOAuthQueryParams(params).toString(),
    TEST_AUTH_SECRET,
  );
  params.append("sig", sig);
  return params.toString();
}

/** Base authorize params, for locally minted queries. */
function authorizeFields(
  clientId: string,
  scope: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope,
    state: "minted-state",
    code_challenge: "0123456789012345678901234567890123456789012",
    code_challenge_method: "S256",
    ...extra,
  };
}

function expectCallbackBase(location: string, registeredRedirectUri: string) {
  const actual = new URL(location);
  const registered = new URL(registeredRedirectUri);
  expect(actual.protocol).toBe(registered.protocol);
  expect(actual.username).toBe(registered.username);
  expect(actual.password).toBe(registered.password);
  expect(actual.host).toBe(registered.host);
  expect(actual.pathname).toBe(registered.pathname);
  expect(actual.hash).toBe(registered.hash);
  for (const [key, value] of registered.searchParams) {
    if (RESPONSE_PARAM_NAMES.has(key)) continue;
    expect(actual.searchParams.getAll(key)).toContain(value);
  }
}

function addedResponseValues(
  location: string,
  registeredRedirectUri: string,
  key: string,
): string[] {
  const actual = new URL(location);
  const registered = new URL(registeredRedirectUri);
  const fixedCounts = new Map<string, number>();
  for (const value of registered.searchParams.getAll(key)) {
    fixedCounts.set(value, (fixedCounts.get(value) ?? 0) + 1);
  }
  return actual.searchParams.getAll(key).filter((value) => {
    const remaining = fixedCounts.get(value) ?? 0;
    if (remaining === 0) return true;
    fixedCounts.set(value, remaining - 1);
    return false;
  });
}

function expectCodeRedirect(
  res: Response,
  registeredRedirectUri = CALLBACK,
): void {
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  expectCallbackBase(location, registeredRedirectUri);
  expect(
    addedResponseValues(location, registeredRedirectUri, "code"),
  ).not.toHaveLength(0);
  expect(
    addedResponseValues(location, registeredRedirectUri, "error"),
  ).toHaveLength(0);
}

function expectRendersConsent(res: Response, body: string): void {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("text/html");
  // A rendered page can never carry a code — the assertion that matters.
  expect(body).not.toContain("code=");
}

/** Cache-prevention headers, per `routes/no-store.ts`. */
function expectNoStore(res: Response): void {
  expect(res.headers.get("cache-control") ?? "").toContain("no-store");
  expect(res.headers.get("pragma")).toBe("no-cache");
}

async function countAudit(c: TestContext, action: string): Promise<number> {
  const rows = await c.storage.audit.list({ action, limit: 20 });
  return rows.data.length;
}

/** The user id on the single projected grant row. */
async function grantUserId(c: TestContext): Promise<string> {
  const items = await c.storage.items.list({
    type: "system.connection",
    state: "active",
  });
  expect(items.data.length).toBe(1);
  return items.data[0]!.properties.user_id as string;
}

// ---------------------------------------------------------------------------
// Harness guard
// ---------------------------------------------------------------------------

describe("GET /auth/authorize (consent skip) — harness", () => {
  it("GUARD: Better Auth's origin check is live, so the skip assertions below mean something", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "origin-guard@example.com");

    // A cookie-bearing POST with no Origin is exactly what a naive
    // internal dispatch from a top-level GET produces. Better Auth must
    // refuse it. If this ever returns anything else, the origin check
    // has been disabled (it switches itself off in test environments
    // unless configured) and every skip test in this file would pass
    // whether or not the route forwards a usable origin. The check is a
    // library-wide middleware, so any plugin endpoint the catch-all serves
    // shows it; the consent endpoint itself is fenced from the wire (see
    // `routes/oauth-plugin-fence.ts`) and answers 404 before the check.
    const res = await request(
      ctx.app,
      "POST",
      "/auth/oauth2/end-session/confirm",
      {
        // Form-encoded because that endpoint accepts nothing else, and the
        // media-type check runs ahead of the origin check.
        form: { oauth_query: "client_id=nope&sig=nope" },
        headers: { cookie },
      },
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Skip-when-already-granted
// ---------------------------------------------------------------------------

describe("GET /auth/authorize (consent skip)", () => {
  it("REGRESSION: second authorize with the same scopes skips consent — 302 straight to redirect_uri with a code, no HTML", async () => {
    ctx = await createTestContext({});
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
    const res = await landOnConsentPage(ctx, signedQuery, {
      cookie,
      referer: `${ORIGIN}/auth/sign-in`,
    });
    expectCodeRedirect(res);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it.each([
    ["fixed-query", `${CALLBACK}?channel=stable`],
    ["custom-scheme", "marfa-test://oauth/callback?channel=native"],
    [
      "reserved-query-collisions",
      `${CALLBACK}?channel=stable&${RESERVED_COLLISIONS}`,
    ],
    [
      "custom-scheme reserved-query-collisions",
      `marfa-test://oauth/callback?channel=native&${RESERVED_COLLISIONS}`,
    ],
  ] as const)(
    "classifies a code callback for a %s registered redirect URI",
    async (kind, redirectUri) => {
      ctx = await createTestContext({});
      const clientId = await seedClient(ctx, redirectUri);
      const fixtureKind = kind.replaceAll(" ", "-");
      const cookie = await signInUser(
        ctx,
        `skip-callback-${fixtureKind}@example.com`,
      );
      const scope = "openid core.note:read";

      const signedQuery = await grantFirstConsent(
        ctx,
        clientId,
        cookie,
        scope,
        ["openid", "core.note:read"],
        redirectUri,
      );
      const res = await landOnConsentPage(ctx, signedQuery, { cookie });

      expectCodeRedirect(res, redirectUri);
      const projected = await ctx.storage.items.list({
        type: "system.connection",
        state: "active",
      });
      expect(projected.data.length).toBe(1);
    },
  );

  it("does not match a callback when a non-reserved fixed query pair differs", () => {
    const registered = `${CALLBACK}?channel=stable&state=fixed-state&code=fixed-code`;
    const returned = `${CALLBACK}?channel=beta&state=response-state&code=issued-code`;

    expect(
      __test_internals.isRegisteredResponseRedirect([registered], returned),
    ).toBe(false);
  });

  it("REGRESSION: skips with no Referer at all (magic link, Referrer-Policy: no-referrer)", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-noreferer@example.com");
    const scope = "openid core.note:read";

    const signedQuery = await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    // No Origin (top-level navigation) and no Referer (the client sends
    // `Referrer-Policy: no-referrer`, or the user arrived from a magic
    // link). Nothing about the inbound request identifies a trusted
    // origin; the route has to supply one for its own internal hop.
    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectCodeRedirect(res);
  });

  it("REGRESSION: skips when the Referer is the relying party's own origin (the ordinary cross-site start)", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-rp-referer@example.com");
    const scope = "openid core.note:read";

    const signedQuery = await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    // The referer belongs to whoever linked here, which on a normal
    // OAuth start is the app, not Marfa. An untrusted referer must not
    // be what the internal dispatch is judged on.
    const res = await landOnConsentPage(ctx, signedQuery, {
      cookie,
      referer: RP_REFERER,
    });
    expectCodeRedirect(res);
  });

  it("stamps no-store on the code-bearing redirect", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-nostore@example.com");
    const scope = "openid core.note:read";

    const signedQuery = await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectCodeRedirect(res);
    // The Location carries a single-use authorization code.
    expectNoStore(res);
  });

  it("skips when the requested scopes are a subset of the prior grant", async () => {
    ctx = await createTestContext({});
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

    const res = await landOnConsentPage(ctx, subsetSignedQuery, { cookie });
    expectCodeRedirect(res);
  });

  it("renders the re-consent diff when the request widens the prior grant (superset)", async () => {
    ctx = await createTestContext({});
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

    const res = await landOnConsentPage(ctx, supersetSignedQuery, { cookie });
    const html = await res.text();
    expectRendersConsent(res, html);
    // Diff sections from the re-consent renderer.
    expect(html).toContain(">New</p>");
    expect(html).toContain("Already allowed");
  });

  it("prompt=consent forces a render even when the grant covers the request", async () => {
    ctx = await createTestContext({});
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

    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectRendersConsent(res, await res.text());
  });

  it("renders after the grant is revoked (revocation deletes the consent row)", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-revoked@example.com");
    const scope = "openid core.note:read";

    const signedQuery = await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    // Resolve the consenting user from the projection, then revoke the
    // grant the way /auth/grants/:id/revoke does.
    const authUserId = await grantUserId(ctx);
    await ctx.storage.oauthProvider!.revokeTokensForGrant(clientId, authUserId);

    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectRendersConsent(res, await res.text());
  });
});

// ---------------------------------------------------------------------------
// What "already granted" is NOT
// ---------------------------------------------------------------------------

/**
 * What the standing grant covers, which is not the same question as which
 * strings it contains.
 *
 * This block used to be titled "coverage is literal" and pinned the
 * opposite of the first case below, on the reasoning that the skip "must
 * not be the component that decides" what a wildcard implies. That was the
 * right instinct about ownership and the wrong conclusion: deciding by set
 * membership is still deciding, and it decided wrongly. The scope grammar
 * does answer the question — `typeMatchesPattern` is the platform's own
 * rule, and the middleware that admits a request already applies it — so
 * the skip now asks the grammar through one shared helper instead of
 * asking a `Set`.
 *
 * The cases below it are unchanged and are the reason the first is safe:
 * breadth means the wildcard, not the identifier. A grant on a parent type
 * reaches its children only when it says `.*`.
 */
describe("GET /auth/authorize (consent skip) — what the grant covers", () => {
  it("a wildcard grant covers a concrete scope beneath it", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-wildcard@example.com");

    // The user approved `core.*:read`. A later request naming one type under
    // it asks for strictly less than they already said yes to, and asking
    // again is the re-prompt this exists to stop.
    //
    // Worth being exact about which grants this reaches, because the obvious
    // claim is wrong. The shipped `read`, `write` and `connected` bundles
    // enumerate concrete per-type literals, so a release that registers a
    // platform type still moves the requested set and still prompts — that
    // half needs the bundles to express breadth, not this. What holds a
    // wildcard today is the `custom` bundle, whose own description promises
    // "ones you define later", and any client asking for `core.*` or `*`
    // directly. So this is the fix for runtime custom types, which is the
    // category that actually churns, and the prerequisite for the rest.
    await grantFirstConsent(ctx, clientId, cookie, "openid core.*:read", [
      "openid",
      "core.*:read",
    ]);

    const signedQuery = await mintSignedQuery(
      authorizeFields(clientId, "openid core.note:read"),
    );
    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectCodeRedirect(res);
  });

  /**
   * The escalation this whole comparison exists to prevent, end to end.
   *
   * The standing grant pairs a broad write with a narrower read, which is a
   * shape a client can ask for and a person can approve: write everything,
   * except only read what is under `core`. Dropping the narrower half from a
   * later request leaves every requested literal present in the stored set
   * verbatim — so a subset test, and a coverage test with a membership
   * shortcut in front of it, both say covered and skip the screen.
   *
   * Skipping is the escalation. The code is minted from the REQUEST, so the
   * token carries `*:write` with nothing holding it down, and the middleware
   * then permits a write the standing grant refused. Meanwhile the consent
   * record is restored to the wider standing set, so `/auth/security` goes on
   * showing a grant narrower than the live token.
   */
  it("a request that drops the narrower half of a grant is not covered by it", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-escalation@example.com");

    await grantFirstConsent(
      ctx,
      clientId,
      cookie,
      "openid *:write core.*:read",
      ["openid", "*:write", "core.*:read"],
    );

    const signedQuery = await mintSignedQuery(
      authorizeFields(clientId, "openid *:write"),
    );
    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectRendersConsent(res, await res.text());
  });

  it("a parent-type grant does not cover a child-type scope", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-parent-type@example.com");

    // `core.media` with no `.*` is one type, not a subtree. The wildcard is
    // what expresses breadth, and this is what keeps the case above from
    // being a general "prefix wins" rule.
    await grantFirstConsent(ctx, clientId, cookie, "openid core.media:read", [
      "openid",
      "core.media:read",
    ]);

    const signedQuery = await mintSignedQuery(
      authorizeFields(clientId, "openid core.media.book:read"),
    );
    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectRendersConsent(res, await res.text());
  });

  it("a child-type grant does not cover the parent-type scope", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-child-type@example.com");

    await grantFirstConsent(
      ctx,
      clientId,
      cookie,
      "openid core.media.book:read",
      ["openid", "core.media.book:read"],
    );

    const signedQuery = await mintSignedQuery(
      authorizeFields(clientId, "openid core.media:read"),
    );
    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectRendersConsent(res, await res.text());
  });

  it("an empty requested scope set is not 'already granted'", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-empty-scope@example.com");

    await grantFirstConsent(ctx, clientId, cookie, "openid core.note:read", [
      "openid",
      "core.note:read",
    ]);

    // Every element of the empty set is in the prior grant, vacuously.
    // The decision handler treats a zero-scope accept as a deny; the two
    // handlers must not disagree about whether asking for nothing is
    // something the server silently approves.
    const signedQuery = await mintSignedQuery(authorizeFields(clientId, ""));
    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectRendersConsent(res, await res.text());
    expect(await countAudit(ctx, "auth.grant.reused")).toBe(0);
  });

  it("a forged signature is refused outright, even with a covering grant", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-forged@example.com");
    const scope = "openid core.note:read";

    await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    const params = new URLSearchParams(authorizeFields(clientId, scope));
    params.set("exp", String(Math.floor(Date.now() / 1000) + 600));
    params.set("sig", "forged-not-a-real-signature");

    // Not minting is necessary but not enough: a consent screen rendered
    // from a request nobody signed is an attacker-composed page on the
    // real origin. The refusal page is fixed copy, so nothing from this
    // query reaches it.
    const res = await landOnConsentPage(ctx, params.toString(), { cookie });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("We could not verify this request");
    for (const fromTheQuery of [
      "Skip Test Client",
      "core.note:read",
      "minted-state",
      clientId,
    ]) {
      expect(body).not.toContain(fromTheQuery);
    }
    expect(body).not.toContain("oauth_query");
    expect(await countAudit(ctx, "auth.grant.reused")).toBe(0);
  });

  it("another user's grant does not satisfy this user's request", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const granterCookie = await signInUser(ctx, "skip-granter@example.com");
    const scope = "openid core.note:read";

    const signedQuery = await grantFirstConsent(
      ctx,
      clientId,
      granterCookie,
      scope,
      ["openid", "core.note:read"],
    );

    // A second user replays the first user's signed query. The consent
    // lookup is keyed on (client_id, user_id); the grant is not theirs.
    const otherCookie = await signInUser(ctx, "skip-other-user@example.com");
    const res = await landOnConsentPage(ctx, signedQuery, {
      cookie: otherCookie,
    });
    expectRendersConsent(res, await res.text());
    expect(await countAudit(ctx, "auth.grant.reused")).toBe(0);
  });

  it("a grant to one client does not satisfy another client's request", async () => {
    ctx = await createTestContext({});
    const grantedClient = await seedClient(ctx);
    const otherClient = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-other-client@example.com");
    const scope = "openid core.note:read";

    await grantFirstConsent(ctx, grantedClient, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    // Same user, same scopes, different client. Nothing has been granted
    // to this client.
    const signedQuery = await mintSignedQuery(
      authorizeFields(otherClient, scope),
    );
    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectRendersConsent(res, await res.text());
    expect(await countAudit(ctx, "auth.grant.reused")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// prompt=none — never renders, always answers the client
// ---------------------------------------------------------------------------

describe("GET /auth/authorize (consent skip) — prompt=none", () => {
  it("with a covering grant, silently mints a code even with no Origin and no Referer (hidden-iframe renewal)", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-none-grant@example.com");
    const scope = "openid core.note:read";

    await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    // The plugin never routes prompt=none to the consent page itself, so
    // mint a validly signed query to exercise the route's own handling of
    // a direct hit. A silent-renewal iframe sends no Origin and,
    // typically, no Referer — the shape that must still produce a code
    // rather than `consent_required`.
    const signedQuery = await mintSignedQuery(
      authorizeFields(clientId, scope, {
        state: "none-state",
        prompt: "none",
      }),
    );

    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectCodeRedirect(res);
    expect(
      new URL(res.headers.get("location") ?? "").searchParams.get("state"),
    ).toBe("none-state");
  });

  it("without a covering grant, redirects with error=consent_required and never renders", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-none-nogrant@example.com");

    const signedQuery = await mintSignedQuery(
      authorizeFields(clientId, "openid core.note:read", {
        state: "none-err-state",
        prompt: "none",
      }),
    );

    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(CALLBACK)).toBe(true);
    const url = new URL(location);
    expect(url.searchParams.get("error")).toBe("consent_required");
    expect(url.searchParams.get("state")).toBe("none-err-state");
    expect(url.searchParams.get("code")).toBeNull();
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    expectNoStore(res);
  });

  it.each([
    ["fixed-query", `${CALLBACK}?channel=stable`],
    ["custom-scheme", "marfa-test://oauth/callback?channel=native"],
    [
      "reserved-query-collisions",
      `${CALLBACK}?channel=stable&${RESERVED_COLLISIONS}`,
    ],
    [
      "custom-scheme reserved-query-collisions",
      `marfa-test://oauth/callback?channel=native&${RESERVED_COLLISIONS}`,
    ],
  ] as const)(
    "classifies a prompt=none provider error for a %s registered redirect URI",
    async (kind, redirectUri) => {
      ctx = await createTestContext({});
      const clientId = await seedClient(ctx, redirectUri);
      const cookie = await signInUser(
        ctx,
        `skip-none-callback-${kind.replaceAll(" ", "-")}@example.com`,
      );
      const scope = "openid core.note:read";
      await grantFirstConsent(
        ctx,
        clientId,
        cookie,
        scope,
        ["openid", "core.note:read"],
        redirectUri,
      );

      // The standing grant covers the request, so the route takes the
      // proxy path. An empty `code_challenge` makes the provider return
      // its own `invalid_request` callback. The method beside it still
      // has to name a real one: the provider validates the method
      // against its enum before anything reaches the OAuth error path,
      // and an empty method is refused as a malformed request instead of
      // being redirected to the client. That refusal tests nothing about
      // callback classification, because it produces no callback.
      // Correct classification must forward the error unchanged rather
      // than synthesizing the `interaction_required` fallback for
      // prompt=none.
      const signedQuery = await mintSignedQuery(
        authorizeFields(clientId, scope, {
          redirect_uri: redirectUri,
          state: `none-${kind}`,
          prompt: "none",
          code_challenge: "",
          code_challenge_method: "S256",
        }),
      );

      const res = await landOnConsentPage(ctx, signedQuery, { cookie });
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expectCallbackBase(location, redirectUri);
      const callback = new URL(location);
      expect(callback.searchParams.getAll("error")).toContain(
        "invalid_request",
      );
      expect(addedResponseValues(location, redirectUri, "error")).toContain(
        "invalid_request",
      );
      expect(callback.searchParams.getAll("state")).toContain(`none-${kind}`);
      expect(addedResponseValues(location, redirectUri, "code")).toHaveLength(
        0,
      );
      expectNoStore(res);
    },
  );

  it("uses the signed redirect URI when registered callbacks differ only by response fields", async () => {
    ctx = await createTestContext({});
    const firstRedirect = `${CALLBACK}?channel=stable&code=fixed-first`;
    const requestedRedirect = `${CALLBACK}?channel=stable&code=fixed-second`;
    const clientId = await seedClient(ctx, [firstRedirect, requestedRedirect]);
    const cookie = await signInUser(
      ctx,
      "skip-none-multiple-reserved-callbacks@example.com",
    );
    const scope = "openid core.note:read";
    await grantFirstConsent(
      ctx,
      clientId,
      cookie,
      scope,
      ["openid", "core.note:read"],
      requestedRedirect,
    );

    const signedQuery = await mintSignedQuery(
      authorizeFields(clientId, scope, {
        redirect_uri: requestedRedirect,
        prompt: "none",
        code_challenge: "",
        code_challenge_method: "S256",
      }),
    );
    const res = await landOnConsentPage(ctx, signedQuery, { cookie });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expectCallbackBase(location, requestedRedirect);
    expect(addedResponseValues(location, requestedRedirect, "error")).toContain(
      "invalid_request",
    );
    expect(
      addedResponseValues(location, requestedRedirect, "code"),
    ).toHaveLength(0);
    expect(await countAudit(ctx, "auth.grant.reused")).toBe(0);
    expectNoStore(res);
  });

  it("with no session, returns error=login_required to the client instead of rendering sign-in", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);

    // OIDC Core §3.1.2.6: prompt=none forbids ANY user-visible
    // interaction, and "not signed in" is answered with login_required,
    // not with the sign-in page the request explicitly ruled out.
    const signedQuery = await mintSignedQuery(
      authorizeFields(clientId, "openid core.note:read", {
        state: "none-nosession",
        prompt: "none",
      }),
    );

    const res = await landOnConsentPage(ctx, signedQuery);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(CALLBACK)).toBe(true);
    const url = new URL(location);
    expect(url.searchParams.get("error")).toBe("login_required");
    expect(url.searchParams.get("state")).toBe("none-nosession");
    expect(location).not.toContain("/auth/sign-in");
  });

  it("with a forged signature, 400s instead of echoing attacker-chosen state to the client", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-none-forged@example.com");

    // Any signed-in user's browser can be navigated here with a
    // registered client_id, that client's registered redirect_uri,
    // prompt=none and a state of the attacker's choosing. Without a
    // signature check the server would 302 to the client's callback
    // echoing that state.
    const params = new URLSearchParams(
      authorizeFields(clientId, "openid core.note:read", {
        state: "attacker-chosen",
        prompt: "none",
      }),
    );
    params.set("exp", String(Math.floor(Date.now() / 1000) + 600));
    params.set("sig", "forged-not-a-real-signature");

    const res = await landOnConsentPage(ctx, params.toString(), { cookie });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("with an unregistered redirect_uri, 400s instead of redirecting", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-none-baduri@example.com");

    const signedQuery = await mintSignedQuery({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example.com/steal",
      scope: "openid",
      prompt: "none",
    });

    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Audit + grant-record invariants
// ---------------------------------------------------------------------------

describe("GET /auth/authorize (consent skip) — audit and grant records", () => {
  it("emits auth.grant.reused on skip and leaves the projected grant untouched", async () => {
    ctx = await createTestContext({});
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

    const res = await landOnConsentPage(ctx, signedQuery, {
      cookie,
      peer: "203.0.113.7",
    });
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
    expect(await countAudit(ctx, "auth.grant.created")).toBe(1);

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

  it("a narrower request leaves the stored grant at the scopes the user approved", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-narrowing@example.com");

    await grantFirstConsent(
      ctx,
      clientId,
      cookie,
      "openid core.note:read core.note:write",
      ["openid", "core.note:read", "core.note:write"],
    );
    const authUserId = await grantUserId(ctx);

    const signedQuery = await mintSignedQuery(
      authorizeFields(clientId, "core.note:read"),
    );
    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    expectCodeRedirect(res);

    // The plugin rewrites the stored consent scopes to the requested set
    // on every accept. Nobody agreed to give anything up here: no
    // interaction happened, so the standing grant survives and the two
    // records of it still agree.
    const stored = await ctx.storage.oauthProvider!.getPriorConsent(
      clientId,
      authUserId,
    );
    expect([...(stored ?? [])].sort()).toEqual([
      "core.note:read",
      "core.note:write",
      "openid",
    ]);

    const projected = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(projected.data[0]!.properties.scopes).toEqual([
      "openid",
      "core.note:read",
      "core.note:write",
    ]);

    // And a later request for the full set still skips — the grant was
    // never actually narrowed.
    const fullQuery = await mintSignedQuery(
      authorizeFields(clientId, "openid core.note:read core.note:write"),
    );
    expectCodeRedirect(await landOnConsentPage(ctx, fullQuery, { cookie }));
  });

  it("a disabled client is refused without an auth.grant.reused row", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-disabled@example.com");
    const scope = "openid core.note:read";

    const signedQuery = await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);
    await disableClient(ctx, clientId);

    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    // However the refusal is shaped, it is not an authorization: no code
    // reaches the client and no reuse is recorded.
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("code=");
    expect(await countAudit(ctx, "auth.grant.reused")).toBe(0);
  });

  it("an unsatisfied prompt=login is refused without an auth.grant.reused row", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-prompt-login@example.com");
    const scope = "openid core.note:read";

    await grantFirstConsent(ctx, clientId, cookie, scope, [
      "openid",
      "core.note:read",
    ]);

    // prompt=login is satisfied only by a session created after the
    // query was signed. This session predates it, so the plugin bounces
    // to sign-in rather than minting.
    const signedQuery = await mintSignedQuery(
      authorizeFields(clientId, scope, { prompt: "login" }),
    );

    const res = await landOnConsentPage(ctx, signedQuery, { cookie });
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("code=");
    expect(await countAudit(ctx, "auth.grant.reused")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent grant changes
// ---------------------------------------------------------------------------
//
// The silent path reads the standing grant, lets the plugin narrow it,
// then writes the standing set back. Read and write straddle a whole
// proxy round trip, so anything the user does to the grant in between is
// racing a restoration computed before they did it. Both requests below
// are real, overlapping, in-flight HTTP requests through the app; only
// the interleaving is pinned, by holding the silent flow at the point
// where it has read the grant and not yet acted on it.

/** A promise plus its resolver, for pinning an interleaving. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Replace `getPriorConsent` with one that performs the real read and then
 * parks the first caller until the returned gate is opened. Returns the
 * unpatched reader so assertions can still see the stored state.
 *
 * The read the silent path makes runs inside the consent lock, so parking
 * on it holds the lock for as long as the gate stays shut. That is what
 * puts the competing request in the queue instead of letting it run to
 * completion, and it is the whole reason these two tests describe a race
 * rather than a sequence.
 */
function holdSilentFlowAfterReadingGrant(c: TestContext): {
  reachedRead: Promise<void>;
  resume: () => void;
  readStandingGrant: (
    clientId: string,
    authUserId: string,
  ) => Promise<readonly string[] | undefined>;
} {
  const store = c.storage.oauthProvider!;
  const readStandingGrant = store.getPriorConsent.bind(store);
  const reached = deferred();
  const gate = deferred();
  let parked = false;
  store.getPriorConsent = async (clientId, authUserId) => {
    const scopes = await readStandingGrant(clientId, authUserId);
    if (!parked) {
      parked = true;
      reached.resolve();
      await gate.promise;
    }
    return scopes;
  };
  return {
    reachedRead: reached.promise,
    resume: gate.resolve,
    readStandingGrant,
  };
}

describe("GET /auth/authorize (consent skip) — concurrent grant changes", () => {
  it("REGRESSION: a narrowing that lands mid-flight is not undone by the silent restoration", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c, "race-narrow@example.com");
    const wide = "openid core.note:read core.task:read";

    await grantFirstConsent(c, clientId, cookie, wide, [
      "openid",
      "core.note:read",
      "core.task:read",
    ]);
    const authUserId = await grantUserId(c);

    const { reachedRead, resume, readStandingGrant } =
      holdSilentFlowAfterReadingGrant(c);

    // A silent re-authorization for a subset of the standing grant.
    const silentQuery = await mintSignedQuery(
      authorizeFields(clientId, "openid"),
    );
    const silent = landOnConsentPage(c, silentQuery, { cookie });
    await reachedRead;

    // Meanwhile the user unticks core.task:read on the consent screen.
    const narrowQuery = await mintSignedQuery(authorizeFields(clientId, wide));
    const narrowing = request(c.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: narrowQuery,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: ORIGIN },
    });
    // The narrowing has to be queued behind the parked holder before the
    // holder is let go. Released early, the two run one after the other
    // and the restoration never has a decision to overwrite.
    await waitForConsentLockDepth(clientId, authUserId, 2);
    resume();

    const [silentRes, narrowRes] = await Promise.all([silent, narrowing]);
    expectCodeRedirect(silentRes);
    expect(narrowRes.status).toBe(302);

    // The permission the user took away must stay taken away. Whichever
    // way the two requests are ordered, a scope can only come back
    // through an interaction that asks for it.
    const stored = await readStandingGrant(clientId, authUserId);
    expect(stored).not.toContain("core.task:read");
    expect([...(stored ?? [])].sort()).toEqual(["core.note:read", "openid"]);
  });

  it("REGRESSION: a revocation that lands mid-flight is not resurrected by the silent restoration", async () => {
    ctx = await createTestContext({});
    const c = ctx;
    const clientId = await seedClient(c);
    const cookie = await signInUser(c, "race-revoke@example.com");
    const wide = "openid core.note:read core.task:read";

    await grantFirstConsent(c, clientId, cookie, wide, [
      "openid",
      "core.note:read",
      "core.task:read",
    ]);
    const grants = await c.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    const grantItemId = grants.data[0]!.id;
    const authUserId = grants.data[0]!.properties.user_id as string;

    const { reachedRead, resume, readStandingGrant } =
      holdSilentFlowAfterReadingGrant(c);

    const silentQuery = await mintSignedQuery(
      authorizeFields(clientId, "openid"),
    );
    const silent = landOnConsentPage(c, silentQuery, { cookie });
    await reachedRead;

    // Meanwhile the whole grant is revoked through the grants door.
    const revoke = request(c.app, "DELETE", `/auth/grants/${grantItemId}`, {
      key: c.workingKey,
    });
    // Same reason as the narrowing case: the revoke has to be waiting on
    // the lock, not arriving after the holder has already restored.
    await waitForConsentLockDepth(clientId, authUserId, 2);
    resume();

    const [, revokeRes] = await Promise.all([silent, revoke]);
    expect(revokeRes.status).toBe(204);

    // Revocation deletes the consent row. A restoration computed before
    // the revoke must not put a fully-scoped one back.
    expect(await readStandingGrant(clientId, authUserId)).toBeUndefined();
    const after = await c.storage.items.get(grantItemId);
    expect(after!.properties.status).toBe("revoked");
  });
});

// ---------------------------------------------------------------------------
// A literal named twice, on the path with no form
//
// The decision route deduplicates what a form posts, and the parse
// deduplicates what the screen renders. Neither covers this: the skip is a
// GET, there is no form, and the route proxies `scopeLiterals` straight to
// the plugin's `/oauth2/consent` and hands the same array to
// `projectGrantOnConsent` as `requestedScopes`. So the parse is the ONLY
// thing standing between a repeated literal and two storage writes carrying
// it — the plugin's own `auth_oauth_consent.scopes`, which it rewrites to the
// requested set on every accept, and `properties.scopes` on the projection.
//
// Found by mutation: removing the parse deduplication reddened nothing,
// because the other two sites masked it on every path the tests then
// covered. The fix was load-bearing and the tests were not.
// ---------------------------------------------------------------------------

describe("a scope named twice is stored once on the skip path", () => {
  it("writes one copy when a covered request repeats a literal", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx, "skip-dupe@example.com");

    // A WILDCARD first, which is what makes this reach Marfa's skip at all.
    // The plugin has its own already-consented check and it is exact
    // membership, so granting `core.note:read` and asking for it again is
    // answered one level up and never touches this route. A standing
    // `core.*:read` fails that membership test and passes
    // `grantCoversScope`, which is the documented difference between the two
    // skips.
    await grantFirstConsent(ctx, clientId, cookie, "openid core.*:read", [
      "openid",
      "core.*:read",
    ]);

    const second = await beginAuthorize(
      ctx,
      clientId,
      "openid core.note:read core.note:read",
      cookie,
    );
    expect(second.status).toBe(302);
    // The precondition, and it is the one this case got wrong first time:
    // the plugin must hand the request to the consent page rather than
    // answering it. A redirect straight to the callback means the plugin
    // skipped, this route never ran, and everything below would pass
    // proving nothing.
    expect(second.headers.get("location") ?? "").toContain("/auth/authorize?");

    const res = await landOnConsentPage(ctx, signedQueryOf(second), {
      cookie,
      referer: `${ORIGIN}/auth/sign-in`,
    });
    expectCodeRedirect(res);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");

    // **The projection is deliberately untouched on a skip** — no scope
    // rewrite, no `granted_at` bump — because nobody agreed to give anything
    // up, and the plugin's own consent row is restored to the standing set
    // afterwards. So the stored grant is not where a duplicate would land
    // here, and asserting on it would pass whatever the parse did.
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(1);
    expect(items.data[0]!.properties.scopes).toEqual(["openid", "core.*:read"]);

    // What the skip does record is the audit row, and `details.scopes` is
    // what the client asked for on this request — taken straight from the
    // parsed literals. That is the one surface on this path where a repeated
    // literal persists, and it is the operator's record of what was
    // re-authorized without anybody being asked.
    // **Polled, not read once.** `auditGrantReused` is dispatched with `void`
    // and deliberately so — a best-effort audit write must never block the
    // redirect. It usually lands before the response is even read, but a
    // bare read races it. `waitForAudit` is
    // the helper this file already uses for the same action a few cases up.
    const storage = ctx.storage;
    const reused = await waitForAudit(
      () => storage.audit.list({ action: "auth.grant.reused", limit: 20 }),
      (result) => result.data.length >= 1,
    );
    expect(reused.data.length).toBe(1);
    const asked = (reused.data[0]!.details as { scopes: string[] }).scopes;
    expect(asked).toEqual([...new Set(asked)]);
    expect(asked.filter((v) => v === "core.note:read")).toHaveLength(1);
  });
});
