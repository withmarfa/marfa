/**
 * OAuth bootstrap routes.
 *
 * Two endpoints that complete the OAuth Authorization Code dance for
 * connector connections:
 *
 *   - `POST /connections/:id/oauth/start` (admin-gated): builds the
 *     upstream provider's authorize URL with a server-signed `state`
 *     param + the connection's stored client_id + the configured
 *     redirect URI. Returns the URL for the install script (or
 *     consent UI) to open in the user's browser.
 *
 *   - `GET /oauth/callback/:provider` (no auth — the provider's
 *     server-side redirect carries no Marfa session): verifies the
 *     state, exchanges the `code` for tokens at the provider's
 *     token endpoint, encrypts + persists them in
 *     `storage.connectionOauthTokens`, then renders an HTML success
 *     page (or, if the start request specified one, redirects to a
 *     post-install URL).
 *
 * The route is provider-agnostic: the `:provider` path segment is
 * informational (audit logs, the success page's wording). The actual
 * provider config (client_id, client_secret, token_url, authorize_url)
 * comes from the `system.credential` referenced by the connection's
 * `credential_ref`. Calendar uses `/oauth/callback/google`; future
 * connectors use their own paths but share this route.
 *
 * Why this lives in routes/oauth-callback.ts (not in auth-pages.ts):
 * `auth-pages.ts` covers the Marfa-as-IdP surface (Better Auth + the
 * /auth/* routes for human sign-in + OAuth grants to apps). This
 * file covers Marfa-as-OAuth-client (the connector's outbound OAuth
 * flow). Different concern, different file.
 */
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { MarfaError, ErrorCode, type Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, hasSpaceAdminAuthority } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  encryptSecret,
  decryptSecret,
  SECRET_INFO,
} from "../crypto/secret-encryption.js";
import {
  signOAuthState,
  verifyOAuthState,
  DEFAULT_STATE_TTL_MS,
  type OAuthStateEnvelope,
} from "../oauth/state.js";
import { setNoStore } from "./no-store.js";
import { escapeHtml } from "./auth-html.js";

interface OAuthAuthorizeConfig {
  oauth_authorize_url: string;
  oauth_token_url: string;
  oauth_client_id: string;
  oauth_client_secret: string;
  /** Comma-separated default scopes to request when the start request
   *  doesn't override. */
  oauth_default_scope: string | null;
  /** Provider-specific authorize-URL hints baked into the credential —
   *  e.g. `{ access_type: "offline", prompt: "consent" }` for Google to
   *  guarantee a `refresh_token` on the code exchange. Merged into the
   *  authorize URL on `/oauth/start`; the caller's `extra_params` overrides
   *  per-key. `null` when the credential has no defaults declared. */
  authorize_extra_params: Record<string, string> | null;
}

/**
 * Resolve the OAuth client config from the connection's
 * credential_ref. Reads the broader provider config (authorize_url,
 * scope) needed to BUILD the authorize URL — the existing
 * `readOAuthConfig` in connection-proxy reads only the subset needed
 * to USE the access token. Both pull from the same
 * `system.credential` row.
 */
async function readAuthorizeConfig(
  storage: Storage,
  connection: Item,
): Promise<OAuthAuthorizeConfig> {
  const props = connection.properties as { credential_ref?: string };
  const credentialRef = props.credential_ref;
  if (!credentialRef) {
    throw new MarfaError(
      ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID,
      "Connection has no credential_ref — cannot start OAuth flow",
    );
  }
  // Fence the credential lookup by the connection's space_id — defense-in-depth
  // against a cross-space credential_ref that bypassed the install-pipeline check.
  const credential = await storage.items.get(
    credentialRef,
    connection.space_id ?? undefined,
  );
  if (credential?.type !== "system.credential") {
    throw new MarfaError(
      ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID,
      `Connection's credential_ref ${credentialRef} does not resolve to a system.credential item`,
    );
  }
  const credProps = credential.properties as {
    kind?: string;
    oauth_provider_config?: {
      oauth_authorize_url?: string;
      oauth_token_url?: string;
      oauth_client_id?: string;
      oauth_default_scope?: string;
      authorize_extra_params?: Record<string, string>;
    };
    secret_encrypted?: string;
  };
  const cfg = credProps.oauth_provider_config;
  if (
    credProps.kind !== "oauth_token" ||
    typeof cfg?.oauth_authorize_url !== "string" ||
    typeof cfg.oauth_token_url !== "string" ||
    typeof cfg.oauth_client_id !== "string" ||
    typeof credProps.secret_encrypted !== "string"
  ) {
    throw new MarfaError(
      ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID,
      "Connection's credential is missing required OAuth provider config (kind:oauth_token + oauth_authorize_url + oauth_token_url + oauth_client_id + secret_encrypted)",
    );
  }
  // Validate shape — a malformed JSON value on the credential row would otherwise stringify as "undefined".
  let authorize_extra_params: Record<string, string> | null = null;
  if (
    cfg.authorize_extra_params &&
    typeof cfg.authorize_extra_params === "object" &&
    !Array.isArray(cfg.authorize_extra_params)
  ) {
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.authorize_extra_params)) {
      if (typeof v === "string") filtered[k] = v;
    }
    if (Object.keys(filtered).length > 0) authorize_extra_params = filtered;
  }
  return {
    oauth_authorize_url: cfg.oauth_authorize_url,
    oauth_token_url: cfg.oauth_token_url,
    oauth_client_id: cfg.oauth_client_id,
    oauth_client_secret: decryptSecret(
      credProps.secret_encrypted,
      SECRET_INFO.connectionOauthToken,
    ),
    oauth_default_scope: cfg.oauth_default_scope ?? null,
    authorize_extra_params,
  };
}

interface TokenExchangeResult {
  ok: true;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  scopes: string[];
}

interface TokenExchangeFailed {
  ok: false;
  status: number;
  reason: string;
}

async function exchangeAuthorizationCode(
  config: OAuthAuthorizeConfig,
  redirectUri: string,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch,
): Promise<TokenExchangeResult | TokenExchangeFailed> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.oauth_client_id,
    client_secret: config.oauth_client_secret,
    code_verifier: codeVerifier,
  });
  let resp: Response;
  try {
    resp = await fetchImpl(config.oauth_token_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: `Token endpoint request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!resp.ok) {
    let upstreamMsg = "";
    try {
      upstreamMsg = await resp.text();
    } catch {
      // body unreadable — surface the status alone
    }
    return {
      ok: false,
      status: resp.status,
      reason: `Upstream returned ${String(resp.status)}: ${upstreamMsg.slice(0, 300)}`,
    };
  }
  let payload: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  try {
    payload = (await resp.json()) as typeof payload;
  } catch {
    return {
      ok: false,
      status: resp.status,
      reason: "Upstream token response was not JSON",
    };
  }
  if (typeof payload.access_token !== "string") {
    return {
      ok: false,
      status: resp.status,
      reason: "Upstream token response missing access_token",
    };
  }
  const expiresIn =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const scopes =
    typeof payload.scope === "string"
      ? payload.scope.split(/\s+/).filter(Boolean)
      : [];
  return {
    ok: true,
    access_token: payload.access_token,
    refresh_token:
      typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    expires_at: expiresAt,
    scopes,
  };
}

/* Standalone monochrome "Luma" card — these callback pages render outside
   the /auth/* layout (no session), so they carry their own minimal styles
   matching auth.css. Light-only. */
const CALLBACK_CSS = `
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:40px 20px;background:#f5f5f5;color:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:440px;background:#fff;border:1px solid #e5e5e5;border-radius:18px;padding:28px;box-shadow:0 1px 2px rgba(10,10,10,.04),0 8px 28px rgba(10,10,10,.06)}
  h1{margin:0 0 8px;font-size:20px;font-weight:600;letter-spacing:-.02em}
  p{margin:0 0 10px;color:#737373}
  p:last-child{margin-bottom:0}
  p strong{color:#0a0a0a;font-weight:600}
  .ref{margin-top:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#a3a3a3;word-break:break-all}
  pre{margin:10px 0 0;padding:12px 14px;background:#f5f5f5;border:1px solid #e5e5e5;border-radius:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:#0a0a0a;white-space:pre-wrap;word-break:break-word}
`;

function renderSuccessPage(provider: string, connectionId: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connection authorized</title>
    <style>${CALLBACK_CSS}</style>
  </head>
  <body>
    <main class="card">
      <h1>Connection authorized</h1>
      <p>This connection is now connected to <strong>${escapeHtml(provider)}</strong>. You can close this tab.</p>
      <p class="ref">${escapeHtml(connectionId)}</p>
    </main>
  </body>
</html>`;
}

function renderErrorPage(reason: string, status: number): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Couldn't complete sign-in</title>
    <style>${CALLBACK_CSS}</style>
  </head>
  <body>
    <main class="card">
      <h1>Couldn't complete sign-in</h1>
      <p>The provider redirected back with an error, or the request had expired. Try connecting again.</p>
      <pre>${escapeHtml(reason)}</pre>
      <p class="ref">Status ${String(status)}</p>
    </main>
  </body>
</html>`;
}

export interface OAuthCallbackOptions {
  /** Override fetch — tests pass a deterministic stub. Defaults to
   *  globalThis.fetch. */
  fetch?: typeof fetch;
}

/**
 * Options for `oauthStartRoutes`.
 *
 * `redirectUriAllowlist` — list of redirect_uri values that callers may
 * pass on `POST /connections/:id/oauth/start`. When non-empty, the
 * request's `redirect_uri` must match one entry exactly (string equality
 * after both sides are URL-canonicalized — protocol, host, port, path).
 *
 * `authMode` — the deployment's auth mode. Decides how an EMPTY allowlist
 * is treated:
 *   - `hosted` → fail closed. An empty allowlist rejects every
 *     `redirect_uri`, because an admin-level caller on a multi-space
 *     deployment could otherwise point a connector's authorization code at
 *     an attacker-controlled redirect (authorization-code interception). The
 *     operator MUST set `MARFA_OAUTH_REDIRECT_ALLOWLIST`.
 *   - `keys` → unenforced passthrough. Single-space self-hosts run with no
 *     allowlist by default; the caller is the operator, so there's no
 *     attacker to intercept the code, and forcing the allowlist would break
 *     the out-of-the-box flow.
 * A non-empty allowlist enforces exact/canonical match in both modes.
 */
export interface OAuthStartOptions {
  redirectUriAllowlist?: readonly string[];
  authMode?: "hosted" | "keys";
}

function canonicalizeRedirect(uri: string): string {
  try {
    const url = new URL(uri);
    url.hash = "";
    url.search = "";
    let normalized = url.toString();
    if (normalized.endsWith("/") && url.pathname === "/") {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return uri;
  }
}

function isRedirectAllowed(
  candidate: string,
  allowlist: readonly string[] | undefined,
  authMode: "hosted" | "keys",
): boolean {
  if (!allowlist || allowlist.length === 0) {
    // Empty allowlist: fail closed on hosted (an unset allowlist on a
    // multi-space deployment is an open-redirect / authorization-code
    // interception hole), passthrough on keys-mode self-host (single
    // operator, no attacker, allowlist optional for convenience).
    return authMode !== "hosted";
  }
  const c = canonicalizeRedirect(candidate);
  return allowlist.some((entry) => canonicalizeRedirect(entry) === c);
}

/**
 * `POST /connections/:id/oauth/start` — admin-gated. Returns the
 * upstream authorize URL (including signed state, PKCE challenge) the
 * install script or consent UI should open in the user's browser. Body:
 *   {
 *     redirect_uri: string,    // exactly the URI registered with the provider
 *     scope?: string,          // overrides oauth_default_scope on the credential
 *     extra_params?: Record<string, string>  // e.g. {access_type: "offline", prompt: "consent"}
 *   }
 *
 * Every flow includes `code_challenge` + `code_challenge_method=S256`. The
 * verifier is generated server-side and stored in the encrypted state
 * envelope; the callback exchanges it at the token endpoint. There is no
 * non-PKCE path — the connector OAuth bootstrap requires it unconditionally.
 */
export function oauthStartRoutes(
  storage: Storage,
  options: OAuthStartOptions = {},
) {
  const authMode = options.authMode ?? "keys";
  const r = new Hono<AppEnv>();
  r.post("/:id/oauth/start", async (c) => {
    const apiKey = requireAuth(c);
    if (!hasSpaceAdminAuthority(apiKey) && !apiKey.is_platform) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "OAuth start requires admin or platform credential",
      );
    }
    const connectionId = c.req.param("id");
    // Fenced on the caller's space. Rank alone does not confer
    // cross-space reach: a credential carrying a `space_id` is confined
    // to it whatever its role, and `POST /admin/spaces/{id}/keys` mints
    // exactly that shape at `role: "admin"`. An unfenced lookup here
    // would let such a key start an OAuth flow against another space's
    // connection, and the signed state binds the connection id — so the
    // callback would persist the resulting tokens onto that connection.
    const connection = await storage.items.get(
      connectionId,
      apiKey.space_id ?? undefined,
    );
    if (connection?.type !== "system.connection") {
      throw new MarfaError(
        ErrorCode.ITEM_NOT_FOUND,
        `Connection ${connectionId} not found`,
      );
    }
    const body: {
      redirect_uri?: unknown;
      scope?: unknown;
      extra_params?: unknown;
    } = await c.req.json();
    if (
      typeof body.redirect_uri !== "string" ||
      body.redirect_uri.length === 0
    ) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "redirect_uri is required",
      );
    }
    if (
      !isRedirectAllowed(
        body.redirect_uri,
        options.redirectUriAllowlist,
        authMode,
      )
    ) {
      const allowlistEmpty =
        !options.redirectUriAllowlist ||
        options.redirectUriAllowlist.length === 0;
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        allowlistEmpty
          ? `redirect_uri "${body.redirect_uri}" rejected: MARFA_OAUTH_REDIRECT_ALLOWLIST is empty and hosted mode fails closed. Set MARFA_OAUTH_REDIRECT_ALLOWLIST to the allowed redirect URIs.`
          : `redirect_uri "${body.redirect_uri}" is not in MARFA_OAUTH_REDIRECT_ALLOWLIST`,
      );
    }
    const config = await readAuthorizeConfig(storage, connection);
    const scope =
      typeof body.scope === "string" && body.scope.length > 0
        ? body.scope
        : (config.oauth_default_scope ?? "");
    const codeVerifier = randomBytes(32).toString("base64url"); // 43 chars, within RFC 7636 §4.1 range
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const state = signOAuthState({
      connection_id: connectionId,
      redirect_uri: body.redirect_uri,
      code_verifier: codeVerifier,
    });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.oauth_client_id,
      redirect_uri: body.redirect_uri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    if (scope.length > 0) params.set("scope", scope);
    // Credential defaults go first; caller's extra_params override per-key.
    if (config.authorize_extra_params) {
      for (const [k, v] of Object.entries(config.authorize_extra_params)) {
        params.set(k, v);
      }
    }
    if (
      typeof body.extra_params === "object" &&
      body.extra_params !== null &&
      !Array.isArray(body.extra_params)
    ) {
      for (const [k, v] of Object.entries(
        body.extra_params as Record<string, unknown>,
      )) {
        if (typeof v === "string") params.set(k, v);
      }
    }
    const authorize_url = `${config.oauth_authorize_url}?${params.toString()}`;
    return c.json(
      {
        authorize_url,
        connection_id: connectionId,
        expires_in_seconds: Math.floor(DEFAULT_STATE_TTL_MS / 1000),
      },
      200,
    );
  });
  return r;
}

/**
 * `GET /oauth/callback/:provider` — no auth. The provider's
 * redirect carries no Marfa session; we trust the signed `state`
 * param to recover the connection.
 *
 * Query params: `code`, `state`, optional `error` (RFC 6749 §4.1.2.1).
 *
 * On success: persists tokens via `storage.connectionOauthTokens.upsert`
 * (encrypted under SECRET_INFO.connectionOauthToken) and returns an
 * HTML success page.
 */
export function oauthCallbackRoutes(
  storage: Storage,
  options: OAuthCallbackOptions = {},
) {
  // Resolve per-request so test stubs of globalThis.fetch take effect.
  const resolveFetch = (): typeof fetch =>
    options.fetch ?? globalThis.fetch.bind(globalThis);
  const r = new Hono<AppEnv>();
  r.get("/:provider", async (c) => {
    const provider = c.req.param("provider");
    const code = c.req.query("code");
    const state = c.req.query("state");
    const upstreamError = c.req.query("error");

    if (typeof upstreamError === "string" && upstreamError.length > 0) {
      const desc = c.req.query("error_description") ?? "";
      const reason = `${provider} returned error=${upstreamError}${desc ? `: ${desc}` : ""}`;
      void storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        space_id: c.get("apiKey")?.space_id ?? null,
        action: "oauth_callback.upstream_error",
        resource_type: "oauth_callback",
        resource_id: provider,
        details: { error: upstreamError, error_description: desc },
      });
      setNoStore(c);
      return c.html(renderErrorPage(reason, 400), 400);
    }

    if (typeof code !== "string" || typeof state !== "string") {
      setNoStore(c);
      return c.html(
        renderErrorPage("Missing code or state query param", 400),
        400,
      );
    }
    const stateResult = verifyOAuthState(state);
    if (!stateResult.ok) {
      void storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        space_id: c.get("apiKey")?.space_id ?? null,
        action: "oauth_callback.state_invalid",
        resource_type: "oauth_callback",
        resource_id: provider,
        details: { reason: stateResult.reason },
      });
      setNoStore(c);
      return c.html(
        renderErrorPage(`State validation failed: ${stateResult.reason}`, 400),
        400,
      );
    }
    const envelope: OAuthStateEnvelope = stateResult.envelope;

    // Re-resolve the connection + its credential each callback —
    // the credential could have rotated client_secret since the
    // start route ran.
    const connection = await storage.items.get(envelope.connection_id);
    if (connection?.type !== "system.connection") {
      setNoStore(c);
      return c.html(
        renderErrorPage(`Connection ${envelope.connection_id} not found`, 404),
        404,
      );
    }
    let config: OAuthAuthorizeConfig;
    try {
      config = await readAuthorizeConfig(storage, connection);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setNoStore(c);
      return c.html(renderErrorPage(reason, 400), 400);
    }

    // Missing verifier means hostile state or stale code path — refuse rather than attempt non-PKCE exchange.
    if (typeof envelope.code_verifier !== "string") {
      void storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        space_id: c.get("apiKey")?.space_id ?? null,
        action: "oauth_callback.state_missing_pkce",
        resource_type: "oauth_callback",
        resource_id: provider,
        details: { connection_id: envelope.connection_id },
      });
      setNoStore(c);
      return c.html(
        renderErrorPage(
          "This connection request expired or was already used. Start connecting again.",
          400,
        ),
        400,
      );
    }
    const exchange = await exchangeAuthorizationCode(
      config,
      envelope.redirect_uri,
      code,
      envelope.code_verifier,
      resolveFetch(),
    );
    if (!exchange.ok) {
      void storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        space_id: c.get("apiKey")?.space_id ?? null,
        action: "oauth_callback.exchange_failed",
        resource_type: "connection",
        resource_id: envelope.connection_id,
        details: { reason: exchange.reason, status: exchange.status },
      });
      setNoStore(c);
      return c.html(
        renderErrorPage(exchange.reason, exchange.status || 502),
        502,
      );
    }

    // The connection's space comes from its row column, never from its
    // properties bag — no writer of a `system.connection` puts a
    // `space_id` there, so reading it that way always yielded
    // `undefined` and persisted the upstream access and refresh tokens
    // with a NULL space. The `connection_oauth_tokens` RLS policy admits
    // NULL rows into every space's session, so those secrets were
    // readable instance-wide, and the space-scoped read path in the
    // proxy could not find them at all.
    const spaceId = connection.space_id ?? undefined;
    await storage.connectionOauthTokens.upsert({
      connection_id: envelope.connection_id,
      space_id: spaceId,
      access_token_encrypted: encryptSecret(
        exchange.access_token,
        SECRET_INFO.connectionOauthToken,
      ),
      refresh_token_encrypted:
        exchange.refresh_token !== null
          ? encryptSecret(
              exchange.refresh_token,
              SECRET_INFO.connectionOauthToken,
            )
          : null,
      expires_at: exchange.expires_at,
      scopes: exchange.scopes,
      previous_refresh_hash: null,
    });
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      action: "oauth_callback.tokens_stored",
      resource_type: "connection",
      resource_id: envelope.connection_id,
      details: { provider, scopes: exchange.scopes },
    });
    setNoStore(c);
    return c.html(renderSuccessPage(provider, envelope.connection_id), 200);
  });
  return r;
}
