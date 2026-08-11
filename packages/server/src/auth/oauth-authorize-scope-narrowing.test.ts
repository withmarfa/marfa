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
 * with. A media-type restructure took hosted sign-in down this way, for
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
 * works by rewriting `ctx.query.scope` in place, which is only load-bearing
 * because the plugin reads the same object afterwards. Were an upstream
 * change to start cloning the hook context, a test that asserted on the
 * mutation would keep passing while sign-in broke.
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
  markEmailVerified,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { buildAllowedScopes } from "./oauth-provider.js";

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

async function betterAuthSchema(c: TestContext) {
  return c.storage.betterAuthDialect === "pg"
    ? await import("../storage/pg/schema.js")
    : await import("../storage/sqlite/schema.js");
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
  const schemaModule = await betterAuthSchema(c);
  const db = c.storage.betterAuthDb as unknown as {
    insert: (table: unknown) => {
      values: (v: Record<string, unknown>) => {
        run?: () => Promise<unknown>;
        execute?: () => Promise<unknown>;
      };
    };
  };
  const isPg = c.storage.betterAuthDialect === "pg";
  const now = new Date();
  const op = db.insert(schemaModule.auth_oauth_client).values({
    id: `pk_${randomBytes(5).toString("hex")}`,
    clientId,
    name: "Narrowing Test Client",
    redirectUris: isPg ? [CALLBACK] : JSON.stringify([CALLBACK]),
    scopes:
      scopes === undefined
        ? null
        : isPg
          ? [...scopes]
          : JSON.stringify([...scopes]),
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
  const signUpRes = await request(c.app, "POST", "/auth/sign-up/email", {
    body: { email, password, name: "Test User" },
    headers: { origin: ORIGIN },
  });
  if (signUpRes.status !== 200) {
    throw new Error(`sign-up failed (${String(signUpRes.status)})`);
  }
  await markEmailVerified(c.storage, email);
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
    ctx = await createTestContext({ authMode: "hosted" });
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
    ctx = await createTestContext({ authMode: "hosted" });
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
    ctx = await createTestContext({ authMode: "hosted" });
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
    ctx = await createTestContext({ authMode: "hosted" });
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
    ctx = await createTestContext({ authMode: "hosted" });
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
    ctx = await createTestContext({ authMode: "hosted" });
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

    // Narrowing it away would succeed here and then fail inside the SDK at
    // the token step, with nothing naming the scope that went missing. A
    // named `invalid_scope` says which literal to go and register.
    expect(res.status).toBe(302);
    const result = classifyAuthorize(res);
    expect(result.outcome).toBe("error");
    expect(result.error).toBe("invalid_scope");
    expect(result.description).toContain("offline_access");
  });

  it("defaults an omitted scope to the live part of the ceiling", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
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
    ctx = await createTestContext({ authMode: "hosted" });
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

  it("a client with no stored ceiling tracks the live allowlist", async () => {
    ctx = await createTestContext({ authMode: "hosted" });
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
