/**
 * Inbound webhook signature verification — uniform adapter interface.
 *
 * Every adapter takes the raw request body (as a Buffer; HMAC over
 * altered bytes fails), the request headers, and the plaintext secret
 * (decrypted from `inbound_webhooks.secret_encrypted` at receipt time
 * by the route handler), and returns a small result object.
 *
 * Adapters are pure: no logging, no DB, no clock-tick injection beyond
 * what the headers themselves carry. The route handler is responsible
 * for surfacing the result (writing the row, returning the status).
 */
export interface VerifyInboundWebhookResult {
  verified: boolean;
  /** Set when verified=false. Useful for the row's processing_error. */
  reason?: string;
  /**
   * The sender's idempotency identifier extracted from the appropriate
   * header. Used by the route handler to enforce at-most-once
   * processing via the unique (inbound_webhook_id, external_delivery_id)
   * index. Adapters that don't have a canonical id header may return
   * null here — the route handler will fall back to the request id.
   */
  external_delivery_id?: string;
}

export type VerifyInboundWebhook = (
  rawBody: Buffer,
  headers: Headers,
  secret: string,
) => VerifyInboundWebhookResult;

/** Set of recognised verification methods. Mirrors the discriminated
 *  union in the Integration manifest's webhook_verification field. */
export const VERIFICATION_METHODS = [
  "hmac-sha256",
  "slack",
  "stripe",
  "github",
  "custom",
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export function isVerificationMethod(s: string): s is VerificationMethod {
  return (VERIFICATION_METHODS as readonly string[]).includes(s);
}
