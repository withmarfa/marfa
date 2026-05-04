import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerifyInboundWebhook } from "./types.js";

/**
 * Default HMAC-SHA256 verification. Header format:
 *   X-Myme-Signature: sha256=<hex>
 *
 * The HMAC is computed over the raw request body. The `sha256=` prefix
 * is conventional (GitHub, Vercel, others) — we accept it; we also
 * accept a bare hex string for callers that don't follow the prefix
 * convention.
 *
 * `external_delivery_id` is read from `X-Myme-Delivery-Id` if present.
 * Adapters with first-class delivery-id headers (Stripe's `Stripe-Signature.t`,
 * GitHub's `X-GitHub-Delivery`, etc.) override this in their own files.
 *
 * §3.3: the `X-Myme-` prefix is the canonical convention shared with the
 * Cloudflare Worker control-plane verifier (`packages/runtime-control`).
 * Both surfaces honour the same header names so a connector emitting one
 * receipt shape works through either path.
 */
export const verifyHmacSha256: VerifyInboundWebhook = (
  rawBody,
  headers,
  secret,
) => {
  // X-Myme-Delivery-Id is surfaced regardless of verification outcome —
  // failed receipts are still attributable to the sender's id, so
  // operators can grep DLQ rows by delivery id.
  const externalDeliveryId = headers.get("x-myme-delivery-id") ?? undefined;

  const headerValue = headers.get("x-myme-signature");
  if (!headerValue) {
    return {
      verified: false,
      reason: "missing X-Myme-Signature header",
      external_delivery_id: externalDeliveryId,
    };
  }

  const provided = headerValue.replace(/^sha256=/i, "").trim();
  if (!/^[0-9a-f]+$/i.test(provided)) {
    return {
      verified: false,
      reason: "X-Myme-Signature is not hex",
      external_delivery_id: externalDeliveryId,
    };
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      verified: false,
      reason: "signature mismatch",
      external_delivery_id: externalDeliveryId,
    };
  }

  return {
    verified: true,
    external_delivery_id: externalDeliveryId,
  };
};
