/**
 * Inbound webhook signature verification — uniform adapter interface
 * shared across the Cloudflare Worker control plane (`runtime-control`)
 * and the Node-side server (`packages/server`).
 *
 * Pre-T-035 the two runtimes maintained parallel implementations
 * (`node:crypto` vs Web Crypto). This package consolidates onto a
 * single Web-Crypto-only implementation; Node 20+ exposes Web Crypto
 * natively as `globalThis.crypto`, so both runtimes import the same
 * code path. A cross-runtime parity test in this package guards the
 * contract.
 *
 * Adapters are pure: no logging, no DB, no clock injection beyond
 * what the headers themselves carry. Surface results upstream.
 */

export interface VerifyResult {
  /** True iff the signature parses, the timestamp (when applicable)
   *  is within the spec's replay window, and the computed HMAC matches
   *  the provided one in constant time. */
  verified: boolean;
  /** Stable, snake_case identifier for why verification failed. Set
   *  iff `verified === false`. Useful for the persisted row's
   *  `processing_error` and for grepping audit / log streams. */
  reason?: string;
  /**
   * Sender-supplied delivery identifier extracted from the appropriate
   * header. Used by callers as the idempotency key (server-side: the
   * unique `(inbound_webhook_id, external_delivery_id)` index;
   * runtime-control: the KV cache key). Adapters with no canonical
   * delivery-id header return `undefined`; callers fall back to a
   * request-time identifier.
   */
  external_delivery_id?: string;
}

/** Verifier signature. Async because Web Crypto's `subtle` API is
 *  async; callers `await` the result. Body is `ArrayBuffer` (Web
 *  Crypto's native input type — server-side callers convert from
 *  `Buffer` once at the route boundary). */
export type Verifier = (
  rawBody: ArrayBuffer,
  headers: Headers,
  secret: string,
) => Promise<VerifyResult>;

/** Set of recognised verification methods. Mirrors the discriminated
 *  union arm in the Integration manifest's `webhook_verification`
 *  field. T-011 dropped the `custom` arm; this list is intentionally
 *  closed. */
export const VERIFICATION_METHODS = [
  "hmac-sha256",
  "slack",
  "stripe",
  "github",
  "google-channel",
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export function isVerificationMethod(s: string): s is VerificationMethod {
  return (VERIFICATION_METHODS as readonly string[]).includes(s);
}
