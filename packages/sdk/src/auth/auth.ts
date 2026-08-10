import * as oauth from "oauth4webapi";
import { ALLOW_INSECURE_HTTP } from "./insecure-http.js";
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
import { normalizeIssuer } from "./issuer.js";

/**
 * MarfaAuth — owns the OAuth dance for browser apps signing into Marfa.
 *
 * Flow:
 *   const auth = new MarfaAuth({ issuer, clientId, redirectUri, scopes });
 *   // On a "Sign in" click:
 *   window.location.href = await auth.buildAuthorizeUrl();
 *   // On the callback page:
 *   const provider = await auth.handleCallback(window.location.href);
 *   const client = new MarfaClient({ url: issuer, tokenProvider: provider });
 *
 * Restoration on page load: `await auth.restore()` returns a TokenProvider
 * if a session is in storage, null otherwise.
 *
 * Sign-out: `await auth.signOut(provider)` revokes locally and clears
 * persisted tokens; visible "session expired" UX is the caller's
 * responsibility (subscribe via provider.onSignOut).
 */
export interface MarfaAuthConfig {
  /** Marfa server URL — protocol + host (and port). */
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

interface StoredBrowserSession {
  id_token?: unknown;
}

/** OAuth error codes this SDK models. Anything the server sends that is
 *  not one of them reads as `invalid_grant`, which is the conservative
 *  answer: treat an unrecognized refusal as a dead grant rather than as
 *  something retryable. */
const OAUTH_ERROR_CODES = [
  "invalid_grant",
  "invalid_request",
  "invalid_client",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
] as const;

function toOAuthErrorCode(value: unknown): (typeof OAUTH_ERROR_CODES)[number] {
  return typeof value === "string" &&
    (OAUTH_ERROR_CODES as readonly string[]).includes(value)
    ? (value as (typeof OAUTH_ERROR_CODES)[number])
    : "invalid_grant";
}

export class MarfaAuth {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly scopes: string[];
  private readonly storage: TokenStorage;
  private readonly fetch: typeof globalThis.fetch;
  private readonly pendingKey: string;
  private readonly tokensKey: string;

  constructor(config: MarfaAuthConfig) {
    this.issuer = normalizeIssuer(config.issuer);
    this.clientId = config.clientId;
    this.redirectUri = config.redirectUri;
    this.scopes = config.scopes;
    this.storage = config.storage ?? defaultTokenStorage();
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);

    // Storage key shape — origin + client_id keeps multiple Marfa client
    // ids on the same origin distinct. Persisted state and the resulting
    // token bundle live under separate keys so we can clear them
    // independently.
    this.pendingKey = `marfa.auth.pending:${this.issuer}:${config.clientId}`;
    this.tokensKey = `marfa.auth.tokens:${this.issuer}:${config.clientId}`;
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
   * Build a standards-based hosted browser logout URL for this OAuth client.
   * The issuer validates the ID token and exact registered return URI before
   * ending the browser session. Local token clearing stays explicit through
   * `signOut()`.
   */
  async buildBrowserSignOutUrl(postLogoutRedirectUri: string): Promise<string> {
    const raw = await this.storage.get(this.tokensKey);
    let idToken: unknown;
    try {
      idToken = raw ? (JSON.parse(raw) as StoredBrowserSession).id_token : null;
    } catch {
      idToken = null;
    }
    if (typeof idToken !== "string" || idToken.length === 0) {
      throw new OAuthError(
        "invalid_request",
        "No ID token is available for browser sign-out. Sign in again before signing out.",
      );
    }

    const url = new URL("/auth/oauth2/end-session", this.issuer);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
    url.searchParams.set("id_token_hint", idToken);
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
    const client = { client_id: this.clientId };
    // The callback parameters have to come from the library's own validator.
    // It brands the object it returns and the grant request refuses anything
    // unbranded, so there is no way to skip the response check by handing it
    // a set of parameters assembled here. It also verifies `iss` against the
    // discovered issuer, which is the mix-up defense a hand-assembled bag of
    // parameters silently omits.
    let callbackParameters: URLSearchParams;
    try {
      callbackParameters = oauth.validateAuthResponse(
        endpoints.as,
        client,
        url.searchParams,
        pending.state,
      );
    } catch (err) {
      throw new OAuthError(
        "invalid_request",
        err instanceof Error ? err.message : "Invalid authorization response",
      );
    }

    // The exchange is the library's: it builds the form-encoded body,
    // applies `none` client authentication for a public client, and
    // validates the response against RFC 6749 rather than trusting the
    // JSON that came back. `token_type`, which the hand-written reader
    // never checked, is one of the things it now insists on.
    const res = await oauth.authorizationCodeGrantRequest(
      endpoints.as,
      client,
      oauth.None(),
      callbackParameters,
      pending.redirectUri,
      pending.verifier,
      {
        ...ALLOW_INSECURE_HTTP,
        [oauth.customFetch]: this.fetch,
      },
    );
    // The refusal is read first and separately. The library's processor
    // rejects rather than returning on a non-2xx, and merging the two
    // shapes into one value would erase the types it does give us.
    if (!res.ok) {
      const failure = (await res.json().catch(() => ({}))) as {
        error?: string;
        error_description?: string;
      };
      throw new OAuthError(
        toOAuthErrorCode(failure.error),
        failure.error_description ?? failure.error ?? "Token exchange failed",
        res.status,
      );
    }
    const body = await oauth.processAuthorizationCodeResponse(
      endpoints.as,
      client,
      res,
    );
    // A 2xx that carries no refresh token is still a failure for this
    // SDK: the whole session model rests on being able to refresh.
    if (!body.refresh_token) {
      throw new OAuthError(
        "invalid_grant",
        "Token exchange returned no refresh token",
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
      id_token: body.id_token,
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
