/**
 * Cloudflare Email Routing → Email Worker → webhook verifier.
 *
 * The Cloudflare Email Worker that backs `withmarfa.inbox` receives an
 * inbound email via Email Routing, parses MIME via `postal-mime`, then
 * POSTs a JSON envelope to the server's webhook receipt endpoint. The
 * wire shape:
 *
 *   X-Marfa-Signature:    sha256=<hex>     HMAC-SHA256 of the raw body
 *                                          against the per-connection
 *                                          subscription secret.
 *   X-Marfa-Delivery-Id:  <message-id>     RFC 5322 Message-ID (or a
 *                                          UUID4 fallback). Used as the
 *                                          idempotency key — a duplicate
 *                                          delivery of the same email
 *                                          (CF retry, second forward,
 *                                          etc.) resolves to the same
 *                                          item.
 *   Content-Type:        application/json
 *
 * Verification is mechanically identical to the generic `hmac-sha256`
 * adapter — same algorithm, same headers. The split exists for
 * manifest-time clarity: a subscription declaring
 * `verification_method: "cloudflare-email"` is signalling "I receive
 * the email JSON envelope shape from a CF Email Worker", which is the
 * contract integration handlers parse against. The wire format on the
 * verification path is unchanged, so the adapter delegates.
 */
import type { Verifier } from "./types.js";
import { verifyHmacSha256 } from "./hmac-sha256.js";

export const verifyCloudflareEmail: Verifier = (rawBody, headers, secret) =>
  verifyHmacSha256(rawBody, headers, secret);
