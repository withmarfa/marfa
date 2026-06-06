/**
 * Inbound webhook signature verification — uniform adapter interface
 * shared across the Cloudflare Worker control plane (`runtime-control`)
 * and the Node-side server (`packages/server`).
 *
 * One Web-Crypto-only implementation serves both runtimes — Node 20+
 * exposes Web Crypto natively as `globalThis.crypto`, so the Worker
 * control plane and the Node-side server import the same code path
 * rather than maintaining parallel `node:crypto` vs Web Crypto
 * implementations. A cross-runtime parity test in this package guards
 * the contract.
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

/** Body is `ArrayBuffer` — Web Crypto's native type. Server-side callers
 *  convert from `Buffer` once at the route boundary. */
export type Verifier = (
  rawBody: ArrayBuffer,
  headers: Headers,
  secret: string,
) => Promise<VerifyResult>;

/** Closed set — the manifest schema does not accept a `custom` arm. */
export const VERIFICATION_METHODS = [
  "hmac-sha256",
  "slack",
  "stripe",
  "github",
  "google-channel",
  // Cloudflare Email Worker → JSON envelope, HMAC-signed by the Worker
  // against the per-connection subscription secret. The adapter shares
  // the on-the-wire shape of `hmac-sha256` (signature header
  // `X-Marfa-Signature`, idempotency header `X-Marfa-Delivery-Id`) —
  // the split exists to declare the body schema at manifest time.
  "cloudflare-email",
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export function isVerificationMethod(s: string): s is VerificationMethod {
  return (VERIFICATION_METHODS as readonly string[]).includes(s);
}
