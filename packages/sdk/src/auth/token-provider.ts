import type { TokenStorage } from "./storage.js";
import { OAuthError } from "./errors.js";
import { discoverEndpoints, type Endpoints } from "./discovery.js";
import { normalizeIssuer } from "./issuer.js";

interface PersistedTokens {
  access_token: string;
  refresh_token: string;
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
   *  semantics as `getAccessToken()`. Consumers calling on a 401 response
   *  should use this rather than waiting for the next `getAccessToken()` to
   *  hit the proactive window. */
  refresh(): Promise<string>;
}

const PROACTIVE_WINDOW_MS = 60_000;

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
   *  invalid_token) without waiting for the proactive-refresh window. */
  async refresh(): Promise<string> {
    if (this.inflightRefresh) return this.inflightRefresh;
    if (!this.cache) {
      throw new OAuthError("invalid_grant", "No refresh token available", 401);
    }

    const refreshToken = this.cache.refresh_token;
    const previousScope = this.cache.scope;
    this.inflightRefresh = (async () => {
      try {
        this.endpoints ??= await discoverEndpoints(this.issuer, this.fetch);
        // OAuth 2.0 §3.2: token endpoint takes form-encoded.
        const res = await this.fetch(this.endpoints.token, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: this.clientId,
          }).toString(),
        });
        const body = (await res.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
          error?: string;
        };
        if (!res.ok || !body.access_token) {
          await this.signOut();
          throw new OAuthError(
            (body.error as
              | "invalid_grant"
              | "token_reuse_detected"
              | undefined) ?? "invalid_grant",
            body.error ?? "Refresh failed",
            res.status,
          );
        }
        const expiresInMs = (body.expires_in ?? 3600) * 1000;
        const updated: PersistedTokens = {
          access_token: body.access_token,
          refresh_token: body.refresh_token ?? refreshToken,
          access_expires_at: Date.now() + expiresInMs,
          scope: body.scope ?? previousScope,
        };
        await this.persist(updated);
        return updated.access_token;
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
