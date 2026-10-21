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
 *   - POST decision accept=true with nothing selected → denied, like Cancel
 *   - auth.grant.created audit row carries client_ip
 *   - GET /authorize render carries Cache-Control: no-store
 *   - POST decision without session preserves oauth_query in return_to
 *   - GET /authorize renders 200 for clients with null client_name
 *     (DCR registration without client_name is RFC 7591-compliant)
 */
import { makeSignature } from "better-auth/crypto";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { setActivePermissionBundles } from "../config.js";
import { itemWrites } from "../storage/item-writes.js";
import type { TestContext } from "../test-utils.js";
import { createTestContext, request, seedOauthBearer } from "../test-utils.js";
import { __test_internals } from "./auth-consent.js";
import { defaultSubmission, readControls, visibleText } from "../test-html.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
  setActivePermissionBundles(null);
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
    /** When set, the client authenticates with a secret. Omitted, it is
     *  public (`token_endpoint_auth_method: none`). */
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
async function signInUser(c: TestContext): Promise<string> {
  const { email, password } = c.owner;
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
  it("requires approval when an exact type request becomes a subtree request", async () => {
    setActivePermissionBundles([
      {
        id: "subtree",
        label: "Note subtypes",
        description: "",
        default_on: true,
        scopes: ["core.note.*:read"],
      },
    ]);
    ctx = await createTestContext({});
    const app = await seedOauthBearer(ctx, ["core.note:read"]);
    const verifier = randomBytes(32).toString("base64url");
    const extra = {
      redirect_uri: "http://localhost:5173/callback",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    };
    const exact = await buildSignedOauthQuery(
      app.clientId,
      "core.note:read",
      extra,
    );
    const alreadyApproved = await ctx.ownerRequest(`/auth/authorize?${exact}`);
    expect(alreadyApproved.status).toBe(302);
    expect(
      new URL(alreadyApproved.headers.get("location")!).searchParams.has(
        "code",
      ),
    ).toBe(true);

    const subtree = await buildSignedOauthQuery(
      app.clientId,
      "core.note.*:read",
      extra,
    );
    const screen = await ctx.ownerRequest(`/auth/authorize?${subtree}`);
    expect(screen.status).toBe(200);
    expect(screen.headers.get("location")).toBeNull();
    expect(await screen.text()).toContain('value="core.note.*:read"');
    const approved = await request(
      ctx.app,
      "POST",
      "/auth/authorize/decision",
      {
        headers: { cookie: ctx.owner.cookie, origin: ORIGIN },
        form: {
          accept: "true",
          oauth_query: subtree,
          scopes: ["core.note.*:read"],
        },
      },
    );
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get("location")!).searchParams.get(
      "code",
    );
    expect(code).not.toBeNull();
    const token = await request(ctx.app, "POST", "/auth/oauth2/token", {
      headers: { origin: ORIGIN },
      form: {
        grant_type: "authorization_code",
        client_id: app.clientId,
        code: code!,
        redirect_uri: extra.redirect_uri,
        code_verifier: verifier,
      },
    });
    expect(token.status).toBe(200);
    expect(((await token.json()) as { scope: string }).scope).toBe(
      "core.note.*:read",
    );
  });
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
    ctx = await createTestContext({});
    // An attacker picks the client and the scope list; the page they get
    // back is served by the real issuer on the real origin, with the real
    // chrome. Rejecting the submit later does not undo that: the page is
    // the payload.
    const clientId = await seedClient(ctx, { name: "Marfa Drive" });
    const cookie = await signInUser(ctx);

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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
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

  it("tells a link whose exp was edited into the past that it is invalid, not that it expired", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
    // Signed while its window was open, then edited so the window reads as
    // closed. Its signature no longer matches what it carries.
    const genuine = new URLSearchParams(
      await buildSignedOauthQuery(clientId, "openid"),
    );
    genuine.set("exp", String(Math.floor(Date.now() / 1000) - 60));

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${genuine.toString()}`,
      { headers: { cookie } },
    );

    await expectRefusedAuthorizePage(res, ["Test Client", "test-state"]);
  });

  it("tells a signed link edited after signing that it is invalid, whether or not its window has closed", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
    for (const exp of [
      String(Math.floor(Date.now() / 1000) + 600),
      String(Math.floor(Date.now() / 1000) - 60),
    ]) {
      const genuine = new URLSearchParams(
        await buildSignedOauthQuery(clientId, "openid", { exp }),
      );
      genuine.set("scope", "openid core.note:write");
      const res = await request(
        ctx.app,
        "GET",
        `/auth/authorize?${genuine.toString()}`,
        { headers: { cookie } },
      );
      await expectRefusedAuthorizePage(res, ["core.note:write"]);
    }
  });

  it("REGRESSION: refuses a forged query before bouncing an anonymous visitor to sign-in", async () => {
    ctx = await createTestContext({});
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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);

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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, { name: null });
    const cookie = await signInUser(ctx);

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

  it("enumerates the registered custom types under a requested user.* wildcard", async () => {
    // The enumeration resolves the consenting user through the `users`
    // store, which only sign-up provisions.
    ctx = await createTestContext(
      {},
      {
        email: "custom-types@example.com",
        password: "correct horse battery",
        name: "Test User",
      },
    );
    const clientId = await seedClient(ctx, { name: "Custom Types App" });

    // Sign up capturing the auth user id, so the account the enumeration
    // reads for is resolvable — the shared signInUser helper discards it.
    const email = "custom-types@example.com";
    const password = "correct horse battery";

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

    await ctx.storage.types.create({
      id: "user.recipe",
      version: 1,
      label: "Recipes",
      fields: { title: { type: "string", required: true } },
    });

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

  it("flags an app that sends no secret as unverified on the consent screen", async () => {
    ctx = await createTestContext({});
    // Default seedClient shape is public (token_endpoint_auth_method: none).
    const clientId = await seedClient(ctx, { name: "Google Drive" });
    const cookie = await signInUser(ctx);

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "openid")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(visibleText(html)).toContain(
      "Marfa can't confirm who made this app. Only approve apps you trust.",
    );
  });

  it("flags an app that authenticates with a secret as unverified too", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx, {
      name: "Secret App",
      confidential: true,
    });
    const cookie = await signInUser(ctx);

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "openid")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(visibleText(html)).toContain("Secret App");
    expect(visibleText(html)).toContain(
      "Marfa can't confirm who made this app. Only approve apps you trust.",
    );
  });

  it("404s when client genuinely does not exist", async () => {
    ctx = await createTestContext({});
    // Don't seed the client.
    const cookie = await signInUser(ctx);
    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${await buildSignedOauthQuery("client_nonexistent_xxx", "openid")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });

  it("renders OIDC scopes as profile toggles plus hidden mechanism fields", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "openid profile email offline_access")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const text = visibleText(html);
    expect(text).toContain("Your profile");
    expect(text).toContain("Your name and picture");
    expect(text).toContain("Your email address");
    // openid + offline_access are OAuth mechanisms, not data permissions:
    // they ride along as hidden fields, and the two claims are switches.
    const controls = readControls(html);
    expect(
      controls
        .filter((c) => c.name === "scopes" && c.type === "hidden")
        .map((c) => c.value),
    ).toEqual(["openid", "offline_access"]);
    expect(
      controls.filter((c) => c.role === "switch").map((c) => c.value),
    ).toEqual(["profile", "email"]);
  });

  it("renders an edge scope as a per-type toggle carrying the concrete literal", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);

    const res = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${await buildSignedOauthQuery(clientId, "edge.parent-of:read")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The concrete scope is the value a choice submits, offered as a
    // labeled level on one row, not as a raw scope string.
    const control = readControls(html).find((c) => c.tag === "select");
    expect(control?.options.map((o) => o.value)).toEqual([
      "",
      "edge.parent-of:read",
    ]);
    expect(control?.label).toMatch(/\S/);
    expect(visibleText(html)).not.toContain("edge.parent-of");
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

  it("F2: approving with nothing selected is denied as Cancel is, with no projection", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: { accept: "true", oauth_query: oauthQuery, client_id: clientId },
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "http://localhost:0/callback",
    );
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("test-state");
    expect(location.searchParams.get("code")).toBeNull();

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

  it("answers nothing selected exactly as it answers Cancel", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );
    const answer = async (form: Record<string, string | string[]>) => {
      const res = await request(ctx!.app, "POST", "/auth/authorize/decision", {
        form: { oauth_query: oauthQuery, ...form },
        headers: { cookie, origin: ORIGIN },
      });
      return [res.status, res.headers.get("location")];
    };
    const denied = await answer({ accept: "false" });
    expect(await answer({ accept: "true" })).toEqual(denied);
    // Nothing but the mechanisms is nothing: they grant no access.
    expect(await answer({ accept: "true", scopes: ["openid"] })).toEqual(
      denied,
    );
    expect(await answer({ accept: "true", scopes: ["", ""] })).toEqual(denied);
    // The witness: the same request, approved with something, is a code.
    expect(
      (await answer({ accept: "true", scopes: ["core.note:read"] }))[1],
    ).toContain("code=");
  });

  describe("an app that already holds access", () => {
    /** The decision a person's post makes on the screen for `scope`. */
    async function postDecision(
      c: TestContext,
      cookie: string,
      clientId: string,
      scope: string,
      scopes: string[],
    ): Promise<{ location: URL; query: string }> {
      const query = await buildSignedOauthQuery(clientId, scope);
      const res = await request(c.app, "POST", "/auth/authorize/decision", {
        form: {
          accept: "true",
          oauth_query: query,
          client_id: clientId,
          scopes,
        },
        headers: { cookie, origin: ORIGIN },
      });
      expect(res.status).toBe(302);
      return { location: new URL(res.headers.get("location") ?? ""), query };
    }

    const grantedScopes = async (c: TestContext): Promise<string[]> => {
      const grants = await c.storage.items.list({
        type: "system.connection",
        state: "active",
      });
      return (grants.data[0]?.properties.scopes as string[] | undefined) ?? [];
    };

    it("denies an approval with everything newly asked turned off, as Cancel is answered, and keeps what it holds", async () => {
      ctx = await createTestContext({});
      const clientId = await seedClient(ctx);
      const cookie = await signInUser(ctx);
      const held = await postDecision(
        ctx,
        cookie,
        clientId,
        "openid core.note:read",
        ["openid", "core.note:read"],
      );
      expect(held.location.searchParams.get("code")).toBeTruthy();

      // The screen for the second request, with Tasks set to No access: what
      // the app holds is carried, and nothing newly asked is on.
      const asked = "openid core.note:read core.task:read";
      const screen = await request(
        ctx.app,
        "GET",
        `/auth/authorize?${await buildSignedOauthQuery(clientId, asked)}`,
        { headers: { cookie } },
      );
      expect(screen.status).toBe(200);
      const posted = defaultSubmission(await screen.text(), "scopes").filter(
        (v) => v !== "core.task:read",
      );
      expect(posted).toEqual(["openid"]);
      const audits = (
        await ctx.storage.audit.list({
          action: "auth.grant.created",
          limit: 10,
        })
      ).data.length;

      const denied = await postDecision(ctx, cookie, clientId, asked, posted);
      expect(denied.location.searchParams.get("error")).toBe("access_denied");
      expect(denied.location.searchParams.get("code")).toBeNull();
      expect(await grantedScopes(ctx)).toEqual(["openid", "core.note:read"]);
      expect(
        (
          await ctx.storage.audit.list({
            action: "auth.grant.created",
            limit: 10,
          })
        ).data.length,
      ).toBe(audits);

      // The witness: the same screen with Tasks left on is a code.
      const approved = await postDecision(ctx, cookie, clientId, asked, [
        ...posted,
        "core.task:read",
      ]);
      expect(approved.location.searchParams.get("code")).toBeTruthy();
      expect((await grantedScopes(ctx)).sort()).toEqual([
        "core.note:read",
        "core.task:read",
        "openid",
      ]);
    });

    describe("a screen left open while the app's access changes", () => {
      const held = "openid core.note:write keys.mint";
      const asked = `${held} core.task:read`;

      /** The app approved for `held`, and the screen for `asked` open in a tab. */
      async function openAskingAgain() {
        ctx = await createTestContext({});
        const clientId = await seedClient(ctx);
        const cookie = await signInUser(ctx);
        const first = await postDecision(
          ctx,
          cookie,
          clientId,
          held,
          held.split(" "),
        );
        expect(first.location.searchParams.get("code")).toBeTruthy();
        const screen = await request(
          ctx.app,
          "GET",
          `/auth/authorize?${await buildSignedOauthQuery(clientId, asked)}`,
          { headers: { cookie } },
        );
        expect(screen.status).toBe(200);
        return {
          clientId,
          cookie,
          posted: defaultSubmission(await screen.text(), "scopes"),
        };
      }

      /** The app disconnected from another tab. */
      async function disconnect(c: TestContext): Promise<void> {
        const grants = await c.storage.items.list({
          type: "system.connection",
          state: "active",
        });
        const res = await request(
          c.app,
          "DELETE",
          `/auth/grants/${grants.data[0]?.id ?? ""}`,
          { key: c.workingKey },
        );
        expect(res.status).toBe(204);
        expect(await standing(c)).toEqual([]);
      }

      /** What the app holds now: nothing once it is disconnected. */
      async function standing(c: TestContext): Promise<string[]> {
        const grant = (
          await c.storage.items.list({ type: "system.connection" })
        ).data[0];
        return grant && grant.properties.status !== "revoked"
          ? ((grant.properties.scopes as string[] | undefined) ?? [])
          : [];
      }

      it("posts the choices and the mechanisms and not the access the app holds", async () => {
        const { posted } = await openAskingAgain();
        expect(posted.sort()).toEqual(["core.task:read", "openid"]);
      });

      it("keeps the access the app still holds when it is approved", async () => {
        const { clientId, cookie, posted } = await openAskingAgain();
        const approved = await postDecision(
          ctx!,
          cookie,
          clientId,
          asked,
          posted,
        );
        expect(approved.location.searchParams.get("code")).toBeTruthy();
        expect((await grantedScopes(ctx!)).sort()).toEqual(
          ["core.note:write", "core.task:read", "keys.mint", "openid"].sort(),
        );
      });

      it("gives back nothing the person ended, and nothing at all where nothing new is chosen", async () => {
        const { clientId, cookie, posted } = await openAskingAgain();
        await disconnect(ctx!);

        const denied = await postDecision(
          ctx!,
          cookie,
          clientId,
          asked,
          posted.filter((v) => v !== "core.task:read"),
        );
        expect(denied.location.searchParams.get("error")).toBe("access_denied");
        expect(denied.location.searchParams.get("code")).toBeNull();
        expect(await standing(ctx!)).toEqual([]);

        // The witness: the tasks they did choose are all they get. The notes
        // and key making they held come back with no control shown.
        const approved = await postDecision(
          ctx!,
          cookie,
          clientId,
          asked,
          posted,
        );
        expect(approved.location.searchParams.get("code")).toBeTruthy();
        expect((await standing(ctx!)).sort()).toEqual([
          "core.task:read",
          "openid",
        ]);
      });
    });

    it("denies an approval that turns off every power it is newly asked for, though it holds another", async () => {
      ctx = await createTestContext({});
      const clientId = await seedClient(ctx);
      const cookie = await signInUser(ctx);
      await postDecision(ctx, cookie, clientId, "openid keys.mint", [
        "openid",
        "keys.mint",
      ]);
      const asked = "openid keys.mint webhooks.manage";
      const denied = await postDecision(ctx, cookie, clientId, asked, [
        "openid",
        "keys.mint",
      ]);
      expect(denied.location.searchParams.get("error")).toBe("access_denied");
      const approved = await postDecision(ctx, cookie, clientId, asked, [
        "openid",
        "keys.mint",
        "webhooks.manage",
      ]);
      expect(approved.location.searchParams.get("code")).toBeTruthy();
    });

    it.each([
      [
        "names that level's read",
        "openid core.note:read core.note:write",
        "core.note:read",
      ],
      ["names only the write", "openid core.note:write", ""],
    ])(
      "denies an approval that only keeps the level the app holds, where the request %s",
      async (_case, asked, kept) => {
        ctx = await createTestContext({});
        const clientId = await seedClient(ctx);
        const cookie = await signInUser(ctx);
        await postDecision(ctx, cookie, clientId, "openid core.note:read", [
          "openid",
          "core.note:read",
        ]);
        const denied = await postDecision(ctx, cookie, clientId, asked, [
          "openid",
          kept,
        ]);
        expect(denied.location.searchParams.get("error")).toBe("access_denied");
        expect(await grantedScopes(ctx)).toEqual(["openid", "core.note:read"]);
        // The witness: choosing the write is a code.
        const approved = await postDecision(ctx, cookie, clientId, asked, [
          "openid",
          "core.note:write",
        ]);
        expect(approved.location.searchParams.get("code")).toBeTruthy();
      },
    );
  });

  it.each(["forged", "expired"] as const)(
    "%s oauth_query causes no projection, audit, or token-revocation side effects",
    async (failureMode) => {
      ctx = await createTestContext({});
      const clientId = await seedClient(ctx);
      const cookie = await signInUser(ctx);
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
      {
        const auditResult = await storage.audit.list({
          action: "auth.grant.created",
          limit: 10,
        });
        expect(auditResult.data.length === 1).toBe(true);
      }

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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);

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
          oauth_query: await buildSignedOauthQuery(
            clientId,
            "openid core.note:read",
          ),
          scopes: ["openid", "core.note:read"],
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
    ctx = await createTestContext({});
    const realClientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);

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
    const storage = ctx.storage;
    const audits = await storage.audit.list({
      action: "auth.grant.created",
      limit: 10,
    });
    expect(audits.data.length >= 1).toBe(true);
    expect(audits.data.length).toBe(1);
    const audit = audits.data[0];
    expect(audit?.resource_id).toBe(realClientId);
    expect(audit?.client_ip).toBe("203.0.113.42");
  });

  it("F3+F6: re-consent updates projection in place (no duplicate) + flips status to active + clears revoked_at + bumps version", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
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
    const revokedUpdate = await itemWrites(ctx.storage).update(grantId, {
      writer: null,
      properties: {
        ...items.data[0]!.properties,
        status: "revoked",
        revoked_at: new Date().toISOString(),
      },
    });
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

  it("F4: approving a request the app holds in full on a later visit keeps the grant and its tokens", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);

    const wide = [
      "openid",
      "core.note:read",
      "core.note:write",
      "core.task:read",
    ];
    const oauthQuery = await buildSignedOauthQuery(clientId, wide.join(" "));
    // First consent with wide scopes.
    const r1 = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: wide,
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(r1.status).toBe(302);

    const items1 = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items1.data.length).toBe(1);
    const authUserId = items1.data[0]!.properties.user_id as string;
    // The token a real /oauth2/token call would have minted at the wide scope.
    const tokenHash = await seedAccessToken(ctx, clientId, authUserId, wide);
    expect(
      await ctx.storage.oauthProvider?.validateAccessToken(tokenHash),
    ).not.toBeNull();

    // A later approval that posts less than the app holds. Approving never
    // lowers what the app holds, so the token and the grant stand, and the
    // code this approval makes carries what the app still holds.
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
    expect(r2.headers.get("location") ?? "").toContain("code=");

    expect(
      await ctx.storage.oauthProvider?.validateAccessToken(tokenHash),
    ).not.toBeNull();
    const after = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(new Set(after.data[0]!.properties.scopes as string[])).toEqual(
      new Set(wide),
    );
    expect(
      await ctx.storage.oauthProvider?.getPriorConsent(clientId, authUserId),
    ).toEqual(expect.arrayContaining(wide));
    const audits = await ctx.storage.audit.list({
      action: "auth.grant.created",
      limit: 10,
    });
    const latest: Record<string, unknown> = audits.data[0]!.details;
    expect(latest.scopes).toEqual(wide);
    expect(new Set(latest.resulting_scopes as string[])).toEqual(new Set(wide));
  });

  it("F4: re-consent with SAME scopes leaves access tokens alone (no narrowing → no revoke)", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);

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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);

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
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      scopes: JSON.stringify(heldScopes),
    });
    await (op.execute?.() ?? op.run?.() ?? Promise.resolve());

    // The token has to be live before the widening, or `not.toBeNull()`
    // after it proves nothing: a write that silently failed to insert
    // would leave this test green either way.
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

  it("F1: a decision naming a scope outside the signed set is refused and grants nothing", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "openid core.note:read",
    );

    // The witness: the same decision without the extra scope is a code.
    const honest = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read"],
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(honest.headers.get("location") ?? "").toContain("code=");
    const before = await ctx.storage.audit.list({
      action: "auth.grant.created",
      limit: 10,
    });

    // The form claims to approve a scope NOT in the signed set: refused as a
    // whole, so not even the signed scopes beside it are granted.
    const res = await request(ctx.app, "POST", "/auth/authorize/decision", {
      form: {
        accept: "true",
        oauth_query: oauthQuery,
        client_id: clientId,
        scopes: ["openid", "core.note:read", "core.note:write"], // last one is unsigned
      },
      headers: { cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();

    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data[0]?.properties.scopes).toEqual([
      "openid",
      "core.note:read",
    ]);
    const after = await ctx.storage.audit.list({
      action: "auth.grant.created",
      limit: 10,
    });
    expect(after.data.length).toBe(before.data.length);
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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
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
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
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

  it("refuses an app origin even when it is a CORS_ORIGINS entry", async () => {
    const allowedOrigin = "https://app.example.com";
    ctx = await createTestContext({
      corsOrigins: [allowedOrigin],
    });
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
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
    expect(res.status).toBe(403);
    const items = await ctx.storage.items.list({
      type: "system.connection",
      state: "active",
    });
    expect(items.data.length).toBe(0);
  });

  it("passes a POST with no Origin or Referer to the proxy hop, where Better Auth refuses it", async () => {
    ctx = await createTestContext({});
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
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
  /** What an untouched form submits. */
  const untouchedSubmission = (html: string): string[] =>
    defaultSubmission(html, "scopes");

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
      label: "Manage your server",
      description: "",
      scopes: ["core.task:write"],
      default_on: false,
    },
  ];

  it("keeps the unticked bundle's scopes off the projected grant", async () => {
    ctx = await createTestContext({});
    setActivePermissionBundles(BUNDLES);
    try {
      const clientId = await seedClient(ctx);
      const cookie = await signInUser(ctx);
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
    // tokens. An untouched Continue killed a working connector, and a
    // permission granted once would evaporate at the next re-consent.
    //
    // First consent ticks the off bundle by hand; the return visit touches
    // nothing. The grant has to survive it.
    ctx = await createTestContext({});
    setActivePermissionBundles(BUNDLES);
    try {
      const clientId = await seedClient(ctx);
      const cookie = await signInUser(ctx);
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
      // What the app holds is not posted back: the server adds it.
      expect(submitted).not.toContain("core.task:write");

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
// The screen offers a repeated literal once (`buildAccess` in
// `access-model.ts`). The stored grant is the half that matters: the
// duplicate did not stop at the screen. `formScopes` kept both copies,
// `projectGrantOnConsent` wrote them verbatim into `properties.scopes` on the
// `system.connection` item, and every surface that later reads or diffs that
// list inherited the duplicate.
// ---------------------------------------------------------------------------

describe("a scope named twice is stored once", () => {
  it("writes one copy when the request names the literal twice", async () => {
    ctx = await createTestContext();
    const clientId = await seedClient(ctx);
    const cookie = await signInUser(ctx);
    const oauthQuery = await buildSignedOauthQuery(
      clientId,
      "core.note:read core.note:read core.task:read",
    );

    // The precondition, and it is the rendering fix stated end to end: the
    // screen a person is actually served emits one control for the repeated
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
    const cookie = await signInUser(ctx);
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
