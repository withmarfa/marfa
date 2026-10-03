/**
 * Tests for scope narrowing on the plugin's authorize endpoint.
 *
 * `auth_oauth_client.scopes` is written once, when the client registers,
 * and nothing refreshes it. The platform's own allowlist is rebuilt from
 * the type and edge registries on every boot, so the two drift apart the
 * moment a type is added or removed — the stored set then holds scopes for
 * types that no longer exist and lacks scopes for types that do. The plugin
 * validates with `new Set(client.scopes ?? opts.scopes)`, so whenever the
 * stored set is non-null it wins outright and the live registry is never
 * consulted.
 *
 * The consequence is not a narrowed grant, it is no grant at all: one
 * unrecognized literal redirects the browser to the client's own callback
 * with `error=invalid_scope`, and there is nothing on that page to recover
 * with. A media-type restructure took sign-in down this way, for
 * every client and every user, signed in or not.
 *
 * The before-hook intersects the request with what the server can grant and
 * what the client is registered for, so an unsatisfiable literal costs the
 * requester that literal instead of the authorization. RFC 6749 §3.3
 * provides for exactly this, and the granted set travels back on the token
 * response, so a client can tell what it actually got.
 *
 * **Every test here asserts an observable outcome — the redirect, the
 * rendered page, the token response — never the mutation itself.** The hook
 * works by rewriting the request's `scope` in place, which is only
 * load-bearing because the plugin reads the same object afterwards. Were an
 * upstream change to start cloning the hook context, a test that asserted on
 * the mutation would keep passing while sign-in broke.
 *
 * That object is the query string on a GET and the form body on a POST, and
 * the endpoint serves both verbs, so the POST cases below are not a variant
 * spelling of the GET ones: they are the half where a hook reading the wrong
 * object narrows nothing and reports that it did. The hook reproduces the
 * provider's own choice between the two rather than inferring one, so what
 * these pin is that the two still agree — and they pin it end-to-end,
 * because a divergence shows up as a request that stops being narrowed
 * rather than as a wrong value anything could assert on directly.
 *
 * Coverage:
 *   - a stale ceiling missing a live scope reaches consent instead of
 *     dead-ending (the production outage, in miniature)
 *   - a scope for a deleted type is never offered at consent, which is the
 *     same staleness pointing the other way
 *   - the token response names exactly the narrowed set
 *   - a request in which nothing is grantable still fails `invalid_scope`
 *   - an empty-array ceiling is a real ceiling, not an absent one
 *   - an omitted `scope` defaults to the live part of the ceiling, not to
 *     the stale stored snapshot
 *   - a client with no ceiling tracks the live allowlist
 *   - a form POST is narrowed on the same terms as a GET, refusals included
 *   - a POST carrying parameters on the query too follows the provider onto
 *     the body, and one carrying them ONLY on the query is left alone rather
 *     than narrowed on an object the provider will not read
 *   - a narrowed form POST survives the re-entry that consent performs
 *
 * What the user cannot be shown: the consent page never learns which
 * literals were dropped. The plugin's authorize endpoint validates its
 * query with a stripping schema, so no custom parameter survives into the
 * signed redirect the page renders from, and an unsigned parameter is
 * exactly what that page must never trust. The token response's `scope`
 * field and the server logs are the two honest channels.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  createTestContext,
  createTestAccount,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { buildAllowedScopes } from "./oauth-provider.js";
import { buildDefaultPermissionBundles } from "./default-bundles.js";

// Each test signs a user up and in (two password hashes) before it drives a
// full authorize round trip. That is real work to fit inside the default
// budget on a machine running the rest of the suite beside it, and an
// overrun reports as a timeout — a result that says nothing about the
// property under test.
vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";
const CALLBACK = "http://localhost:0/callback";

/** A scope literal for a type this build has genuinely never carried, so
 *  the case cannot quietly stop being tested when the registry changes. */
const RETIRED_SCOPE = "core.media.tv_episode:read";

/** What the metadata document advertises to every client, which is what a
 *  stale ceiling catches up to. Narrower than {@link buildAllowedScopes},
 *  which also carries the wildcards no bundle offers. */
const bundleScopes = new Set(
  buildDefaultPermissionBundles().flatMap((bundle) => bundle.scopes),
);

/** A wildcard is requestable and deliberately not in any bundle, which is
 *  what makes it the control: the ceiling still governs it after the
 *  catch-up, so the catch-up is not just "the ceiling stopped mattering". */
const NON_BUNDLE_SCOPE = "core.*:read";

function betterAuthSchema() {
  return import("../storage/sqlite/schema.js");
}

/**
 * Seed a public PKCE client. `scopes` is written exactly as given:
 * `undefined` leaves the column NULL (no ceiling — the client tracks the
 * live allowlist), and an array is stored as a real ceiling, which is the
 * frozen snapshot every seeded first-party client carried.
 */
async function seedClient(
  c: TestContext,
  scopes?: readonly string[],
): Promise<string> {
  const clientId = `client_${randomBytes(5).toString("hex")}`;
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
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: `pk_${randomBytes(5).toString("hex")}`,
    clientId,
    name: "Narrowing Test Client",
    redirectUris: JSON.stringify([CALLBACK]),
    scopes: scopes === undefined ? null : JSON.stringify([...scopes]),
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: true,
    tokenEndpointAuthMethod: "none",
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

/** Read the ceiling back through the store, so the round trip is pinned
 *  rather than assumed from what was written. */
async function storedCeiling(
  c: TestContext,
  clientId: string,
): Promise<string[] | null> {
  const client = await c.storage.oauthProvider?.getClient(clientId);
  if (!client) throw new Error(`no client row for ${clientId}`);
  return client.scopes;
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
  for (const part of setCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/)) {
    const head = part.split(";")[0];
    if (head?.includes("session_token")) return head;
  }
  throw new Error("sign-in: session_token cookie not found");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function beginAuthorize(
  c: TestContext,
  clientId: string,
  scope: string | undefined,
  cookie: string,
  challenge: string,
): Promise<Response> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "narrowing-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (scope !== undefined) params.set("scope", scope);
  return request(c.app, "GET", `/auth/oauth2/authorize?${params.toString()}`, {
    headers: { cookie },
  });
}

/**
 * The same authorization request as {@link beginAuthorize}, sent as a form
 * POST. The endpoint accepts `application/x-www-form-urlencoded` on POST and
 * takes every parameter from the body, so the query string stays empty — a
 * request whose parameters live nowhere a query-only reader would find them.
 */
async function beginAuthorizePost(
  c: TestContext,
  clientId: string,
  scope: string | undefined,
  cookie: string,
  challenge: string,
): Promise<Response> {
  const form: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "narrowing-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  if (scope !== undefined) form.scope = scope;
  return request(c.app, "POST", "/auth/oauth2/authorize", {
    form,
    headers: { cookie, origin: ORIGIN },
  });
}

/** The plugin 302s on every outcome, so the destination is what separates
 *  them: the consent page means the request survived, the client's own
 *  callback carrying `error=` means it did not. */
function classifyAuthorize(res: Response): {
  outcome: "consent" | "error";
  error?: string;
  description?: string;
  signedQuery?: string;
} {
  const location = res.headers.get("location") ?? "";
  if (location.includes("/auth/authorize?")) {
    return {
      outcome: "consent",
      signedQuery: location.slice(location.indexOf("?") + 1),
    };
  }
  const url = new URL(location, ORIGIN);
  const error = url.searchParams.get("error");
  if (error) {
    return {
      outcome: "error",
      error,
      description: url.searchParams.get("error_description") ?? undefined,
    };
  }
  throw new Error(`unclassifiable authorize redirect: ${location}`);
}

/** Accept at the consent screen and return the authorization code. */
async function acceptConsent(
  c: TestContext,
  cookie: string,
  signedQuery: string,
  scopes: string[],
): Promise<string> {
  const decisionRes = await request(c.app, "POST", "/auth/authorize/decision", {
    form: { accept: "true", oauth_query: signedQuery, scopes },
    headers: { cookie, origin: ORIGIN },
  });
  expect(decisionRes.status).toBe(302);
  const location = decisionRes.headers.get("location") ?? "";
  const code = new URL(location, ORIGIN).searchParams.get("code");
  if (!code) throw new Error(`no code on callback redirect: ${location}`);
  return code;
}

describe("authorize scope narrowing", () => {
  it("a stale ceiling missing a live scope reaches consent instead of dead-ending", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-stale@example.com");

    // The production shape exactly: a ceiling frozen before a type landed,
    // so it covers `core.note:read` but not the newer `core.task:read`.
    const live = buildAllowedScopes();
    expect(live).toContain("core.note:read");
    expect(live).toContain("core.task:read");
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);
    expect(await storedCeiling(ctx, clientId)).toEqual([
      "openid",
      "core.note:read",
    ]);

    const { challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      "openid core.note:read core.task:read",
      cookie,
      challenge,
    );

    expect(res.status).toBe(302);
    const result = classifyAuthorize(res);
    // Before the hook this was `error=invalid_scope`, and the app rendered
    // the raw description on a page with no way forward.
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("consent");
  });

  it("never offers a scope for a type this server no longer carries", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-retired@example.com");

    // The snapshot is stale in BOTH directions, and this is the second one:
    // a ceiling minted before a type was deleted still contains its scope.
    // The plugin validates against that ceiling, so the literal passes and
    // the user is asked to approve access to a type that does not exist.
    // Nothing downstream refuses it — the scope is simply meaningless once
    // granted, which is worse than being refused, because the consent screen
    // told the user something untrue about what they were giving away.
    expect(buildAllowedScopes()).not.toContain(RETIRED_SCOPE);
    const clientId = await seedClient(ctx, [
      "openid",
      "core.note:read",
      RETIRED_SCOPE,
    ]);

    const { challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      `openid core.note:read ${RETIRED_SCOPE}`,
      cookie,
      challenge,
    );
    expect(res.status).toBe(302);
    const { outcome, signedQuery } = classifyAuthorize(res);
    expect(outcome).toBe("consent");

    // The signed query is what the consent screen renders from, so the
    // retired literal being absent here is what stops it being offered.
    expect(signedQuery).toBeDefined();
    const carriedScope =
      new URLSearchParams(signedQuery ?? "").get("scope") ?? "";
    expect(carriedScope.split(" ")).not.toContain(RETIRED_SCOPE);
    expect(carriedScope.split(" ")).toContain("core.note:read");

    const consentPage = await request(
      ctx.app,
      "GET",
      `/auth/authorize?${signedQuery ?? ""}`,
      { headers: { cookie, accept: "text/html,application/xhtml+xml" } },
    );
    expect(consentPage.status).toBe(200);
    const html = await consentPage.text();
    expect(html).not.toContain(RETIRED_SCOPE);
  });

  it("the token response names exactly the narrowed set", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-token@example.com");
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);

    const { verifier, challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      // Two droppable literals, one per reason: `core.task:read` exists but
      // sits outside the ceiling, `RETIRED_SCOPE` does not exist at all.
      `openid core.note:read core.task:read ${RETIRED_SCOPE}`,
      cookie,
      challenge,
    );
    const { outcome, signedQuery } = classifyAuthorize(res);
    expect(outcome).toBe("consent");

    const code = await acceptConsent(ctx, cookie, signedQuery ?? "", [
      "openid",
      "core.note:read",
    ]);

    const tokenRes = await request(ctx.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      },
      headers: { origin: ORIGIN },
    });
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { scope?: string };
    const granted = (body.scope ?? "").split(" ").filter(Boolean).sort();
    expect(granted).toEqual(["core.note:read", "openid"]);
  });

  it("still fails when nothing in the request is grantable", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-none@example.com");
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);

    const { challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      `${RETIRED_SCOPE} core.media.podcast:write`,
      cookie,
      challenge,
    );

    expect(res.status).toBe(302);
    const result = classifyAuthorize(res);
    // Narrowing to nothing would reach a consent screen with no rows, which
    // the decision handler reads as a denial. A clear failure beats that.
    expect(result.outcome).toBe("error");
    expect(result.error).toBe("invalid_scope");
  });

  it("treats an empty stored ceiling as a real ceiling, not an absent one", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-empty@example.com");

    // `client.scopes ?? opts.scopes` is null-coalescing, so `[]` does not
    // fall through to the live allowlist — it is a ceiling permitting
    // nothing. Reading it as "absent" here would hand the client the entire
    // allowlist, which is the inverse of what the row says.
    const clientId = await seedClient(ctx, []);
    expect(await storedCeiling(ctx, clientId)).toEqual([]);

    const { challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      "openid core.note:read",
      cookie,
      challenge,
    );

    expect(res.status).toBe(302);
    const result = classifyAuthorize(res);
    expect(result.outcome).toBe("error");
    expect(result.error).toBe("invalid_scope");
  });

  it("refuses rather than silently dropping a session-critical scope", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-session@example.com");

    // A ceiling that omits `offline_access` — the shape of a client whose
    // registration simply forgot it.
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);

    const { challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      "openid offline_access core.note:read",
      cookie,
      challenge,
    );

    // Narrowing it away would succeed here and then fail inside the client at
    // the token step, with nothing naming the scope that went missing. A
    // named `invalid_scope` says which literal to go and register.
    expect(res.status).toBe(302);
    const result = classifyAuthorize(res);
    expect(result.outcome).toBe("error");
    expect(result.error).toBe("invalid_scope");
    expect(result.description).toContain("offline_access");
  });

  it("defaults an omitted scope to the live part of the ceiling", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-noscope@example.com");
    // A ceiling holding a scope for a deleted type. The plugin defaults an
    // omitted `scope` to this stored snapshot, which would put the dead
    // literal in front of the user at consent and inside the grant after.
    const clientId = await seedClient(ctx, [
      "openid",
      "core.note:read",
      RETIRED_SCOPE,
    ]);

    const { challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      undefined,
      cookie,
      challenge,
    );

    expect(res.status).toBe(302);
    const { outcome, signedQuery } = classifyAuthorize(res);
    expect(outcome).toBe("consent");
    const signed = new URLSearchParams(signedQuery ?? "");
    const carried = (signed.get("scope") ?? "").split(" ").filter(Boolean);
    expect(carried.sort()).toEqual(["core.note:read", "openid"]);
    expect(carried).not.toContain(RETIRED_SCOPE);
  });

  it("leaves an omitted scope alone when the ceiling is fully live", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-noscope-live@example.com");
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);

    const { challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      undefined,
      cookie,
      challenge,
    );

    // Nothing to drop, so nothing is rewritten.
    expect(res.status).toBe(302);
    const { outcome, signedQuery } = classifyAuthorize(res);
    expect(outcome).toBe("consent");
    const carried = (new URLSearchParams(signedQuery ?? "").get("scope") ?? "")
      .split(" ")
      .filter(Boolean);
    expect(carried.sort()).toEqual(["core.note:read", "openid"]);
  });

  // The defect this file was written against was a client dead-ending. This
  // is the one underneath it: a client that reaches consent perfectly well
  // and is simply never granted the newer half of what it asked for.
  //
  // Six scopes went missing from a real client that way, all of them types
  // registered after it had. Nothing reported it, the consent screen went on
  // offering them, and no grant on either environment held any of the six.
  it("grants a client a bundle scope for a type registered after it was", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-aged-out@example.com");

    // The production shape: a ceiling frozen before the type landed.
    expect(bundleScopes.has("core.task:read")).toBe(true);
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);

    const { verifier, challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      "openid core.note:read core.task:read",
      cookie,
      challenge,
    );
    const { outcome, signedQuery } = classifyAuthorize(res);
    expect(outcome).toBe("consent");

    // The user approves everything they were offered, so whatever the token
    // carries is what the server was willing to grant.
    const code = await acceptConsent(ctx, cookie, signedQuery ?? "", [
      "openid",
      "core.note:read",
      "core.task:read",
    ]);
    const tokenRes = await request(ctx.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      },
      headers: { origin: ORIGIN },
    });
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { scope?: string };
    expect((body.scope ?? "").split(" ").filter(Boolean).sort()).toEqual([
      "core.note:read",
      "core.task:read",
      "openid",
    ]);

    // And the ceiling itself moved, so the next authorize does not have to
    // rediscover it. Read back through the store rather than assumed.
    expect(await storedCeiling(ctx, clientId)).toContain("core.task:read");
  });

  // The catch-up grows the ceiling by what was asked for, not to the whole
  // bundle union. The difference is load-bearing: the ceiling is also what a
  // client gets when it omits `scope`, so a wholesale widening would turn
  // every no-scope authorize into a request for everything.
  it("widens by what was requested rather than to the whole bundle set", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-minimal@example.com");
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);

    const { challenge } = pkcePair();
    await beginAuthorize(
      ctx,
      clientId,
      "openid core.note:read core.task:read",
      cookie,
      challenge,
    );

    const after = await storedCeiling(ctx, clientId);
    expect(after).toEqual(["openid", "core.note:read", "core.task:read"]);
    // Emphatically not the whole bundle set, which is far larger.
    expect(after?.length).toBeLessThan(bundleScopes.size);
  });

  // The control. If the catch-up admitted anything requestable it would not
  // be a catch-up, it would be the ceiling quietly ceasing to exist.
  it("leaves the ceiling governing a scope no bundle advertises", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-wildcard@example.com");

    expect(buildAllowedScopes()).toContain(NON_BUNDLE_SCOPE);
    expect(bundleScopes.has(NON_BUNDLE_SCOPE)).toBe(false);
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);

    const { challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      `openid core.note:read ${NON_BUNDLE_SCOPE}`,
      cookie,
      challenge,
    );

    // Narrowed, not dead-ended, exactly as before: the wildcard costs the
    // requester the wildcard.
    expect(classifyAuthorize(res).outcome).toBe("consent");
    expect(await storedCeiling(ctx, clientId)).toEqual([
      "openid",
      "core.note:read",
    ]);
  });

  // An empty ceiling is a deliberate statement that this client may have
  // nothing, and the catch-up must not read it as "not configured yet".
  it("does not fill in an empty ceiling", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-empty-ceiling@example.com");
    const clientId = await seedClient(ctx, []);

    const { challenge } = pkcePair();
    await beginAuthorize(
      ctx,
      clientId,
      "openid core.task:read",
      cookie,
      challenge,
    );

    expect(await storedCeiling(ctx, clientId)).toEqual([]);
  });

  // A null ceiling already tracks the live allowlist, so writing one would
  // be replacing a set that follows the registry with a snapshot that does
  // not — the exact defect, introduced by its own repair.
  it("does not write a ceiling onto a client that has none", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-null-ceiling@example.com");
    const clientId = await seedClient(ctx);

    const { challenge } = pkcePair();
    await beginAuthorize(
      ctx,
      clientId,
      "openid core.task:read",
      cookie,
      challenge,
    );

    expect(await storedCeiling(ctx, clientId)).toBeNull();
  });

  it("a client with no stored ceiling tracks the live allowlist", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-null@example.com");

    const clientId = await seedClient(ctx);
    expect(await storedCeiling(ctx, clientId)).toBeNull();

    const { challenge } = pkcePair();
    const res = await beginAuthorize(
      ctx,
      clientId,
      `openid core.note:read core.task:read ${RETIRED_SCOPE}`,
      cookie,
      challenge,
    );

    // The retired literal is still dropped — it exists in no ceiling — but
    // everything the server currently advertises survives.
    expect(res.status).toBe(302);
    expect(classifyAuthorize(res).outcome).toBe("consent");
  });
});

describe("authorize scope narrowing on a form POST", () => {
  it("narrows a form POST exactly as it narrows a GET", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-post-stale@example.com");

    // The GET case's ceiling, unchanged: frozen before `core.task:read`
    // existed, and still carrying a scope for a type that has since gone.
    const live = buildAllowedScopes();
    expect(live).toContain("core.task:read");
    expect(live).not.toContain(RETIRED_SCOPE);
    const clientId = await seedClient(ctx, [
      "openid",
      "core.note:read",
      RETIRED_SCOPE,
    ]);

    const { challenge } = pkcePair();
    const res = await beginAuthorizePost(
      ctx,
      clientId,
      `openid core.note:read core.task:read ${RETIRED_SCOPE}`,
      cookie,
      challenge,
    );

    // A hook that reads only the query string finds nothing to narrow here,
    // and the un-narrowed set then reaches the plugin, where the one
    // unsatisfiable literal dead-ends the whole authorization on the
    // client's own callback. Reaching consent is what says otherwise.
    expect(res.status).toBe(302);
    const result = classifyAuthorize(res);
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("consent");

    // The signed query is what the consent screen renders from, so this is
    // the narrowed set the person is actually shown.
    const carried = (
      new URLSearchParams(result.signedQuery ?? "").get("scope") ?? ""
    ).split(" ");
    expect(carried).not.toContain(RETIRED_SCOPE);
    expect(carried).toContain("core.note:read");
    expect(carried).toContain("core.task:read");
  });

  it("refuses rather than silently dropping a session-critical scope on a form POST", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-post-session@example.com");

    // A ceiling that omits `offline_access`. The refusal, not the reading,
    // is what this pins: once the hook can read a POST's scope it can also
    // narrow one, and narrowing a session scope away succeeds at the
    // authorize step and then fails inside the client with nothing naming the
    // literal that went missing. Both verbs have to refuse, not just the
    // one the guard was written against.
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);

    const { challenge } = pkcePair();
    const res = await beginAuthorizePost(
      ctx,
      clientId,
      "openid offline_access core.note:read",
      cookie,
      challenge,
    );

    expect(res.status).toBe(302);
    const result = classifyAuthorize(res);
    expect(result.outcome).toBe("error");
    expect(result.error).toBe("invalid_scope");
    expect(result.description).toContain("offline_access");
  });

  it("follows the provider onto the body when the query carries parameters too", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-post-both@example.com");
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);

    // The provider takes a POST's parameters from the body and ignores the
    // query outright, so this is a request it serves normally rather than a
    // malformed one. The query here names a client that does not exist and a
    // scope nothing could grant: narrowing against it would fail to resolve
    // a ceiling and leave the request alone, so reaching consent is what
    // says the body is what got read.
    const { challenge } = pkcePair();
    const decoy = new URLSearchParams({
      client_id: "client_does_not_exist",
      scope: RETIRED_SCOPE,
    });
    const res = await request(
      ctx.app,
      "POST",
      `/auth/oauth2/authorize?${decoy.toString()}`,
      {
        form: {
          response_type: "code",
          client_id: clientId,
          redirect_uri: CALLBACK,
          state: "narrowing-state",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: `openid core.note:read core.task:read`,
        },
        headers: { cookie, origin: ORIGIN },
      },
    );

    expect(res.status).toBe(302);
    const result = classifyAuthorize(res);
    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("consent");
    const carried = (
      new URLSearchParams(result.signedQuery ?? "").get("scope") ?? ""
    ).split(" ");
    expect(carried).toContain("core.task:read");
  });

  it("leaves a POST whose parameters are only on the query entirely alone", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-post-queryonly@example.com");
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);
    const before = await storedCeiling(ctx, clientId);

    // The provider reads a POST's body and this one is empty, so the request
    // is going to fail whatever happens here. What must not happen is this
    // hook acting on the query anyway: the stale-ceiling catch-up is a
    // permanent write to the client's registration, and it would land on an
    // object the provider never reads.
    //
    // Narrowly that, and not the general shape it resembles. A before-hook
    // completes before the endpoint does, so the catch-up still runs ahead
    // of every rejection the endpoint itself makes — an unregistered
    // `redirect_uri` among them. That is a separate property, older than
    // this, and nothing here holds it.
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "narrowing-state",
      scope: "openid core.note:read core.task:read",
    });
    await request(
      ctx.app,
      "POST",
      `/auth/oauth2/authorize?${query.toString()}`,
      { form: {}, headers: { cookie, origin: ORIGIN } },
    );

    // `core.task:read` is a bundle scope the ceiling lacks, so a hook that
    // read the query here would have widened the row to hold it.
    expect(bundleScopes.has("core.task:read")).toBe(true);
    expect(await storedCeiling(ctx, clientId)).toEqual(before);
  });

  it("carries a narrowed form POST through consent to a token", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "narrow-post-token@example.com");
    const clientId = await seedClient(ctx, ["openid", "core.note:read"]);

    const { verifier, challenge } = pkcePair();
    const res = await beginAuthorizePost(
      ctx,
      clientId,
      `openid core.note:read ${RETIRED_SCOPE}`,
      cookie,
      challenge,
    );
    const { outcome, signedQuery } = classifyAuthorize(res);
    expect(outcome).toBe("consent");

    // Accepting re-enters the authorize endpoint from inside the provider,
    // as a POST whose body is the consent form and whose query is the
    // authorize request. The hook runs a second time on that re-entry, and
    // the flow completing with the right grant is what says it read the
    // query there rather than the consent body.
    const code = await acceptConsent(ctx, cookie, signedQuery ?? "", [
      "openid",
      "core.note:read",
    ]);

    const tokenRes = await request(ctx.app, "POST", "/auth/oauth2/token", {
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      },
      headers: { origin: ORIGIN },
    });
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { scope?: string };
    const granted = (body.scope ?? "").split(" ").filter(Boolean).sort();
    expect(granted).toEqual(["core.note:read", "openid"]);
  });
});

it("requires the native narrowing observation before returning its changed authorization request", async () => {
  ctx = await createTestContext();
  const cookie = await signInUser(ctx, "narrow-audit@example.test");
  const clientId = await seedClient(ctx, [
    "openid",
    "core.note:read",
    RETIRED_SCOPE,
  ]);
  const db = ctx.storage as typeof ctx.storage & {
    __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
  };
  await db.__sqliteRun(
    "CREATE TRIGGER reject_narrow_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.scopes.narrowed' BEGIN SELECT RAISE(ABORT, 'narrow audit fault'); END",
    [],
  );
  const { challenge } = pkcePair();
  const begin = () =>
    beginAuthorize(
      ctx!,
      clientId,
      `openid core.note:read ${RETIRED_SCOPE}`,
      cookie,
      challenge,
    );
  const failed = await begin();
  expect(failed.status).toBe(500);
  expect(failed.headers.get("location")).toBeNull();
  await db.__sqliteRun("DROP TRIGGER reject_narrow_audit", []);
  expect((await begin()).status).toBe(302);
  expect(
    (await ctx.storage.audit.list({ action: "auth.scopes.narrowed" })).data,
  ).toHaveLength(1);
});
