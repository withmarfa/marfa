/**
 * Web Crypto GitHub-signature verifier for inbound webhooks.
 * Spec: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 *
 * Header format:
 *   X-Hub-Signature-256: sha256=<hex>
 *
 * Signed string: the raw request body. GitHub provides a stable
 * `X-GitHub-Delivery` UUID per delivery, surfaced as `delivery_id`.
 */
import type { VerifyResult } from "./verify-hmac-sha256.js";

function constantTimeEqualsHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function verifyGitHub(
  rawBody: ArrayBuffer,
  headers: Headers,
  secret: string,
): Promise<VerifyResult> {
  const deliveryId = headers.get("x-github-delivery") ?? undefined;

  const sig = headers.get("x-hub-signature-256");
  if (!sig) {
    return {
      verified: false,
      reason: "missing_signature_header",
      delivery_id: deliveryId,
    };
  }
  if (!sig.startsWith("sha256=")) {
    return {
      verified: false,
      reason: "signature_format_invalid",
      delivery_id: deliveryId,
    };
  }
  const provided = sig.slice("sha256=".length).toLowerCase();
  if (!/^[0-9a-f]+$/i.test(provided)) {
    return {
      verified: false,
      reason: "signature_format_invalid",
      delivery_id: deliveryId,
    };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, rawBody);
  const expectedHex = bufferToHex(sigBuf);

  if (!constantTimeEqualsHex(provided, expectedHex)) {
    return {
      verified: false,
      reason: "signature_mismatch",
      delivery_id: deliveryId,
    };
  }
  return { verified: true, delivery_id: deliveryId };
}
