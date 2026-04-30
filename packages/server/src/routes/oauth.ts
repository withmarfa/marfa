import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  MymeError,
  ErrorCode,
  parseScope,
  expandWildcardScopes,
  TYPE_REGISTRY,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin, requireAuth, hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MymeAuth } from "../auth/instance.js";
import { renderConsentScreen } from "./consent.js";
import { constantTimeEqual } from "../utils/crypto.js";

const ACCESS_TOKEN_PREFIX = "myme_at_";
const REFRESH_TOKEN_PREFIX = "myme_rt_";
const ACCESS_TOKEN_TTL_MS = 3600_000; // 1 hour
const CODE_TTL_MS = 600_000; // 10 minutes

/**
 * Plain-English descriptions for the metadata-layer sub-resource scopes.
 * Type scopes pull their descriptions from `TYPE_REGISTRY`; these don't
 * correspond to a registered type, so they live alongside the route.
 */
const METADATA_SCOPE_DESCRIPTIONS: Record<string, string> = {
  metadata: "Read or write any metadata-layer resource",
  "metadata.types": "Register and update custom data types in your workspace",
};

function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function authRoutes(
  storage: Storage,
  salt: string,
  auth?: MymeAuth,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const knownTypes = Array.from(TYPE_REGISTRY.keys());

  /**
   * Gate `/auth/authorize` on a Better Auth cookie session. End users
   * (not just admins) must be signed in before the consent screen
   * renders or processes a decision. Unauthenticated requests are
   * redirected to `/auth/sign-in` with the original URL preserved as
   * `return_to` so the sign-in flow can pick up where the OAuth flow
   * left off.
   *
   * Returns the active session on success; the caller responds to a
   * `null` return by issuing the redirect (no further work to do).
   */
  async function requireConsentSession(
    c: Context<AppEnv>,
  ): Promise<{ kind: "session"; session: NonNullable<unknown> } | Response> {
    if (!auth) {
      // Better-auth isn't mounted on this instance. Without an identity
      // layer the consent screen can't authenticate a user — refuse
      // outright rather than silently accept.
      throw new MymeError(
        ErrorCode.UNAUTHORIZED,
        "Consent flow requires the better-auth identity layer to be configured",
      );
    }
    const session = await auth.getSession(c.req.raw.headers);
    if (session) {
      return { kind: "session", session };
    }
    const url = new URL(c.req.url);
    const returnTo = `${url.pathname}${url.search}`;
    const signInPath = `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
    return c.redirect(signInPath, 302);
  }

  // -----------------------------------------------------------------------
  // Client registration
  // -----------------------------------------------------------------------

  router.post("/clients", async (c) => {
    requireAdmin(c);
    const body = await c.req.json();
    if (!body.name || !body.redirect_uris?.length) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "name and redirect_uris are required",
      );
    }
    const client = await storage.oauth.createClient({
      name: body.name,
      redirect_uris: body.redirect_uris,
    });
    return c.json(client, 201);
  });

  router.get("/clients", async (c) => {
    requireAdmin(c);
    const clients = await storage.oauth.listClients();
    return c.json(clients);
  });

  // -----------------------------------------------------------------------
  // Authorization flow
  // -----------------------------------------------------------------------

  router.get("/authorize", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;

    const clientId = c.req.query("client_id");
    const responseType = c.req.query("response_type");
    const scope = c.req.query("scope");
    const redirectUri = c.req.query("redirect_uri");
    const codeChallenge = c.req.query("code_challenge");
    const codeChallengeMethod = c.req.query("code_challenge_method");
    const state = c.req.query("state") ?? "";

    if (
      !clientId ||
      responseType !== "code" ||
      !scope ||
      !redirectUri ||
      !codeChallenge
    ) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Missing required parameters: client_id, response_type=code, scope, redirect_uri, code_challenge",
      );
    }
    if (codeChallengeMethod && codeChallengeMethod !== "S256") {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Only S256 code_challenge_method is supported",
      );
    }

    const client = await storage.oauth.getClient(clientId);
    if (!client) {
      throw new MymeError(ErrorCode.INVALID_CLIENT, "Unknown client_id");
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "redirect_uri not registered for this client",
      );
    }

    // Parse and expand scopes
    const requestedScopes = scope.split(" ");
    const expanded = expandWildcardScopes(requestedScopes, knownTypes);
    const parsed = expanded.map(parseScope).filter((s) => s !== null);

    if (parsed.length === 0) {
      throw new MymeError(
        ErrorCode.INVALID_SCOPE,
        "No valid scopes in request",
      );
    }

    // Build the plain-English description map. Type scopes look up
    // the type registry's `description` field; metadata sub-resources
    // (`metadata.types`, future entries) carry their own canonical
    // strings — they're not items in TYPE_REGISTRY. Missing entries
    // fall back to the literal scope at render time.
    const descriptions: Record<string, string> = {};
    for (const scope of parsed) {
      if (descriptions[scope.typePattern] !== undefined) continue;
      if (scope.kind === "metadata") {
        const desc = METADATA_SCOPE_DESCRIPTIONS[scope.typePattern];
        if (desc) descriptions[scope.typePattern] = desc;
        continue;
      }
      const schema = TYPE_REGISTRY.get(scope.typePattern);
      if (schema?.description) {
        descriptions[scope.typePattern] = schema.description;
      }
    }

    // Render consent screen
    const html = renderConsentScreen({
      clientName: client.name,
      scopes: parsed,
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: codeChallengeMethod ?? "S256",
      state,
      responseType,
      descriptions,
    });

    return c.html(html);
  });

  router.post("/authorize", async (c) => {
    const gated = await requireConsentSession(c);
    if (gated instanceof Response) return gated;

    const formData = await c.req.parseBody();
    const action = formData.action as string;
    const clientId = formData.client_id as string;
    const redirectUri = formData.redirect_uri as string;
    const codeChallenge = formData.code_challenge as string;
    const codeChallengeMethod =
      (formData.code_challenge_method as string) || "S256";
    const state = (formData.state as string) || "";

    if (!clientId || !redirectUri || !codeChallenge) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Missing form parameters",
      );
    }

    // Denial
    if (action === "deny") {
      const url = new URL(redirectUri);
      url.searchParams.set("error", "access_denied");
      if (state) url.searchParams.set("state", state);
      return c.redirect(url.toString());
    }

    // Approval — collect granted scopes
    const rawScopes = formData.scopes;
    const grantedScopes: string[] = Array.isArray(rawScopes)
      ? (rawScopes as string[])
      : rawScopes
        ? [rawScopes as string]
        : [];

    if (grantedScopes.length === 0) {
      throw new MymeError(
        ErrorCode.INVALID_SCOPE,
        "At least one scope must be granted",
      );
    }

    // Create grant and authorization code
    const grant = await storage.oauth.createGrant(clientId, grantedScopes);
    const rawCode = randomBytes(32).toString("hex");
    const codeHash = hashApiKey(rawCode, salt);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

    await storage.oauth.createCode(
      grant.id,
      codeHash,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      expiresAt,
    );

    const url = new URL(redirectUri);
    url.searchParams.set("code", rawCode);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  // -----------------------------------------------------------------------
  // Token endpoint (public — no auth required for token exchange)
  // -----------------------------------------------------------------------

  router.post("/token", async (c) => {
    const body = await c.req.json();
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      return handleCodeExchange(c, body, storage, salt);
    }
    if (grantType === "refresh_token") {
      return handleRefresh(c, body, storage, salt);
    }

    throw new MymeError(ErrorCode.VALIDATION_ERROR, "Unsupported grant_type");
  });

  // -----------------------------------------------------------------------
  // Token management (authenticated)
  // -----------------------------------------------------------------------

  router.get("/tokens", async (c) => {
    requireAuth(c);
    const tokens = await storage.oauth.listTokens();
    return c.json(tokens);
  });

  router.delete("/tokens/:id", async (c) => {
    requireAuth(c);
    await storage.oauth.revokeToken(c.req.param("id"));
    return c.body(null, 204);
  });

  router.patch("/tokens/:id", async (c) => {
    requireAuth(c);
    const body = await c.req.json();
    if (!body.scopes) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "scopes is required");
    }
    await storage.oauth.reduceTokenScope(c.req.param("id"), body.scopes);
    return c.json({ status: "ok" });
  });

  // -----------------------------------------------------------------------
  // /auth/grants — typed query into system.connection items
  //
  // The user's "approved apps" surface. Reads system.connection items
  // with kind: user-app-grant. DELETE flips status → revoked and
  // cascades through revokeGrantTokens to invalidate every token issued
  // under the grant.
  // -----------------------------------------------------------------------

  router.get("/grants", async (c) => {
    requireAuth(c);
    const items = await storage.items.list({
      type: "system.connection",
      state: "active",
    });
    const grants: {
      id: string;
      kind: string;
      client_id: string;
      scopes: string[];
      status: string;
      granted_at: string;
      last_used_at: string | null;
    }[] = [];
    for (const item of items.data) {
      const props = item.properties;
      if (props.kind !== "user-app-grant") continue;
      if (props.status !== "active") continue;
      grants.push({
        id: item.id,
        kind: props.kind,
        client_id: typeof props.client_id === "string" ? props.client_id : "",
        scopes: Array.isArray(props.scopes) ? (props.scopes as string[]) : [],
        status: typeof props.status === "string" ? props.status : "active",
        granted_at:
          typeof props.granted_at === "string" ? props.granted_at : "",
        last_used_at:
          typeof props.last_used_at === "string" ? props.last_used_at : null,
      });
    }
    return c.json(grants);
  });

  router.delete("/grants/:id", async (c) => {
    requireAuth(c);
    const id = c.req.param("id");
    const item = await storage.items.get(id);
    if (item?.type !== "system.connection") {
      throw new MymeError(ErrorCode.NOT_FOUND, "Grant not found");
    }
    const props = item.properties;
    if (props.kind !== "user-app-grant") {
      throw new MymeError(ErrorCode.NOT_FOUND, "Grant not found");
    }
    const now = new Date().toISOString();
    await storage.items.update(id, {
      properties: { ...props, status: "revoked", revoked_at: now },
    });
    // Cascade-revoke every token + code issued under this connection.
    await storage.oauth.revokeGrantTokens(id);
    return c.body(null, 204);
  });

  return router;
}

// ---------------------------------------------------------------------------
// /.well-known/oauth-authorization-server — discovery doc
// ---------------------------------------------------------------------------

export function discoveryRoutes(baseUrl: string): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get("/oauth-authorization-server", (c) => {
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/auth/authorize`,
      token_endpoint: `${baseUrl}/auth/token`,
      registration_endpoint: `${baseUrl}/auth/clients`,
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });
  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function handleCodeExchange(
  c: { json: (data: unknown, status?: number) => Response },
  body: Record<string, string>,
  storage: Storage,
  salt: string,
): Promise<Response> {
  const { code, code_verifier, redirect_uri } = body;

  if (!code || !code_verifier || !redirect_uri) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      "code, code_verifier, and redirect_uri are required",
    );
  }

  const codeHash = hashApiKey(code, salt);
  const codeRecord = await storage.oauth.consumeCode(codeHash);

  if (!codeRecord) {
    throw new MymeError(
      ErrorCode.INVALID_GRANT,
      "Invalid, expired, or already-used authorization code",
    );
  }

  // Verify redirect_uri matches
  if (codeRecord.redirect_uri !== redirect_uri) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      "redirect_uri does not match",
    );
  }

  // PKCE verification: SHA256(code_verifier) must equal code_challenge.
  // Compared with timing-safe equality — the attacker controls one side
  // (code_verifier) and the challenge is derived deterministically from
  // a server-issued secret, so any byte-level timing leak is exploitable.
  const computedChallenge = sha256(code_verifier);
  if (!constantTimeEqual(computedChallenge, codeRecord.code_challenge)) {
    throw new MymeError(ErrorCode.INVALID_GRANT, "PKCE verification failed");
  }

  // Issue tokens
  const accessRaw = generateToken(ACCESS_TOKEN_PREFIX);
  const refreshRaw = generateToken(REFRESH_TOKEN_PREFIX);
  const accessHash = hashApiKey(accessRaw, salt);
  const refreshHash = hashApiKey(refreshRaw, salt);
  const accessExpiresAt = new Date(
    Date.now() + ACCESS_TOKEN_TTL_MS,
  ).toISOString();
  const refreshExpiresAt = new Date(
    Date.now() + 90 * 24 * 3600_000,
  ).toISOString(); // 90 days

  const accessToken = await storage.oauth.createToken(
    codeRecord.connection_item_id,
    accessHash,
    "access",
    accessExpiresAt,
  );
  await storage.oauth.createToken(
    codeRecord.connection_item_id,
    refreshHash,
    "refresh",
    refreshExpiresAt,
  );

  return c.json({
    access_token: accessRaw,
    refresh_token: refreshRaw,
    token_type: "bearer",
    expires_in: 3600,
    scope: accessToken.scopes.join(" "),
  });
}

async function handleRefresh(
  c: { json: (data: unknown, status?: number) => Response },
  body: Record<string, string>,
  storage: Storage,
  salt: string,
): Promise<Response> {
  const { refresh_token } = body;

  if (!refresh_token) {
    throw new MymeError(
      ErrorCode.VALIDATION_ERROR,
      "refresh_token is required",
    );
  }

  const refreshHash = hashApiKey(refresh_token, salt);
  const refreshRecord = await storage.oauth.validateToken(refreshHash);

  if (refreshRecord?.token_type !== "refresh") {
    throw new MymeError(ErrorCode.INVALID_GRANT, "Invalid refresh token");
  }

  // Mark refresh token as used (single-use rotation)
  const wasUnused = await storage.oauth.markRefreshUsed(refreshRecord.id);
  if (!wasUnused) {
    // Replay detected — revoke all tokens for this grant
    await storage.oauth.revokeGrantTokens(refreshRecord.connection_item_id);
    throw new MymeError(
      ErrorCode.TOKEN_REUSE_DETECTED,
      "Refresh token reuse detected, all tokens revoked",
    );
  }

  // Issue new token pair
  const accessRaw = generateToken(ACCESS_TOKEN_PREFIX);
  const newRefreshRaw = generateToken(REFRESH_TOKEN_PREFIX);
  const accessHash = hashApiKey(accessRaw, salt);
  const newRefreshHash = hashApiKey(newRefreshRaw, salt);
  const accessExpiresAt = new Date(
    Date.now() + ACCESS_TOKEN_TTL_MS,
  ).toISOString();
  const refreshExpiresAt = new Date(
    Date.now() + 90 * 24 * 3600_000,
  ).toISOString();

  const accessToken = await storage.oauth.createToken(
    refreshRecord.connection_item_id,
    accessHash,
    "access",
    accessExpiresAt,
  );
  await storage.oauth.createToken(
    refreshRecord.connection_item_id,
    newRefreshHash,
    "refresh",
    refreshExpiresAt,
  );

  return c.json({
    access_token: accessRaw,
    refresh_token: newRefreshRaw,
    token_type: "bearer",
    expires_in: 3600,
    scope: accessToken.scopes.join(" "),
  });
}
