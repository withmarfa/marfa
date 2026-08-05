/**
 * OAuth endpoint discovery via RFC 8414 (`/.well-known/oauth-authorization-server`).
 *
 * The SDK reads the canonical metadata doc on first use and caches the
 * result for the process lifetime, rather than hardcoding endpoint URL
 * literals. The OAuth endpoints (`/auth/oauth2/authorize`,
 * `/auth/oauth2/token`, etc.) are owned by the Better Auth OAuth
 * Provider plugin and resolved from the discovery doc.
 *
 * `discoverEndpoints(issuer)` is called by `MarfaAuth`, `StoredTokenProvider`,
 * and `startDeviceFlow`. A module-scope promise cache de-duplicates
 * concurrent first-calls on app boot — three OAuth-touching code paths
 * collide on the same `.well-known` fetch.
 *
 * Failure is hard: a server that doesn't publish the discovery doc isn't a
 * server this SDK supports. There is no fallback to hardcoded paths.
 *
 * The request and the metadata validation are `oauth4webapi`'s rather than
 * hand-written. That matters beyond deleting code: the library checks that
 * the doc's `issuer` matches the issuer it was asked about, which is the
 * defense against a metadata document pointing a client at someone else's
 * token endpoint, and it is the check a hand-written reader is most likely
 * to skip.
 */
import * as oauth from "oauth4webapi";
import { ALLOW_INSECURE_HTTP } from "./insecure-http.js";
import { normalizeIssuer, authIssuerFor } from "./issuer.js";

/** OAuth endpoints we read from the discovery doc. RFC 8414 publishes
 *  more fields; the SDK only reads the ones it uses. */
export interface Endpoints {
  /** `token_endpoint` — refresh + auth-code exchange. */
  token: string;
  /** `authorization_endpoint` — browser-redirect entry point. */
  authorize: string;
  /** `device_authorization_endpoint` — RFC 8628 device-flow initiate. */
  deviceAuthorize: string;
  /** The validated metadata, for the library calls that need the whole
   *  document rather than one URL. */
  as: oauth.AuthorizationServer;
}

/** Raised when the server's discovery doc can't be loaded or doesn't
 *  carry the fields this SDK needs. Re-exported from `auth/index.ts`. */
export class DiscoveryError extends Error {
  readonly issuer: string;

  constructor(message: string, issuer: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscoveryError";
    this.issuer = issuer;
  }
}

// Module-scope cache, keyed by normalized issuer origin. We store the
// *promise*, not the resolved value, so concurrent first-calls during app
// boot funnel through a single in-flight fetch. On rejection we evict the
// entry so a later retry can re-attempt — a stuck rejected promise would
// permanently break the SDK after a single network blip.
const cache = new Map<string, Promise<Endpoints>>();

/**
 * Fetch and validate the server's OAuth discovery doc. Returns the small
 * subset of endpoints the SDK uses. Throws `DiscoveryError` on transport,
 * parse, or schema failure.
 */
export async function discoverEndpoints(
  issuer: string,
  fetchImpl?: typeof globalThis.fetch,
): Promise<Endpoints> {
  const key = normalizeIssuer(issuer);
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<Endpoints> => {
    const authIssuer = authIssuerFor(issuer);
    let as: oauth.AuthorizationServer;
    try {
      const res = await oauth.discoveryRequest(authIssuer, {
        algorithm: "oauth2",
        ...ALLOW_INSECURE_HTTP,
        ...(fetchImpl ? { [oauth.customFetch]: fetchImpl } : {}),
      });
      as = await oauth.processDiscoveryResponse(authIssuer, res);
    } catch (err) {
      throw new DiscoveryError(
        `OAuth discovery failed against ${authIssuer.href}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        key,
        { cause: err },
      );
    }
    const token = requireUrl(as.token_endpoint, "token_endpoint", key);
    const authorize = requireUrl(
      as.authorization_endpoint,
      "authorization_endpoint",
      key,
    );
    const deviceAuthorize = requireUrl(
      as.device_authorization_endpoint,
      "device_authorization_endpoint",
      key,
    );
    return { token, authorize, deviceAuthorize, as };
  })();

  // Evict the cache entry on rejection so a future call retries; keep it
  // on success so the discovery fetch happens at most once per issuer.
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });

  cache.set(key, promise);
  return promise;
}

function requireUrl(value: unknown, field: string, issuer: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DiscoveryError(
      `OAuth discovery doc from ${issuer} is missing required field "${field}"`,
      issuer,
    );
  }
  return value;
}

/** Test-only — clears the module cache. Production callers never need
 *  this; the cache is correct by construction for the SDK's lifetime. */
export function __resetDiscoveryCache(): void {
  cache.clear();
}
