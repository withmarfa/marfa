import { Hono } from "hono";
import { createHash } from "node:crypto";
import {
  MarfaError,
  ErrorCode,
  generateId,
  type Item,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  encryptSecret,
  decryptSecret,
  SECRET_INFO,
} from "../crypto/secret-encryption.js";

// ---------------------------------------------------------------------------
// Connection OAuth proxy
//
// `POST /connections/:id/proxy/*` — let a connector (or a tenant admin)
// make an outbound HTTP call to an external service through a single
// server-side path that:
//   1. Decrypts the connection's stored access_token and stamps it as
//      `Authorization: Bearer <access_token>` on the outbound request.
//   2. On a 401-from-upstream, single-flight-refreshes the access token
//      (exchange refresh_token via the OAuth provider's token endpoint),
//      retries the original request once.
//   3. On terminal refresh failure (`invalid_grant` or no refresh token),
//      flips the connection's `runtime_status` to `reauth_required` and
//      emits a `system.activity` row with severity `action_required` so
//      the user surface knows to prompt for re-authorisation.
//   4. Rotates the refresh_token whenever the upstream returns a new one;
//      the rotated-out token's SHA-256 is written to
//      `previous_refresh_hash` for forensic logging.
//   5. Audits every call (success and failure) regardless of outcome.
//
// All HTTP verbs route through here — proxies have to be method-agnostic.
// The OpenAPI spec deliberately omits this route; the upstream's schema
// is unknown at our layer, so a placeholder doc would be misleading.
// ---------------------------------------------------------------------------

interface OAuthConfig {
  kind: "oauth_token";
  upstream_base_url: string;
  oauth_token_url: string;
  oauth_client_id: string;
  /** Plaintext client_secret. */
  oauth_client_secret: string;
}

/**
 * HTTP Authorization scheme stamped on `kind:api_token` proxy calls.
 * Most modern APIs use `Bearer`; Readwise's REST API requires `Token`;
 * `Basic` is included for upstreams that present the token as a
 * basic-auth password.
 */
type ApiTokenAuthScheme = "Bearer" | "Token" | "Basic";

interface ApiTokenConfig {
  kind: "api_token";
  upstream_base_url: string;
  /** Plaintext bearer token. */
  bearer_token: string;
  /** HTTP Authorization scheme to stamp; default `Bearer` when absent
   *  on the underlying credential. Set on api_token credentials at
   *  mint time via `POST /credentials/api-token { auth_scheme: ... }`. */
  auth_scheme: ApiTokenAuthScheme;
}

type CredentialConfig = OAuthConfig | ApiTokenConfig;

/**
 * Read the upstream + secret config for a Connection.
 *
 * The connection must reference a `system.credential` item via
 * `properties.credential_ref`. Two credential kinds are accepted,
 * returned as a discriminated union:
 *
 *   - **`kind: "oauth_token"`** — `oauth_provider_config` carries the
 *     non-secret OAuth fields (`upstream_base_url`, `oauth_token_url`,
 *     `oauth_client_id`); `secret_encrypted` holds the encrypted
 *     client secret. The proxy uses this shape to refresh access
 *     tokens against `oauth_token_url`.
 *   - **`kind: "api_token"`** — `api_token_config` carries just
 *     `upstream_base_url`; `secret_encrypted` holds the bearer token
 *     directly. The proxy stamps the bearer verbatim — there is no
 *     refresh URL because static tokens have no refresh primitive.
 *
 * Both shapes encrypt under the `connectionOauthToken` HKDF domain.
 *
 * The connection must have a `credential_ref` — all connections
 * installed via the current pipeline do. Connections without one
 * are rejected with OAUTH_PROXY_UPSTREAM_INVALID.
 */
async function readCredentialConfig(
  storage: Storage,
  connection: Item,
): Promise<CredentialConfig> {
  // Connection must reference a `system.credential` row via
  // `properties.credential_ref`. All connections installed via the
  // current pipeline have this field; reject anything without it.
  const props = connection.properties as { credential_ref?: string };
  const credentialRef = props.credential_ref;
  if (!credentialRef) {
    throw new MarfaError(
      ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID,
      `Connection ${connection.id} has no credential_ref. Install the connection via /integrations/:id/install or move its inline OAuth config to a system.credential item.`,
    );
  }
  // Thread the connection's tenant into the credential lookup.
  // The install pipeline already validates `credentialRef` is in the
  // caller's tenant before stamping it onto the connection, so any
  // legitimately-installed reference IS in the same tenant. This fence
  // is defence-in-depth — a malformed reference can't reach into
  // another tenant's credentials.
  const credential = await storage.items.get(
    credentialRef,
    connection.tenant_id ?? undefined,
  );
  if (credential?.type !== "system.credential") {
    throw new MarfaError(
      ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID,
      `Connection ${connection.id} has credential_ref '${credentialRef}' but no matching system.credential item exists.`,
    );
  }
  const credProps = credential.properties as {
    kind?: string;
    oauth_provider_config?: {
      upstream_base_url?: string;
      oauth_token_url?: string;
      oauth_client_id?: string;
    };
    api_token_config?: {
      upstream_base_url?: string;
      auth_scheme?: string;
    };
    secret_encrypted?: string;
  };
  if (typeof credProps.secret_encrypted !== "string") {
    throw new MarfaError(
      ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID,
      `Connection ${connection.id}'s credential_ref ${credentialRef} is missing the encrypted secret.`,
    );
  }

  if (credProps.kind === "oauth_token") {
    const cfg = credProps.oauth_provider_config;
    if (
      typeof cfg?.upstream_base_url !== "string" ||
      typeof cfg.oauth_token_url !== "string" ||
      typeof cfg.oauth_client_id !== "string"
    ) {
      throw new MarfaError(
        ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID,
        `Connection ${connection.id}'s credential_ref ${credentialRef} is not a usable kind:oauth_token — required oauth_provider_config fields are missing.`,
      );
    }
    return {
      kind: "oauth_token",
      upstream_base_url: cfg.upstream_base_url,
      oauth_token_url: cfg.oauth_token_url,
      oauth_client_id: cfg.oauth_client_id,
      oauth_client_secret: decryptSecret(
        credProps.secret_encrypted,
        SECRET_INFO.connectionOauthToken,
      ),
    };
  }

  if (credProps.kind === "api_token") {
    const cfg = credProps.api_token_config;
    if (typeof cfg?.upstream_base_url !== "string") {
      throw new MarfaError(
        ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID,
        `Connection ${connection.id}'s credential_ref ${credentialRef} is not a usable kind:api_token — api_token_config.upstream_base_url is missing.`,
      );
    }
    // Default to `Bearer` when no auth scheme is set, and treat
    // anything outside the supported set as Bearer too — a missing or
    // unrecognised scheme falls back rather than 500'ing on a
    // misconfigured credential.
    const SUPPORTED_SCHEMES: ApiTokenAuthScheme[] = [
      "Bearer",
      "Token",
      "Basic",
    ];
    const rawScheme = cfg.auth_scheme;
    const auth_scheme: ApiTokenAuthScheme =
      typeof rawScheme === "string" &&
      (SUPPORTED_SCHEMES as string[]).includes(rawScheme)
        ? (rawScheme as ApiTokenAuthScheme)
        : "Bearer";
    return {
      kind: "api_token",
      upstream_base_url: cfg.upstream_base_url,
      bearer_token: decryptSecret(
        credProps.secret_encrypted,
        SECRET_INFO.connectionOauthToken,
      ),
      auth_scheme,
    };
  }

  throw new MarfaError(
    ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID,
    `Connection ${connection.id}'s credential_ref ${credentialRef} has unsupported kind '${String(credProps.kind)}' (expected 'oauth_token' or 'api_token').`,
  );
}

/**
 * Resolve the effective upstream base URL for a proxy call.
 *
 * Consults `connection.properties.configuration.upstream_base_url_override`
 * first; falls back to the credential's `upstream_base_url`. Malformed
 * overrides fail loud rather than silently falling back — a misconfigured
 * connection should surface clearly, not silently route to the wrong host.
 *
 * Per-connection rather than per-credential so multiple integrations
 * sharing one OAuth credential can target different upstream hosts. The
 * canonical case: google.contacts uses `https://people.googleapis.com`
 * while google.calendar / drive / tasks share the same Google OAuth
 * credential with `https://www.googleapis.com`. Per-connection is the
 * right scope because the override is part of the install-time decision,
 * not the credential's identity.
 */
function resolveUpstreamBaseUrl(
  connection: Item,
  config: OAuthConfig | ApiTokenConfig,
): string {
  const configuration = (
    connection.properties as {
      configuration?: { upstream_base_url_override?: unknown };
    }
  ).configuration;
  const override = configuration?.upstream_base_url_override;
  if (typeof override === "string" && override.length > 0) {
    try {
      // URL constructor throws on invalid input — surface as a clear
      // misconfiguration error rather than silently falling back.
      new URL(override);
    } catch {
      throw new MarfaError(
        ErrorCode.OAUTH_PROXY_UPSTREAM_INVALID,
        `Connection ${connection.id}'s configuration.upstream_base_url_override is not a valid URL: '${override}'`,
      );
    }
    return override;
  }
  return config.upstream_base_url;
}

/**
 * Allow-list of headers the proxy forwards to the upstream from the
 * caller's request. Most other headers are either irrelevant
 * (Host, Content-Length recomputed by fetch) or actively dangerous
 * to forward (Cookie, the caller's own Authorization).
 */
const FORWARDABLE_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "accept-language",
  "user-agent",
  "if-match",
  "if-none-match",
  "if-modified-since",
]);

/**
 * Allow-list of upstream response headers we propagate back to the
 * caller. Strips set-cookie, transfer-encoding, content-length (fetch
 * recomputes), and connection-level headers.
 */
const FORWARDABLE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-language",
  "etag",
  "last-modified",
  "cache-control",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

function filterRequestHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (FORWARDABLE_REQUEST_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  });
  return out;
}

function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (FORWARDABLE_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  });
  return out;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * In-process mutex map keyed by connectionId. The cross-instance gate is
 * `storage.coordination.withJobLock`; this Map serialises concurrent
 * refresh attempts within the same Node process (which the per-instance
 * lock alone won't do — `pg_try_advisory_lock` is a no-op when the same
 * session holds it). Enforces "one refresh in flight per connection".
 */
const inFlightRefresh = new Map<string, Promise<void>>();

interface RefreshAttemptResult {
  ok: true;
  access_token: string;
}

interface RefreshAttemptFailed {
  ok: false;
  /** True when the upstream rejected the refresh with `invalid_grant`. */
  invalidGrant: boolean;
  reason: string;
}

/**
 * Exchange the connection's refresh_token at the upstream OAuth provider's
 * token endpoint for a fresh access_token. Persists the rotated tokens
 * back to `connection_oauth_tokens` and returns the new access_token in
 * memory for the immediate retry. The cross-instance lock + in-process
 * mutex means this runs at most once per connection at a time.
 */
async function refreshAccessToken(
  storage: Storage,
  connectionId: string,
  config: OAuthConfig,
): Promise<RefreshAttemptResult | RefreshAttemptFailed> {
  const row = await storage.connectionOauthTokens.get(connectionId);
  if (!row) {
    return {
      ok: false,
      invalidGrant: false,
      reason: "No token row for connection",
    };
  }
  if (!row.refresh_token_encrypted) {
    return {
      ok: false,
      invalidGrant: true,
      reason: "No refresh token available",
    };
  }
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(
      row.refresh_token_encrypted,
      SECRET_INFO.connectionOauthToken,
    );
  } catch {
    return {
      ok: false,
      invalidGrant: true,
      reason: "Failed to decrypt stored refresh token",
    };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.oauth_client_id,
    client_secret: config.oauth_client_secret,
  });
  let resp: Response;
  try {
    resp = await fetch(config.oauth_token_url, {
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
      invalidGrant: false,
      reason: `Token endpoint request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (resp.status === 400 || resp.status === 401) {
    // RFC 6749 §5.2 — invalid_grant is a terminal signal; refresh token
    // is gone, the user must reauth.
    let errCode = "";
    try {
      const j = (await resp.clone().json()) as { error?: string };
      errCode = j.error ?? "";
    } catch {
      // Body wasn't JSON; treat all 400/401 as invalid_grant since the
      // upstream isn't going to accept this refresh.
    }
    return {
      ok: false,
      // 400/401 from token endpoints is canonical "stop, reauth" — RFC
      // 6749 §5.2. Treat all such responses as terminal.
      invalidGrant: true,
      reason: `Upstream rejected refresh: ${errCode || String(resp.status)}`,
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      invalidGrant: false,
      reason: `Upstream returned ${String(resp.status)} on refresh`,
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
      invalidGrant: false,
      reason: "Upstream token response was not JSON",
    };
  }
  if (typeof payload.access_token !== "string") {
    return {
      ok: false,
      invalidGrant: false,
      reason: "Upstream token response missing access_token",
    };
  }
  const newAccess = payload.access_token;
  const newRefresh =
    typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  const expiresIn =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : 3600; // RFC 6749 §5.1 — default 1h when omitted.
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const scopes =
    typeof payload.scope === "string"
      ? payload.scope.split(/\s+/).filter(Boolean)
      : row.scopes;

  // Refresh-token rotation: when the upstream returned a NEW refresh
  // token that differs from what we sent, update both fields and stamp
  // previous_refresh_hash for forensic logs. When the upstream returned
  // the same token (no rotation), don't touch previous_refresh_hash.
  let nextRefreshEncrypted = row.refresh_token_encrypted;
  let previousHash = row.previous_refresh_hash;
  if (newRefresh && newRefresh !== refreshToken) {
    nextRefreshEncrypted = encryptSecret(
      newRefresh,
      SECRET_INFO.connectionOauthToken,
    );
    previousHash = sha256Hex(refreshToken);
  } else if (newRefresh === null) {
    // Some providers (e.g. when scope is reduced) return only access_token.
    // Keep the existing refresh token; don't touch previous_refresh_hash.
  }

  await storage.connectionOauthTokens.upsert({
    connection_id: connectionId,
    tenant_id: row.tenant_id ?? undefined,
    access_token_encrypted: encryptSecret(
      newAccess,
      SECRET_INFO.connectionOauthToken,
    ),
    refresh_token_encrypted: nextRefreshEncrypted,
    expires_at: expiresAt,
    scopes,
    previous_refresh_hash: previousHash,
  });

  return { ok: true, access_token: newAccess };
}

/**
 * Acquire (cross-instance + in-process) the per-connection refresh lock,
 * run `fn`, release. Multiple concurrent callers see one execution.
 */
async function withRefreshLock<T>(
  storage: Storage,
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Wait on any in-process refresh for this connection.
  const pending = inFlightRefresh.get(connectionId);
  if (pending) {
    await pending;
  }
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  inFlightRefresh.set(connectionId, gate);
  try {
    // Cross-instance gate: best-effort. If another instance has the
    // lock, withJobLock returns undefined; we fall through (the in-
    // process map already serialised this connection here, so we just
    // proceed and let the upstream arbitrate via invalid_grant).
    const result = await storage.coordination.withJobLock(
      `connection-refresh:${connectionId}`,
      fn,
    );
    if (result === undefined) {
      // Another instance held the lock. Run our own attempt — the in-
      // process map already prevents same-process double-fire.
      return await fn();
    }
    return result;
  } finally {
    resolve();
    inFlightRefresh.delete(connectionId);
  }
}

/**
 * Flip a connection's runtime_status to `reauth_required` and emit a
 * `system.activity` row so the user surface can prompt for re-auth.
 * Best-effort: failures here are logged but don't block the route's
 * own error response.
 */
async function markReauthRequired(
  storage: Storage,
  connection: Item,
  tenantId: string | undefined,
  reason: string,
  /** Resolved client IP for the audit trail. Threaded from the route
   *  handler that owns the Hono context. */
  clientIp: string | null,
): Promise<void> {
  try {
    const updated = await storage.items.update(
      connection.id,
      {
        properties: {
          ...connection.properties,
          runtime_status: "reauth_required",
          last_error_at: new Date().toISOString(),
        },
      },
      tenantId,
    );
    // items.update may return a ConflictResponse instead of throwing
    // on version mismatch. Surface that as an audit row rather than a
    // silent miss.
    if ("conflict" in updated) {
      void storage.audit.log({
        client_ip: clientIp,
        tenant_id: tenantId ?? null,
        action: "connection_proxy.runtime_status_flip_conflict",
        resource_type: "connection",
        resource_id: connection.id,
      });
    }
  } catch (err) {
    // Best-effort — runtime_status is server-stamped so any failure
    // here is a storage-level fault, not a caller fault. Surface in
    // audit log so operators can investigate.
    void storage.audit.log({
      client_ip: clientIp,
      tenant_id: tenantId ?? null,
      action: "connection_proxy.runtime_status_flip_failed",
      resource_type: "connection",
      resource_id: connection.id,
      details: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  // Emit a system.activity row. Keep the property set minimal — the
  // type schema accepts severity + summary + connection_id; richer
  // fields are optional. Tier follows the per-Connection feed_activity
  // toggle (mirrors the items.ts logic).
  const integration =
    typeof connection.properties.integration_ref === "string"
      ? connection.properties.integration_ref
      : "(unknown integration)";
  try {
    await storage.items.create(
      {
        type: "system.activity",
        properties: {
          severity: "action_required",
          summary: `OAuth re-authorisation needed for ${integration}`,
          connection_id: connection.id,
          // `detail` is `type: object` per system.activity.json — wrap
          // the reason string into a structured payload so the schema
          // validator accepts it.
          detail: { reason },
        },
        // tier follows feed_activity flag — server stamps
        ...(connection.properties.feed_activity === true
          ? { tier: "feed" as const }
          : {}),
      },
      tenantId,
    );
  } catch (err) {
    void storage.audit.log({
      client_ip: clientIp,
      tenant_id: tenantId ?? null,
      action: "connection_proxy.activity_emit_failed",
      resource_type: "connection",
      resource_id: connection.id,
      details: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

async function requireConnectionProxyAccess(
  c: import("hono").Context<AppEnv>,
  storage: Storage,
  connectionId: string,
): Promise<{ tenantId: string | undefined; connection: Item }> {
  const key = requireAuth(c);
  const tenantId = key.tenant_id ?? undefined;
  const connection = await storage.items.get(connectionId, tenantId);
  if (connection?.type !== "system.connection") {
    throw new MarfaError(
      ErrorCode.CONNECTION_NOT_FOUND,
      "Connection not found",
    );
  }
  const isAdmin = key.role === "admin" || key.is_platform;
  // Two connector-credential shapes accept here:
  //   1. OAuth-token grants the user issued for a kind:app connection —
  //      synthetic credentials minted in middleware/auth.ts with
  //      `source: "oauth:<connectionId>"`.
  //   2. Runtime credentials minted for a kind:integration connection by
  //      the install pipeline (source `integration:<id>`) or the
  //      lease broker (source `runtime-<prefix>-<ts>`). Both carry
  //      `is_runtime_credential: true` and `connection_id` stamped at
  //      mint time, so the gate matches on that pair rather than the
  //      free-form source string. Without this widening, every
  //      hosted-substrate integration Worker's `ctx.marfa.proxyRequest`
  //      call 403s on dispatch.
  const isConnector =
    key.source === `oauth:${connectionId}` ||
    (key.is_runtime_credential === true && key.connection_id === connectionId);
  if (!isAdmin && !isConnector) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Caller cannot proxy through this connection",
    );
  }
  return { tenantId, connection };
}

interface ProxyAttemptOutcome {
  status: number;
  bodyBytes: ArrayBuffer;
  responseHeaders: Record<string, string>;
}

async function performUpstreamCall(
  upstreamUrl: string,
  method: string,
  callerHeaders: Headers,
  bodyBytes: ArrayBuffer,
  accessToken: string,
  /**
   * HTTP Authorization scheme. Default `Bearer` (every OAuth flow +
   * the common api_token shape); the api_token branch passes
   * `config.auth_scheme` here to support upstreams like Readwise
   * (`Token`) or Basic-auth APIs.
   */
  authScheme: "Bearer" | "Token" | "Basic" = "Bearer",
): Promise<ProxyAttemptOutcome> {
  const headers: Record<string, string> = {
    ...filterRequestHeaders(callerHeaders),
    Authorization: `${authScheme} ${accessToken}`,
  };
  const upstreamResp = await fetch(upstreamUrl, {
    method,
    headers,
    body: ["GET", "HEAD"].includes(method.toUpperCase())
      ? undefined
      : Buffer.from(bodyBytes),
  });
  return {
    status: upstreamResp.status,
    bodyBytes: await upstreamResp.arrayBuffer(),
    responseHeaders: filterResponseHeaders(upstreamResp.headers),
  };
}

/** Number of seconds before expiry to trigger a proactive refresh. */
const PROACTIVE_REFRESH_LEEWAY_SEC = 60;

export function connectionProxyRoutes(storage: Storage) {
  const r = new Hono<AppEnv>();

  // Hono wildcard — catches every method + every path beneath
  // `/connections/:id/proxy/`. We capture the upstream sub-path off
  // `c.req.path`.
  r.all("/:id/proxy/*", async (c) => {
    const connectionId = c.req.param("id");
    const { tenantId, connection } = await requireConnectionProxyAccess(
      c,
      storage,
      connectionId,
    );

    const config = await readCredentialConfig(storage, connection);

    // Per-connection upstream_base_url override consulted before the
    // credential's value. Lets multiple integrations sharing one OAuth
    // credential target different upstream hosts (e.g. google.contacts
    // on people.googleapis.com vs google.calendar/drive/tasks on
    // www.googleapis.com sharing one google.* OAuth provider row).
    // Only tenant-admin can install / configure a connection, so the
    // trust model is unchanged from
    // POST /credentials/api-token already accepting an arbitrary
    // upstream_base_url.
    const effectiveBaseUrl = resolveUpstreamBaseUrl(connection, config);

    // Derive upstream URL: strip the route prefix from the request path
    // and prepend the configured upstream base URL.
    const prefix = `/connections/${connectionId}/proxy`;
    const reqUrl = new URL(c.req.url);
    const upstreamPath = reqUrl.pathname.startsWith(prefix)
      ? reqUrl.pathname.slice(prefix.length)
      : reqUrl.pathname;
    const upstreamUrl =
      effectiveBaseUrl.replace(/\/+$/, "") + upstreamPath + reqUrl.search;

    // Read body once — we may retry it after a refresh.
    const bodyBytes = await c.req.raw.arrayBuffer();

    const method = c.req.method;
    let outcome: ProxyAttemptOutcome;

    if (config.kind === "api_token") {
      // -----------------------------------------------------------------
      // Static API-token branch. The bearer is in `config` — no token
      // row to look up, no refresh primitive. Stamp it verbatim. On
      // upstream 401, surface 401 + flip the connection to
      // reauth_required (operator must reinstall with a fresh token).
      // -----------------------------------------------------------------
      outcome = await performUpstreamCall(
        upstreamUrl,
        method,
        c.req.raw.headers,
        bodyBytes,
        config.bearer_token,
        config.auth_scheme,
      );

      if (outcome.status === 401) {
        const reason = "Static API token rejected by upstream (HTTP 401)";
        await markReauthRequired(
          storage,
          connection,
          tenantId,
          reason +
            " — reinstall the connection with a fresh token via POST /credentials/api-token + POST /connections/install.",
          c.get("clientIp") ?? null,
        );
        void storage.audit.log({
          client_ip: c.get("clientIp") ?? null,
          tenant_id: c.get("apiKey")?.tenant_id ?? null,
          key_id: c.get("apiKey")?.id,
          action: "connection_proxy.api_token_rejected",
          resource_type: "connection",
          resource_id: connectionId,
          details: {
            method,
            upstream_host: new URL(upstreamUrl).host,
          },
        });
        throw new MarfaError(
          ErrorCode.OAUTH_PROXY_REAUTH_REQUIRED,
          `Upstream 401: ${reason}`,
        );
      }
    } else {
      // -----------------------------------------------------------------
      // OAuth-token branch. Look up the stored access/refresh tokens,
      // proactively refresh inside the leeway window, reactively refresh
      // on 401 + retry once.
      // -----------------------------------------------------------------

      // Look up the token row. tenantId-scoped read so cross-tenant
      // requests against the same connection_id can't peek.
      let row = await storage.connectionOauthTokens.get(connectionId, tenantId);
      if (!row) {
        void storage.audit.log({
          client_ip: c.get("clientIp") ?? null,
          tenant_id: c.get("apiKey")?.tenant_id ?? null,
          key_id: c.get("apiKey")?.id,
          action: "connection_proxy.token_missing",
          resource_type: "connection",
          resource_id: connectionId,
        });
        throw new MarfaError(
          ErrorCode.OAUTH_PROXY_TOKEN_MISSING,
          "Connection has no stored OAuth token; complete authorisation first",
        );
      }

      // Proactive refresh — when access_token expires inside the leeway
      // window, refresh before issuing the call.
      const expiresAtMs = Date.parse(row.expires_at);
      const proactiveDue =
        Number.isFinite(expiresAtMs) &&
        expiresAtMs - Date.now() < PROACTIVE_REFRESH_LEEWAY_SEC * 1000;

      if (proactiveDue) {
        const result = await withRefreshLock(storage, connectionId, () =>
          refreshAccessToken(storage, connectionId, config),
        );
        if (!result.ok) {
          if (result.invalidGrant) {
            await markReauthRequired(
              storage,
              connection,
              tenantId,
              result.reason,
              c.get("clientIp") ?? null,
            );
          }
          void storage.audit.log({
            client_ip: c.get("clientIp") ?? null,
            tenant_id: c.get("apiKey")?.tenant_id ?? null,
            key_id: c.get("apiKey")?.id,
            action: "connection_proxy.refresh_failed",
            resource_type: "connection",
            resource_id: connectionId,
            details: {
              reason: result.reason,
              invalid_grant: result.invalidGrant,
            },
          });
          throw new MarfaError(
            ErrorCode.OAUTH_PROXY_REAUTH_REQUIRED,
            `Refresh failed: ${result.reason}`,
          );
        }
        // Re-read row so the caller sees rotated state.
        row = await storage.connectionOauthTokens.get(connectionId, tenantId);
        if (!row) {
          // Should be impossible — refresh just wrote.
          throw new MarfaError(
            ErrorCode.OAUTH_PROXY_TOKEN_MISSING,
            "Token row vanished mid-refresh",
          );
        }
      }

      let accessToken: string;
      try {
        accessToken = decryptSecret(
          row.access_token_encrypted,
          SECRET_INFO.connectionOauthToken,
        );
      } catch {
        throw new MarfaError(
          ErrorCode.OAUTH_PROXY_REAUTH_REQUIRED,
          "Stored access token is unreadable; reauthorise to recover",
        );
      }

      outcome = await performUpstreamCall(
        upstreamUrl,
        method,
        c.req.raw.headers,
        bodyBytes,
        accessToken,
      );

      // Reactive refresh on 401. Single retry per call.
      if (outcome.status === 401) {
        const result = await withRefreshLock(storage, connectionId, () =>
          refreshAccessToken(storage, connectionId, config),
        );
        if (!result.ok) {
          if (result.invalidGrant) {
            await markReauthRequired(
              storage,
              connection,
              tenantId,
              result.reason,
              c.get("clientIp") ?? null,
            );
          }
          void storage.audit.log({
            client_ip: c.get("clientIp") ?? null,
            tenant_id: c.get("apiKey")?.tenant_id ?? null,
            key_id: c.get("apiKey")?.id,
            action: "connection_proxy.refresh_failed",
            resource_type: "connection",
            resource_id: connectionId,
            details: {
              reason: result.reason,
              invalid_grant: result.invalidGrant,
            },
          });
          throw new MarfaError(
            ErrorCode.OAUTH_PROXY_REAUTH_REQUIRED,
            `Upstream 401 and refresh failed: ${result.reason}`,
          );
        }
        // Retry once with the new access token.
        outcome = await performUpstreamCall(
          upstreamUrl,
          method,
          c.req.raw.headers,
          bodyBytes,
          result.access_token,
        );
      }
    }

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "connection_proxy.call",
      resource_type: "connection",
      resource_id: connectionId,
      details: {
        method,
        upstream_status: outcome.status,
        // Don't log path query — could contain bearer-equivalent secrets.
        upstream_host: new URL(upstreamUrl).host,
        credential_kind: config.kind,
      },
    });

    // Return passthrough.
    return c.body(
      outcome.bodyBytes,
      outcome.status as 200,
      outcome.responseHeaders,
    );
  });

  return r;
}

// Re-export for tests so they can short-circuit refresh via storage mocks.
export const __internals = {
  refreshAccessToken,
  sha256Hex,
  PROACTIVE_REFRESH_LEEWAY_SEC,
  // Exporting just for invariant checks; direct mutation is forbidden.
  generateProxyId: generateId,
};
