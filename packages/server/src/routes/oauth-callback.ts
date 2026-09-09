/**
 * OAuth bootstrap routes.
 *
 * Two endpoints that complete the OAuth Authorization Code dance for
 * integration connections:
 *
 *   - `POST /connections/:id/oauth/start` (admin-gated): builds the
 *     upstream provider's authorize URL with a server-signed `state`
 *     param + the connection's stored client_id + this deployment's
 *     own callback URI. Returns the URL for the install script (or
 *     consent UI) to open in the user's browser.
 *
 *   - `GET /oauth/callback` (no auth — the provider's server-side
 *     redirect carries no Marfa session): verifies the state,
 *     exchanges the `code` for tokens at the provider's token
 *     endpoint, encrypts + persists them in
 *     `storage.connectionOauthTokens`, then renders an HTML success
 *     page.
 *
 * The callback is one fixed URL per deployment, `<base>/oauth/callback`,
 * and that is the whole of what an operator registers with an upstream
 * provider. It used to carry a `:provider` path segment, which meant
 * the server could not know its own redirect URI and took it from the
 * caller instead — a value only ever correct at one setting, and an
 * authorization-code interception hole at every other. The segment
 * carried nothing the callback does not already recover from the signed
 * state, so it went rather than being derived. Every provider a
 * deployment connects registers the same URL; the state envelope is what
 * tells them apart.
 *
 * The provider config (client_id, client_secret, token_url,
 * authorize_url) comes from the `system.credential` referenced by the
 * connection's `credential_ref`.
 *
 * Why this lives in routes/oauth-callback.ts (not in auth-pages.ts):
 * `auth-pages.ts` covers the Marfa-as-IdP surface (Better Auth + the
 * /auth/* routes for human sign-in + OAuth grants to apps). This
 * file covers Marfa-as-OAuth-client (the integration's outbound OAuth
 * flow). Different concern, different file.
 */
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { MarfaError, ErrorCode, type Item } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, requireSpacePermission } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { renderAuthLayout } from "./auth-layout.js";
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
import type { MarfaAuth } from "../auth/instance.js";
import { resolveSpaceCaller } from "./_space-caller.js";
import { escapeHtml, confirmIcon } from "./auth-html.js";

interface OAuthAuthorizeConfig {
  oauth_authorize_url: string;
  oauth_token_url: string;
  oauth_client_id: string;
  oauth_client_secret: string;
  /** The operator's own name for this upstream, from the credential row.
   *  Names the service on the success page, and rides the signed state so
   *  the callback can say it without a path segment to read it from. */
  label: string;
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
    label?: string;
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
    label:
      typeof credProps.label === "string" && credProps.label.length > 0
        ? credProps.label
        : "the other service",
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

/**
 * The two terminals a person lands on after authorizing an upstream
 * provider. Both render through the shared auth layout.
 *
 * They used to carry a hand-copied subset of `auth.css`, on the stated
 * grounds that they render outside `/auth/*` and so have no session. That
 * reasoning was wrong twice over: the stylesheet is a public asset that
 * needs no session, and a copy kept in sync by hand had already drifted to
 * light-only while the shared one had followed the device into dark mode
 * for months. Somebody finishing a connection at night got a white card.
 */
export function renderOAuthCallbackSuccess(provider: string): string {
  return renderAuthLayout({
    title: "Connection authorized",
    centered: true,
    bodyHtml: `
      ${confirmIcon("check")}
      <h1 class="title">Connection authorized</h1>
      <p class="sub" role="status">You are connected to <strong>${escapeHtml(provider)}</strong>. You can close this tab.</p>
    `,
  });
}

export function renderOAuthCallbackError(reason: string): string {
  return renderAuthLayout({
    title: "That didn't finish",
    centered: true,
    bodyHtml: `
      ${confirmIcon("alert")}
      <h1 class="title">That didn't finish</h1>
      <p class="sub" role="alert">The other service turned down the request, or it had already expired. Starting the connection again usually works.</p>
      <details class="disclosure">
        <summary><span class="disclosure__chevron" aria-hidden="true"></span> Details</summary>
        <pre>${escapeHtml(reason)}</pre>
      </details>
    `,
  });
}

export interface OAuthCallbackOptions {
  /** Override fetch — tests pass a deterministic stub. Defaults to
   *  globalThis.fetch. */
  fetch?: typeof fetch;
}

/**
 * Options for `oauthStartRoutes`.
 *
 * `authBaseUrl` — this deployment's own public base URL, from
 * `MARFA_AUTH_BASE_URL`. The redirect URI sent upstream is derived from
 * it, and is the only value that can ever be right: a provider honours a
 * redirect only against the URI registered with its own OAuth app, and
 * that URI is this server's callback.
 */
export interface OAuthStartOptions {
  authBaseUrl?: string;
  /** The identity layer, so the browser front door below can accept the
   *  session a person already has. */
  auth?: MarfaAuth;
}

/** The path the callback is mounted at, relative to the deployment root. */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

/**
 * This deployment's callback URI, which is what an operator registers with
 * an upstream provider and what every authorize request sends.
 *
 * A trailing slash on the configured base would produce a double slash,
 * which most providers compare as a different string from the one on file
 * and refuse. Cheap to normalize, expensive to diagnose.
 */
export function deriveOAuthCallbackUri(authBaseUrl: string): string {
  return `${authBaseUrl.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}`;
}

/**
 * Build the upstream authorize URL for a connection: signed state, PKCE
 * challenge, the credential's defaults, and this deployment's one callback
 * URI. Shared by the JSON start endpoint and the browser front door so the
 * two cannot construct different requests for the same connection.
 */
async function buildAuthorizeUrl(
  storage: Storage,
  connection: Item,
  connectionId: string,
  redirectUri: string,
  overrides: { scope?: string; extraParams?: Record<string, string> } = {},
): Promise<string> {
  const config = await readAuthorizeConfig(storage, connection);
  const scope =
    overrides.scope !== undefined && overrides.scope.length > 0
      ? overrides.scope
      : (config.oauth_default_scope ?? "");
  const codeVerifier = randomBytes(32).toString("base64url"); // 43 chars, within RFC 7636 §4.1 range
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const state = signOAuthState({
    connection_id: connectionId,
    redirect_uri: redirectUri,
    provider_label: config.label,
    code_verifier: codeVerifier,
  });
  const params = new URLSearchParams();
  if (scope.length > 0) params.set("scope", scope);
  // Credential defaults go first; caller overrides win per-key.
  if (config.authorize_extra_params) {
    for (const [k, v] of Object.entries(config.authorize_extra_params)) {
      params.set(k, v);
    }
  }
  for (const [k, v] of Object.entries(overrides.extraParams ?? {})) {
    params.set(k, v);
  }
  // The protocol parameters are set LAST, so no caller-supplied key can
  // overwrite one. Written the other way round, `extra_params` reached
  // `redirect_uri` and rewrote it after every check had passed — which is
  // how the allowlist this route used to carry could be walked straight
  // past by the sibling parameter it sat next to.
  params.set("response_type", "code");
  params.set("client_id", config.oauth_client_id);
  params.set("redirect_uri", redirectUri);
  params.set("state", state);
  params.set("code_challenge", codeChallenge);
  params.set("code_challenge_method", "S256");
  return `${config.oauth_authorize_url}?${params.toString()}`;
}

/**
 * `POST /connections/:id/oauth/start` — admin-gated. Returns the
 * upstream authorize URL (including signed state, PKCE challenge) the
 * install script or consent UI should open in the user's browser. Body:
 *   {
 *     scope?: string,          // overrides oauth_default_scope on the credential
 *     extra_params?: Record<string, string>  // e.g. {access_type: "offline", prompt: "consent"}
 *   }
 *
 * Every flow includes `code_challenge` + `code_challenge_method=S256`. The
 * verifier is generated server-side and stored in the encrypted state
 * envelope; the callback exchanges it at the token endpoint. There is no
 * non-PKCE path — the integration OAuth bootstrap requires it unconditionally.
 */
export function oauthStartRoutes(
  storage: Storage,
  options: OAuthStartOptions = {},
) {
  const redirectUri = deriveOAuthCallbackUri(options.authBaseUrl ?? "");
  const r = new Hono<AppEnv>();
  r.post("/:id/oauth/start", async (c) => {
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.credentials");
    // No integration arm on this door: it starts the upstream OAuth dance and
    // takes a caller-supplied scope override into the authorize URL, so it is
    // a credentials surface reached on rank and nothing else.
    requireSpacePermission(c, "space.credentials");
    const connectionId = c.req.param("id");
    // Fenced on the caller's space. Holding `space.credentials` confers no
    // cross-space reach: a credential carrying a `space_id` is confined to it
    // however much of that space it administers, and `POST
    // /admin/spaces/{id}/keys` mints exactly that shape — bound to one space,
    // `is_operator: false`, holding every space permission inside it. An
    // unfenced lookup here would let such a key start an OAuth flow against
    // another space's connection, and the signed state binds the connection
    // id, so the callback would persist the resulting tokens onto that
    // connection.
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
      scope?: unknown;
      extra_params?: unknown;
    } = await c.req.json();
    const overrides: { scope?: string; extraParams?: Record<string, string> } =
      {};
    if (typeof body.scope === "string") overrides.scope = body.scope;
    if (
      typeof body.extra_params === "object" &&
      body.extra_params !== null &&
      !Array.isArray(body.extra_params)
    ) {
      const extra: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        body.extra_params as Record<string, unknown>,
      )) {
        if (typeof v === "string") extra[k] = v;
      }
      overrides.extraParams = extra;
    }
    const authorize_url = await buildAuthorizeUrl(
      storage,
      connection,
      connectionId,
      redirectUri,
      overrides,
    );
    return c.json(
      {
        authorize_url,
        connection_id: connectionId,
        // Echoed so an operator setting a provider up can read the exact
        // string to register rather than assembling it from a base URL and
        // a path, which is the step that produces a mismatch.
        redirect_uri: redirectUri,
        expires_in_seconds: Math.floor(DEFAULT_STATE_TTL_MS / 1000),
      },
      200,
    );
  });

  /**
   * `GET /connections/:id/oauth/start` — the same flow as a front door.
   *
   * The POST above answers with a URL, which is right for a script and wrong
   * for a person: it needs a caller that can read JSON and then navigate,
   * which a browser following a link is not. This redirects straight to the
   * provider, so the consent screen and the configuration surface can link to
   * authorization rather than describing it.
   *
   * It takes no parameters. Everything the POST accepts is either the
   * credential's own configuration or a caller override, and a front door
   * reachable by following a link should not let the link decide what is
   * asked for.
   */
  r.get("/:id/oauth/start", async (c) => {
    const caller = await resolveSpaceCaller(
      c,
      storage,
      options.auth,
      "Starting an OAuth connection needs `space.credentials`.",
      "space.credentials",
    );
    if (caller instanceof Response) return caller;
    const connectionId = c.req.param("id");
    const connection = await storage.items.get(connectionId, caller.spaceId);
    if (connection?.type !== "system.connection") {
      throw new MarfaError(
        ErrorCode.ITEM_NOT_FOUND,
        `Connection ${connectionId} not found`,
      );
    }
    const authorizeUrl = await buildAuthorizeUrl(
      storage,
      connection,
      connectionId,
      redirectUri,
    );
    // No-store: the URL carries a one-shot signed state and a PKCE
    // challenge, so a cached redirect sends a second visitor into a flow
    // whose verifier belongs to the first.
    setNoStore(c);
    return c.redirect(authorizeUrl, 302);
  });
  return r;
}

/**
 * `GET /oauth/callback` — no auth. The provider's redirect carries no
 * Marfa session; we trust the signed `state` param to recover the
 * connection, and everything else follows from it.
 *
 * Query params: `code`, `state`, optional `error` (RFC 6749 §4.1.2.1).
 *
 * On success: persists tokens via `storage.connectionOauthTokens.upsert`
 * (encrypted under SECRET_INFO.connectionOauthToken) and returns an
 * HTML success page.
 *
 * Errors raised before the state verifies cannot name the upstream,
 * because at that point nothing has told us which one it was. The page
 * says so rather than inventing a name.
 */
const UNVERIFIED_PROVIDER = "the other service";

export function oauthCallbackRoutes(
  storage: Storage,
  options: OAuthCallbackOptions = {},
) {
  // Resolve per-request so test stubs of globalThis.fetch take effect.
  const resolveFetch = (): typeof fetch =>
    options.fetch ?? globalThis.fetch.bind(globalThis);
  const r = new Hono<AppEnv>();
  r.get("/", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const upstreamError = c.req.query("error");

    // Read the state before branching, so every audit row below names the
    // connection this callback is about. With no provider segment in the
    // path there is nothing else to identify a failure by, and the segment
    // never identified much anyway: it named a vendor, not an attempt.
    const preview =
      typeof state === "string" ? verifyOAuthState(state) : undefined;
    const attemptId = preview?.ok
      ? preview.envelope.connection_id
      : "unverified";
    const provider = preview?.ok
      ? (preview.envelope.provider_label ?? UNVERIFIED_PROVIDER)
      : UNVERIFIED_PROVIDER;

    if (typeof upstreamError === "string" && upstreamError.length > 0) {
      const desc = c.req.query("error_description") ?? "";
      const reason = `${provider} returned error=${upstreamError}${desc ? `: ${desc}` : ""}`;
      void storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        space_id: c.get("apiKey")?.space_id ?? null,
        action: "oauth_callback.upstream_error",
        resource_type: "oauth_callback",
        resource_id: attemptId,
        details: { error: upstreamError, error_description: desc },
      });
      setNoStore(c);
      return c.html(renderOAuthCallbackError(reason), 400);
    }

    if (typeof code !== "string" || typeof state !== "string") {
      setNoStore(c);
      return c.html(
        renderOAuthCallbackError("Missing code or state query param"),
        400,
      );
    }
    const stateResult = preview ?? verifyOAuthState(state);
    if (!stateResult.ok) {
      void storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        space_id: c.get("apiKey")?.space_id ?? null,
        action: "oauth_callback.state_invalid",
        resource_type: "oauth_callback",
        resource_id: attemptId,
        details: { reason: stateResult.reason },
      });
      setNoStore(c);
      return c.html(
        renderOAuthCallbackError(
          `State validation failed: ${stateResult.reason}`,
        ),
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
        renderOAuthCallbackError(
          `Connection ${envelope.connection_id} not found`,
        ),
        404,
      );
    }
    let config: OAuthAuthorizeConfig;
    try {
      config = await readAuthorizeConfig(storage, connection);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setNoStore(c);
      return c.html(renderOAuthCallbackError(reason), 400);
    }

    // Missing verifier means hostile state or stale code path — refuse rather than attempt non-PKCE exchange.
    if (typeof envelope.code_verifier !== "string") {
      void storage.audit.log({
        client_ip: c.get("clientIp") ?? null,
        space_id: c.get("apiKey")?.space_id ?? null,
        action: "oauth_callback.state_missing_pkce",
        resource_type: "oauth_callback",
        resource_id: envelope.connection_id,
        details: { connection_id: envelope.connection_id },
      });
      setNoStore(c);
      return c.html(
        renderOAuthCallbackError(
          "This connection request expired or was already used. Start connecting again.",
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
      return c.html(renderOAuthCallbackError(exchange.reason), 502);
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
      details: { provider: config.label, scopes: exchange.scopes },
    });
    setNoStore(c);
    return c.html(renderOAuthCallbackSuccess(config.label), 200);
  });
  return r;
}
