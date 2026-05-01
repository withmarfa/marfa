/**
 * Web Crypto HMAC-SHA256 verifier for inbound webhooks.
 *
 * The Cloudflare Workers runtime exposes `crypto.subtle` with HMAC
 * support, so we can verify signatures without pulling in Node's
 * `node:crypto` (which would require nodejs_compat just for this).
 *
 * Inbound deliveries with this verification method must include:
 *   - `X-Myme-Signature: sha256=<hex>` — HMAC-SHA256 of the raw body
 *     using the subscription's secret as the key.
 *
 * Other adapters (Slack, Stripe, GitHub, custom) will land as Layer 3
 * needs them — each has its own canonical header format. For PR 4 the
 * route returns 501 for non-HMAC methods and surfaces the method name
 * in the error so debugging is obvious.
 */

const SIG_HEADER = "x-myme-signature";

export interface VerifyResult {
  verified: boolean;
  reason?: string;
  /** Sender-supplied delivery id; falls back to a request-time UUID
   *  when absent. The control plane uses this as the idempotency key
   *  in the KV cache. */
  delivery_id?: string;
}

const DELIVERY_ID_HEADER = "x-myme-delivery-id";

/** Constant-time comparison of two equal-length hex strings. Avoids the
 *  trivial timing-leak shortcut of plain string ==. */
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

export async function verifyHmacSha256(
  rawBody: ArrayBuffer,
  headers: Headers,
  secret: string,
): Promise<VerifyResult> {
  const provided = headers.get(SIG_HEADER);
  if (!provided) {
    return { verified: false, reason: "missing_signature_header" };
  }
  const expectedPrefix = "sha256=";
  if (!provided.startsWith(expectedPrefix)) {
    return { verified: false, reason: "signature_format_invalid" };
  }
  const providedHex = provided.slice(expectedPrefix.length).toLowerCase();

  const keyData = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, rawBody);
  const computedHex = bufferToHex(sigBuf);

  if (!constantTimeEqualsHex(providedHex, computedHex)) {
    return { verified: false, reason: "signature_mismatch" };
  }

  const deliveryId = headers.get(DELIVERY_ID_HEADER) ?? undefined;
  return { verified: true, delivery_id: deliveryId };
}
