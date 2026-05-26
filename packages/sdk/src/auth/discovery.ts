/**
 * OAuth endpoint discovery via RFC 8414 (`/.well-known/oauth-authorization-server`).
 *
 * The SDK previously hardcoded `/auth/authorize` and `/auth/token` against
 * the server's pre-T-131 URL layout. The server migration moved those to
 * `/auth/oauth2/authorize` and `/auth/oauth2/token` (Better Auth OAuth
 * Provider plugin). Rather than chasing URL changes through hardcoded
 * literals, the SDK now reads the canonical metadata doc on first use and
 * caches the result for the process lifetime.
 *
 * `discoverEndpoints(issuer)` is called by `MarfaAuth`, `StoredTokenProvider`,
 * and `startDeviceFlow`. A module-scope promise cache de-duplicates
 * concurrent first-calls on app boot — three OAuth-touching code paths
 * collide on the same `.well-known` fetch.
 *
 * Failure is hard: a server that doesn't publish the discovery doc isn't a
 * server this SDK supports. No fallback to legacy paths.
 */
import { normaliseIssuer } from "./issuer.js";

/** OAuth endpoints we read from the discovery doc. RFC 8414 publishes
 *  more fields; the SDK only reads the ones it uses. */
export interface Endpoints {
  /** `token_endpoint` — refresh + auth-code exchange. */
  token: string;
  /** `authorization_endpoint` — browser-redirect entry point. */
  authorize: string;
  /** `device_authorization_endpoint` — RFC 8628 device-flow initiate. */
  deviceAuthorize: string;
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

const DISCOVERY_PATH = "/.well-known/oauth-authorization-server";

// Module-scope cache, keyed by normalised issuer origin. We store the
// *promise*, not the resolved value, so concurrent first-calls during app
// boot funnel through a single in-flight fetch. On rejection we evict the
// entry so a later retry can re-attempt — a stuck rejected promise would
// permanently break the SDK after a single network blip.
const cache = new Map<string, Promise<Endpoints>>();

interface DiscoveryDoc {
  token_endpoint?: unknown;
  authorization_endpoint?: unknown;
  device_authorization_endpoint?: unknown;
}

/**
 * Fetch and validate the server's OAuth discovery doc. Returns the small
 * subset of endpoints the SDK uses. Throws `DiscoveryError` on transport,
 * parse, or schema failure.
 */
export async function discoverEndpoints(
  issuer: string,
  fetchImpl?: typeof globalThis.fetch,
): Promise<Endpoints> {
  const key = normaliseIssuer(issuer);
  const cached = cache.get(key);
  if (cached) return cached;

  const fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const promise = (async (): Promise<Endpoints> => {
    let res: Response;
    try {
      res = await fetch(`${key}${DISCOVERY_PATH}`);
    } catch (err) {
      throw new DiscoveryError(
        `OAuth discovery network error against ${key}`,
        key,
        { cause: err },
      );
    }
    if (!res.ok) {
      throw new DiscoveryError(
        `OAuth discovery returned HTTP ${String(res.status)} against ${key}`,
        key,
      );
    }
    let doc: DiscoveryDoc;
    try {
      doc = (await res.json()) as DiscoveryDoc;
    } catch (err) {
      throw new DiscoveryError(
        `OAuth discovery doc was not valid JSON from ${key}`,
        key,
        { cause: err },
      );
    }
    const token = requireUrl(doc.token_endpoint, "token_endpoint", key);
    const authorize = requireUrl(
      doc.authorization_endpoint,
      "authorization_endpoint",
      key,
    );
    const deviceAuthorize = requireUrl(
      doc.device_authorization_endpoint,
      "device_authorization_endpoint",
      key,
    );
    return { token, authorize, deviceAuthorize };
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
