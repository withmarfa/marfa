import * as oauth from "oauth4webapi";
import { ALLOW_INSECURE_HTTP } from "./insecure-http.js";
import type { TokenStorage } from "./storage.js";
import { OAuthError, type OAuthErrorCode } from "./errors.js";
import { discoverEndpoints, type Endpoints } from "./discovery.js";
import { normalizeIssuer } from "./issuer.js";

/**
 * The shape `StoredTokenProvider` persists through its `TokenStorage`.
 * Exported because it is a cross-process contract, not just a cache: the
 * file-backed store under `auth/node` writes this blob to
 * `~/.marfa/<instance>.json`, where any tool sharing the store reads it
 * back. Changing a field here changes what every consumer finds on disk.
 */
export interface PersistedTokens {
  access_token: string;
  refresh_token: string;
  /** OIDC ID token from the original authorization-code exchange. */
  id_token?: string;
  /** Unix ms */
  access_expires_at: number;
  scope: string;
}

/** TokenProvider gives MarfaClient an access token for every request. */
export interface TokenProvider {
  /** Returns a non-expired access token. Refreshes proactively if < 60s
   *  remain on the current one. Single-flight: concurrent callers await
   *  the same in-flight refresh promise. */
  getAccessToken(): Promise<string>;
  /** Subscribe to sign-out events (fired on invalid_grant /
   *  token_reuse_detected). Returns an unsubscribe fn. */
  onSignOut(handler: () => void): () => void;
  /** Force a sign-out — clears local storage, fires onSignOut handlers. */
  signOut(): Promise<void>;
  /** Force a token refresh and return the new access token. Same single-flight
   *  semantics as `getAccessToken()`. `HttpTransport` calls this itself when a
   *  request comes back 401 on a token the clock still considers valid, so a
   *  server-side revocation recovers without waiting for the proactive
   *  window. */
  refresh(): Promise<string>;
}

const PROACTIVE_WINDOW_MS = 60_000;

/** Statuses safe to replay a refresh token against. Both mean the server
 *  turned the request away before it reached the grant, so the token is
 *  provably unrotated. A timeout or a 5xx is ambiguous — the exchange may
 *  have succeeded with the response lost, and replaying then trips reuse
 *  detection and ends the session, turning a recoverable blip into a forced
 *  sign-out. */
const RETRYABLE_REFRESH_STATUSES = new Set([429, 503]);
const MAX_REFRESH_ATTEMPTS = 3;
const REFRESH_BASE_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A failed exchange is terminal when the grant itself is gone, so only a
 *  fresh sign-in recovers it. Anything else leaves the session usable and
 *  must not sign the user out. */
function isTerminalRefreshFailure(
  status: number,
  code: OAuthErrorCode,
): boolean {
  if (code === "invalid_grant" || code === "token_reuse_detected") return true;
  // A 400 or 401 the server didn't tag with a recognized code still means the
  // credential was refused; asking again cannot change that answer.
  return status === 400 || status === 401;
}

/** `Retry-After` in ms when the server sent one — it knows when its window
 *  resets better than a client-side guess does. */
function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export interface TokenProviderConfig {
  issuer: string;
  clientId: string;
  storage: TokenStorage;
  storageKey: string;
  fetch?: typeof globalThis.fetch;
  /** Pre-resolved OAuth endpoints. When omitted, `refresh()` discovers
   *  them lazily via `/.well-known/oauth-authorization-server` on first
   *  call. Callers that have already discovered (e.g. `MarfaAuth` after
   *  `handleCallback`) pass them in to skip a redundant fetch. */
  endpoints?: Endpoints;
}

export class StoredTokenProvider implements TokenProvider {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly storage: TokenStorage;
  private readonly storageKey: string;
  private readonly fetch: typeof globalThis.fetch;
  private endpoints: Endpoints | null;
  private cache: PersistedTokens | null = null;
  private inflightRefresh: Promise<string> | null = null;
  private signOutHandlers = new Set<() => void>();

  constructor(config: TokenProviderConfig) {
    this.issuer = normalizeIssuer(config.issuer);
    this.clientId = config.clientId;
    this.storage = config.storage;
    this.storageKey = config.storageKey;
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.endpoints = config.endpoints ?? null;
  }

  async hydrateFromStorage(): Promise<boolean> {
    const raw = await this.storage.get(this.storageKey);
    if (!raw) return false;
    try {
      this.cache = JSON.parse(raw) as PersistedTokens;
      return true;
    } catch {
      await this.storage.delete(this.storageKey);
      return false;
    }
  }

  async persist(tokens: PersistedTokens): Promise<void> {
    this.cache = tokens;
    await this.storage.set(this.storageKey, JSON.stringify(tokens));
  }

  async getAccessToken(): Promise<string> {
    if (!this.cache) {
      const ok = await this.hydrateFromStorage();
      if (!ok) {
        throw new OAuthError("invalid_grant", "No active session", 401);
      }
    }
    if (!this.cache) {
      throw new OAuthError("invalid_grant", "No active session", 401);
    }

    const remaining = this.cache.access_expires_at - Date.now();
    if (remaining > PROACTIVE_WINDOW_MS) {
      return this.cache.access_token;
    }

    return this.refresh();
  }

  /** Single-flight refresh — concurrent callers await the same promise.
   *  Public so consumers can force a refresh on 401 responses (RFC 6750
   *  invalid_token) without waiting for the proactive-refresh window.
   *
   *  Kept hand-written when the exchange itself moved to `oauth4webapi`:
   *  the library is a protocol client and holds no state across calls, so
   *  it has nowhere to put the guard. Without it a page that fires three
   *  requests on load performs three refreshes, and with refresh-token
   *  rotation on the server the last two present an already-rotated token
   *  and sign the user out. */
  async refresh(): Promise<string> {
    if (this.inflightRefresh) return this.inflightRefresh;
    if (!this.cache) {
      throw new OAuthError("invalid_grant", "No refresh token available", 401);
    }

    const refreshToken = this.cache.refresh_token;
    const previousScope = this.cache.scope;
    this.inflightRefresh = (async () => {
      try {
        const endpoints = (this.endpoints ??= await discoverEndpoints(
          this.issuer,
          this.fetch,
        ));
        for (let attempt = 1; ; attempt++) {
          // The exchange itself is the library's: it builds the
          // form-encoded body, applies `none` client authentication for a
          // public client, and validates the response against RFC 6749
          // rather than trusting whatever JSON came back. The retry and
          // sign-out policy around it stays ours, because it is a product
          // decision about when a session is dead, not a protocol one.
          const res = await oauth.refreshTokenGrantRequest(
            endpoints.as,
            { client_id: this.clientId },
            oauth.None(),
            refreshToken,
            {
              ...ALLOW_INSECURE_HTTP,
              [oauth.customFetch]: this.fetch,
            },
          );
          // A rate-limited or unavailable response need not be JSON, and
          // the library's processor rejects rather than returning on a
          // non-2xx, so the error path reads the body directly.
          if (res.ok) {
            const body = await oauth.processRefreshTokenResponse(
              endpoints.as,
              { client_id: this.clientId },
              res,
            );
            const expiresInMs = (body.expires_in ?? 3600) * 1000;
            const updated: PersistedTokens = {
              access_token: body.access_token,
              refresh_token: body.refresh_token ?? refreshToken,
              id_token: this.cache?.id_token,
              access_expires_at: Date.now() + expiresInMs,
              scope: body.scope ?? previousScope,
            };
            await this.persist(updated);
            return updated.access_token;
          }

          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };

          const code =
            (body.error as OAuthErrorCode | undefined) ?? "invalid_grant";
          const error = new OAuthError(
            code,
            body.error ?? "Refresh failed",
            res.status,
          );

          // Only a dead grant justifies ending the session. Signing out on a
          // transient failure would evict a user whose credentials are fine.
          if (isTerminalRefreshFailure(res.status, code)) {
            await this.signOut();
            throw error;
          }
          if (
            !RETRYABLE_REFRESH_STATUSES.has(res.status) ||
            attempt >= MAX_REFRESH_ATTEMPTS
          ) {
            throw error;
          }
          await sleep(
            retryAfterMs(res.headers) ??
              REFRESH_BASE_DELAY_MS * 2 ** (attempt - 1),
          );
        }
      } finally {
        this.inflightRefresh = null;
      }
    })();
    return this.inflightRefresh;
  }

  onSignOut(handler: () => void): () => void {
    this.signOutHandlers.add(handler);
    return () => this.signOutHandlers.delete(handler);
  }

  async signOut(): Promise<void> {
    this.cache = null;
    await this.storage.delete(this.storageKey);
    for (const h of this.signOutHandlers) {
      try {
        h();
      } catch {
        // Don't let one handler kill the rest.
      }
    }
  }
}
