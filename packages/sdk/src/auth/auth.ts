import { defaultTokenStorage } from "./storage.js";
import type { TokenStorage } from "./storage.js";
import {
  computeCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "./pkce.js";
import { StoredTokenProvider } from "./token-provider.js";
import type { TokenProvider } from "./token-provider.js";
import { OAuthError } from "./errors.js";
import { discoverEndpoints } from "./discovery.js";
import { normaliseIssuer } from "./issuer.js";

/**
 * MymeAuth — owns the OAuth dance for browser apps signing into Myme.
 *
 * Flow:
 *   const auth = new MymeAuth({ issuer, clientId, redirectUri, scopes });
 *   // On a "Sign in" click:
 *   window.location.href = await auth.buildAuthorizeUrl();
 *   // On the callback page:
 *   const provider = await auth.handleCallback(window.location.href);
 *   const client = new MymeClient({ url: issuer, tokenProvider: provider });
 *
 * Restoration on page load: `await auth.restore()` returns a TokenProvider
 * if a session is in storage, null otherwise.
 *
 * Sign-out: `await auth.signOut(provider)` revokes locally and clears
 * persisted tokens; visible "session expired" UX is the caller's
 * responsibility (subscribe via provider.onSignOut).
 */
export interface MymeAuthConfig {
  /** Myme server URL — protocol + host (and port). */
  issuer: string;
  /** OAuth client id, registered via POST /auth/oauth2/register (DCR). */
  clientId: string;
  /** Exact-match redirect URI. Must be registered for this client. */
  redirectUri: string;
  /** Scopes to request (e.g. ["core.note:read", "core.note:write"]). */
  scopes: string[];
  /** Token storage. Defaults to localStorage in browser, in-memory in Node. */
  storage?: TokenStorage;
  /** Override for the global fetch (testing). */
  fetch?: typeof globalThis.fetch;
}

interface PendingState {
  verifier: string;
  state: string;
  redirectUri: string;
}

export class MymeAuth {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly scopes: string[];
  private readonly storage: TokenStorage;
  private readonly fetch: typeof globalThis.fetch;
  private readonly pendingKey: string;
  private readonly tokensKey: string;

  constructor(config: MymeAuthConfig) {
    this.issuer = normaliseIssuer(config.issuer);
    this.clientId = config.clientId;
    this.redirectUri = config.redirectUri;
    this.scopes = config.scopes;
    this.storage = config.storage ?? defaultTokenStorage();
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);

    // Storage key shape — origin + client_id keeps multiple Myme client
    // ids on the same origin distinct. Persisted state and the resulting
    // token bundle live under separate keys so we can clear them
    // independently.
    this.pendingKey = `myme.auth.pending:${this.issuer}:${config.clientId}`;
    this.tokensKey = `myme.auth.tokens:${this.issuer}:${config.clientId}`;
  }

  /** Build the authorize URL and persist the PKCE verifier + state. */
  async buildAuthorizeUrl(opts?: { state?: string }): Promise<string> {
    const verifier = generateCodeVerifier();
    const challenge = await computeCodeChallenge(verifier);
    const state = opts?.state ?? generateState();

    const pending: PendingState = {
      verifier,
      state,
      redirectUri: this.redirectUri,
    };
    await this.storage.set(this.pendingKey, JSON.stringify(pending));

    const endpoints = await discoverEndpoints(this.issuer, this.fetch);
    const url = new URL(endpoints.authorize);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return url.toString();
  }

  /**
   * Exchange the authorization code for tokens. Call from your `/callback`
   * route handler with `window.location.href` (or the equivalent server-
   * side request URL). Throws OAuthError on failure.
   */
  async handleCallback(callbackUrl: string): Promise<TokenProvider> {
    const url = new URL(callbackUrl);
    const error = url.searchParams.get("error");
    if (error) {
      throw new OAuthError(
        error === "access_denied" ? "access_denied" : "invalid_request",
        url.searchParams.get("error_description") ?? error,
      );
    }
    const code = url.searchParams.get("code");
    const incomingState = url.searchParams.get("state");
    if (!code) {
      throw new OAuthError("invalid_request", "Missing authorization code");
    }

    const pendingRaw = await this.storage.get(this.pendingKey);
    if (!pendingRaw) {
      throw new OAuthError(
        "invalid_request",
        "No pending PKCE verifier — did you call buildAuthorizeUrl in a different browser context?",
      );
    }
    const pending = JSON.parse(pendingRaw) as PendingState;
    if (pending.state !== incomingState) {
      throw new OAuthError("invalid_request", "State mismatch on callback");
    }

    const endpoints = await discoverEndpoints(this.issuer, this.fetch);
    // OAuth 2.0 §3.2: token endpoint takes form-encoded.
    const res = await this.fetch(endpoints.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        client_id: this.clientId,
      }).toString(),
    });
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token || !body.refresh_token) {
      const errCode = body.error
        ? (body.error as
            | "invalid_grant"
            | "invalid_request"
            | "invalid_client"
            | "invalid_scope"
            | "unauthorized_client"
            | "unsupported_grant_type"
            | "access_denied"
            | "server_error"
            | "temporarily_unavailable")
        : "invalid_grant";
      throw new OAuthError(
        errCode,
        body.error_description ?? body.error ?? "Token exchange failed",
        res.status,
      );
    }

    // Pending state is now spent; clear it.
    await this.storage.delete(this.pendingKey);

    const provider = new StoredTokenProvider({
      issuer: this.issuer,
      clientId: this.clientId,
      storage: this.storage,
      storageKey: this.tokensKey,
      fetch: this.fetch,
      endpoints,
    });
    await provider.persist({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      access_expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
      scope: body.scope ?? this.scopes.join(" "),
    });
    return provider;
  }

  /** Restore a TokenProvider from persisted storage; null if no session. */
  async restore(): Promise<TokenProvider | null> {
    const provider = new StoredTokenProvider({
      issuer: this.issuer,
      clientId: this.clientId,
      storage: this.storage,
      storageKey: this.tokensKey,
      fetch: this.fetch,
    });
    const ok = await provider.hydrateFromStorage();
    return ok ? provider : null;
  }

  /** Sign out — clears persisted tokens. */
  async signOut(provider: TokenProvider): Promise<void> {
    await provider.signOut();
    await this.storage.delete(this.pendingKey);
  }
}
