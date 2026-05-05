/**
 * GitHub webhook signature verification.
 * Spec: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 *
 * Header format:
 *   X-Hub-Signature-256: sha256=<hex>
 *   X-GitHub-Delivery:   <uuid>     (per-delivery identifier; surfaced
 *                                    as `external_delivery_id` regardless
 *                                    of verification outcome so DLQ rows
 *                                    are attributable)
 *
 * Signed string: the raw request body.
 */
import type { Verifier } from "./types.js";
import { constantTimeEqualsHex, hmacSha256Hex } from "./crypto.js";

const SIG_HEADER = "x-hub-signature-256";
const DELIVERY_ID_HEADER = "x-github-delivery";

export const verifyGitHub: Verifier = async (rawBody, headers, secret) => {
  const externalDeliveryId = headers.get(DELIVERY_ID_HEADER) ?? undefined;

  const sig = headers.get(SIG_HEADER);
  if (!sig) {
    return {
      verified: false,
      reason: "missing_signature_header",
      external_delivery_id: externalDeliveryId,
    };
  }

  if (!sig.startsWith("sha256=")) {
    return {
      verified: false,
      reason: "signature_format_invalid",
      external_delivery_id: externalDeliveryId,
    };
  }

  const provided = sig.slice("sha256=".length);
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
