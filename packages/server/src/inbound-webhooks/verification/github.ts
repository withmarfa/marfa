import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerifyInboundWebhook } from "./types.js";

/**
 * GitHub webhook signature verification.
 * Spec: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 *
 * Header format:
 *   X-Hub-Signature-256: sha256=<hex>
 *
 * Signed string: the raw request body. Idempotency: GitHub provides a
 * stable `X-GitHub-Delivery` UUID per delivery; we surface it as the
 * external_delivery_id.
 */
export const verifyGitHub: VerifyInboundWebhook = (
  rawBody,
  headers,
  secret,
) => {
  const externalDeliveryId = headers.get("x-github-delivery") ?? undefined;

  const sig = headers.get("x-hub-signature-256");
  if (!sig) {
    return {
      verified: false,
      reason: "missing X-Hub-Signature-256 header",
      external_delivery_id: externalDeliveryId,
    };
  }

  if (!sig.startsWith("sha256=")) {
    return {
      verified: false,
      reason: "X-Hub-Signature-256 missing sha256= prefix",
      external_delivery_id: externalDeliveryId,
    };
  }

  const provided = sig.slice("sha256=".length);
  if (!/^[0-9a-f]+$/i.test(provided)) {
    return {
      verified: false,
      reason: "X-Hub-Signature-256 hex is malformed",
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
