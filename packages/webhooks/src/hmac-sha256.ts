/**
 * Default HMAC-SHA256 verification.
 *
 * Header format:
 *   X-Marfa-Signature: sha256=<hex>   (or bare hex)
 *   X-Marfa-Delivery-Id: <opaque>     (optional; surfaced regardless
 *                                     of verification outcome so DLQ
 *                                     rows are attributable)
 *
 * The HMAC is computed over the raw request body. The `sha256=` prefix
 * is the conventional form (GitHub, Vercel, others); we also accept a
 * bare hex string for callers that don't follow it.
 *
 * The `X-Marfa-` prefix is the canonical convention shared with the
 * Cloudflare Worker control plane and the Node-side server. Both
 * surfaces honour the same header names so a connector emitting one
 * receipt shape works through either path.
 */
import type { Verifier } from "./types.js";
import { constantTimeEqualsHex, hmacSha256Hex } from "./crypto.js";

const SIG_HEADER = "x-marfa-signature";
const DELIVERY_ID_HEADER = "x-marfa-delivery-id";

export const verifyHmacSha256: Verifier = async (rawBody, headers, secret) => {
  const externalDeliveryId = headers.get(DELIVERY_ID_HEADER) ?? undefined;

  const headerValue = headers.get(SIG_HEADER);
  if (!headerValue) {
    return {
      verified: false,
      reason: "missing_signature_header",
      external_delivery_id: externalDeliveryId,
    };
  }

  const provided = headerValue.replace(/^sha256=/i, "").trim();
  if (!/^[0-9a-f]+$/i.test(provided)) {
    return {
      verified: false,
      reason: "signature_format_invalid",
      external_delivery_id: externalDeliveryId,
    };
  }

  const expected = await hmacSha256Hex(secret, rawBody);
  if (!constantTimeEqualsHex(provided, expected)) {
    return {
      verified: false,
      reason: "signature_mismatch",
      external_delivery_id: externalDeliveryId,
    };
  }

  return { verified: true, external_delivery_id: externalDeliveryId };
};
