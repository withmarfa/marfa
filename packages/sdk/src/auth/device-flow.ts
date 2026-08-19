/**
 * Device Authorization Grant flow (RFC 8628) — for headless / CLI / native
 * apps that can't host a browser callback.
 *
 *   const handle = await startDeviceFlow({ issuer, clientId, scopes });
 *   console.log(`Visit ${handle.verification_uri} and enter ${handle.user_code}`);
 *   const provider = await handle.pollForToken();
 *
 * `pollForToken()` blocks until the user approves on the server (returning
 * a `TokenProvider`), the user denies (throws OAuthError "access_denied"),
 * or the device_code expires (throws OAuthError "expired_token"). Adheres
 * to RFC 8628 polling rules: respects `interval`, doubles on `slow_down`.
 */

import { OAuthError } from "./errors.js";
import { defaultTokenStorage } from "./storage.js";
import type { TokenStorage } from "./storage.js";
import { StoredTokenProvider } from "./token-provider.js";
import type { TokenProvider } from "./token-provider.js";
import { discoverEndpoints } from "./discovery.js";
import { normalizeIssuer } from "./issuer.js";

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SLOW_DOWN_BUMP_MS = 5_000;

export interface StartDeviceFlowConfig {
  /** Marfa server URL — protocol + host (and port). */
  issuer: string;
  /** OAuth client id, registered via POST /auth/oauth2/register (DCR). */
  clientId: string;
  /** Scopes to request (e.g. ["core.note:read"]). */
  scopes: string[];
  /** Token storage for persisting the resulting access/refresh tokens.
   *  Defaults to localStorage in browser, in-memory in Node. CLI consumers
   *  typically pass a filesystem-backed implementation. */
  storage?: TokenStorage;
  /** Override for the global fetch (testing). */
  fetch?: typeof globalThis.fetch;
}

export interface DeviceFlowHandle {
  /** Short, human-readable code the user types on the verification page
   *  (XXXX-XXXX shape). */
  user_code: string;
  /** URL the user should visit. */
  verification_uri: string;
  /** Same URL with `?user_code=…` appended; some clients can render this
   *  as a deep link / QR code so the user doesn't have to type. */
  verification_uri_complete: string;
  /** Seconds the device_code remains valid. */
  expires_in: number;
  /** Minimum seconds between polls. */
  interval: number;
  /** Block until the user approves on the server. Resolves with a
   *  TokenProvider that can be passed straight into `MarfaClient`.
   *  Rejects with OAuthError on denial / expiry / fatal error. */
  pollForToken(options?: { signal?: AbortSignal }): Promise<TokenProvider>;
}

interface InitiateResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  /** Present only when the approved scopes carry `offline_access`. */
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface PollErrorResponse {
  error: string;
  error_description?: string;
}

/** Initiate a Device Authorization Grant flow. The returned handle
 *  carries the user-facing code + URL plus a `pollForToken()` that
 *  blocks until approval. */
export async function startDeviceFlow(
  config: StartDeviceFlowConfig,
): Promise<DeviceFlowHandle> {
  const issuer = normalizeIssuer(config.issuer);
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = config.storage ?? defaultTokenStorage();
  const endpoints = await discoverEndpoints(issuer, fetchImpl);

  const initiateRes = await fetchImpl(endpoints.deviceAuthorize, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      scope: config.scopes.join(" "),
    }),
  });
  if (!initiateRes.ok) {
    const body = (await safeJson(initiateRes)) as Record<string, unknown>;
    const errCode = extractErrorCode(body);
    throw new OAuthError(
      errCode as OAuthError["code"],
      `device_authorization initiate failed: ${String(initiateRes.status)}`,
    );
  }
  const initiated = (await initiateRes.json()) as InitiateResponse;

  let pollIntervalMs =
    typeof initiated.interval === "number"
      ? initiated.interval * 1000
      : DEFAULT_POLL_INTERVAL_MS;

  const handle: DeviceFlowHandle = {
    user_code: initiated.user_code,
    verification_uri: initiated.verification_uri,
    verification_uri_complete: initiated.verification_uri_complete,
    expires_in: initiated.expires_in,
    interval: initiated.interval,
    async pollForToken(options) {
      const deadline = Date.now() + initiated.expires_in * 1000;
      while (Date.now() < deadline) {
        if (options?.signal?.aborted) {
          throw new OAuthError(
            "invalid_request",
            "Device flow aborted by caller",
          );
        }
        await sleep(pollIntervalMs, options?.signal);
        // RFC 8628 polling endpoint — Better Auth publishes initiate at
        // `device_authorization_endpoint` and polling at the same path
        // with `/token` appended. Discovery doesn't currently publish
        // the polling URL as its own field, so derive it here.
        const res = await fetchImpl(`${endpoints.deviceAuthorize}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: DEVICE_GRANT_TYPE,
            device_code: initiated.device_code,
            client_id: config.clientId,
          }).toString(),
        });
        if (res.ok) {
          const tokens = (await res.json()) as TokenResponse;
          // A 2xx that carries no refresh token is still a failure for this
          // SDK, exactly as it is on the authorization-code path: the whole
          // session model rests on being able to refresh, and a provider
          // holding no refresh token dies at the first expiry with an error
          // that names neither the cause nor the missing scope. Ask for
          // `offline_access` to stay signed in.
          if (!tokens.refresh_token) {
            throw new OAuthError(
              "invalid_grant",
              "Device flow returned no refresh token. Request the `offline_access` scope to stay signed in.",
              res.status,
            );
          }
          const storageKey = `marfa.auth.tokens:${issuer}:${config.clientId}`;
          const provider = new StoredTokenProvider({
            issuer,
            clientId: config.clientId,
            storage,
            storageKey,
            fetch: fetchImpl,
            endpoints,
          });
          await provider.persist({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            access_expires_at: Date.now() + tokens.expires_in * 1000,
            scope: tokens.scope,
          });
          return provider;
        }
        const body = (await safeJson(res)) as Partial<PollErrorResponse>;
        const code = body.error ?? "invalid_grant";
        if (code === "authorization_pending") continue;
        if (code === "slow_down") {
          pollIntervalMs += SLOW_DOWN_BUMP_MS;
          continue;
        }
        // access_denied / expired_token / invalid_grant / invalid_request:
        // terminal — bubble up to the caller.
        throw new OAuthError(
          code as OAuthError["code"],
          body.error_description ?? "Device flow failed",
        );
      }
      throw new OAuthError("expired_token", "Device flow expired");
    },
  };
  return handle;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** Extract a string error code from a response body that might shape itself as
 *  `{ error: "code" }` (RFC 6749 / 8628 token endpoint), `{ error: { code: "..." } }`
 *  (Marfa structured-error wrapper), or anything else (default to invalid_request). */
function extractErrorCode(body: Record<string, unknown>): string {
  const err = body.error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "invalid_request";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort);
  });
}
