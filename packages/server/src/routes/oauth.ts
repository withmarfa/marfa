import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  ProtocolError,
  ErrorCode,
  parseScope,
  expandWildcardScopes,
  TYPE_REGISTRY,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin, requireAuth, hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { renderConsentScreen } from "./consent.js";

const ACCESS_TOKEN_PREFIX = "myme_at_";
const REFRESH_TOKEN_PREFIX = "myme_rt_";
const ACCESS_TOKEN_TTL_MS = 3600_000; // 1 hour
const CODE_TTL_MS = 600_000; // 10 minutes

function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function authRoutes(storage: Storage, salt: string): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const knownTypes = Array.from(TYPE_REGISTRY.keys());

  // -----------------------------------------------------------------------
  // Client registration
  // -----------------------------------------------------------------------

  router.post("/clients", async (c) => {
    requireAdmin(c);
    const body = await c.req.json();
    if (!body.name || !body.redirect_uris?.length) {
      throw new ProtocolError(
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
    requireAdmin(c);

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
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "Missing required parameters: client_id, response_type=code, scope, redirect_uri, code_challenge",
      );
    }
    if (codeChallengeMethod && codeChallengeMethod !== "S256") {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "Only S256 code_challenge_method is supported",
      );
    }

    const client = await storage.oauth.getClient(clientId);
    if (!client) {
      throw new ProtocolError(ErrorCode.INVALID_CLIENT, "Unknown client_id");
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "redirect_uri not registered for this client",
      );
    }

    // Parse and expand scopes
    const requestedScopes = scope.split(" ");
    const expanded = expandWildcardScopes(requestedScopes, knownTypes);
    const parsed = expanded.map(parseScope).filter((s) => s !== null);

    if (parsed.length === 0) {
      throw new ProtocolError(
        ErrorCode.INVALID_SCOPE,
        "No valid scopes in request",
      );
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
    });

    return c.html(html);
  });

  router.post("/authorize", async (c) => {
    requireAdmin(c);

    const formData = await c.req.parseBody();
    const action = formData.action as string;
    const clientId = formData.client_id as string;
    const redirectUri = formData.redirect_uri as string;
    const codeChallenge = formData.code_challenge as string;
    const codeChallengeMethod =
      (formData.code_challenge_method as string) || "S256";
    const state = (formData.state as string) || "";

    if (!clientId || !redirectUri || !codeChallenge) {
      throw new ProtocolError(
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
      throw new ProtocolError(
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

    throw new ProtocolError(
      ErrorCode.VALIDATION_ERROR,
      "Unsupported grant_type",
    );
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
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "scopes is required");
    }
    await storage.oauth.reduceTokenScope(c.req.param("id"), body.scopes);
    return c.json({ status: "ok" });
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
    throw new ProtocolError(
      ErrorCode.VALIDATION_ERROR,
      "code, code_verifier, and redirect_uri are required",
    );
  }

  const codeHash = hashApiKey(code, salt);
  const codeRecord = await storage.oauth.consumeCode(codeHash);

  if (!codeRecord) {
    throw new ProtocolError(
      ErrorCode.INVALID_GRANT,
      "Invalid, expired, or already-used authorization code",
    );
  }

  // Verify redirect_uri matches
  if (codeRecord.redirect_uri !== redirect_uri) {
    throw new ProtocolError(
      ErrorCode.VALIDATION_ERROR,
      "redirect_uri does not match",
    );
  }

  // PKCE verification: SHA256(code_verifier) must equal code_challenge
  const computedChallenge = sha256(code_verifier);
  if (computedChallenge !== codeRecord.code_challenge) {
    throw new ProtocolError(
      ErrorCode.INVALID_GRANT,
      "PKCE verification failed",
    );
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
    codeRecord.grant_id,
    accessHash,
    "access",
    accessExpiresAt,
  );
  await storage.oauth.createToken(
    codeRecord.grant_id,
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
    throw new ProtocolError(
      ErrorCode.VALIDATION_ERROR,
      "refresh_token is required",
    );
  }

  const refreshHash = hashApiKey(refresh_token, salt);
  const refreshRecord = await storage.oauth.validateToken(refreshHash);

  if (refreshRecord?.token_type !== "refresh") {
    throw new ProtocolError(ErrorCode.INVALID_GRANT, "Invalid refresh token");
  }

  // Mark refresh token as used (single-use rotation)
  const wasUnused = await storage.oauth.markRefreshUsed(refreshRecord.id);
  if (!wasUnused) {
    // Replay detected — revoke all tokens for this grant
    await storage.oauth.revokeGrantTokens(refreshRecord.grant_id);
    throw new ProtocolError(
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
    refreshRecord.grant_id,
    accessHash,
    "access",
    accessExpiresAt,
  );
  await storage.oauth.createToken(
    refreshRecord.grant_id,
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
