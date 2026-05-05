/**
 * Web Crypto Stripe-signature verifier for inbound webhooks.
 * Spec: https://stripe.com/docs/webhooks/signatures
 *
 * Header format:
 *   Stripe-Signature: t=<unix-seconds>,v1=<hex>[,v0=<hex>]
 *
 * Signed string: `<timestamp>.<rawBody-as-utf8>`. Replay window is
 * 5 minutes — Stripe's default tolerance.
 *
 * Stripe re-uses the same signature on retries, so the `t.v1[:16]` pair
 * is a stable per-delivery id we surface as `delivery_id` for the
 * control-plane idempotency cache.
 */
import type { VerifyResult } from "./verify-hmac-sha256.js";

const REPLAY_WINDOW_SECONDS = 60 * 5;

interface ParsedSignature {
  t: string;
  v1: string;
}

function parseStripeSignature(header: string): ParsedSignature | null {
  const parts = header.split(",");
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    if (k.trim() === "t") t = v.trim();
    if (k.trim() === "v1" && !v1) v1 = v.trim();
  }
  if (!t || !v1) return null;
  return { t, v1 };
}

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

export async function verifyStripe(
  rawBody: ArrayBuffer,
  headers: Headers,
  secret: string,
): Promise<VerifyResult> {
  const sig = headers.get("stripe-signature");
  if (!sig) return { verified: false, reason: "missing_signature_header" };

  const parsed = parseStripeSignature(sig);
  if (!parsed) return { verified: false, reason: "signature_format_invalid" };

  const tsNum = Number(parsed.t);
  if (!Number.isFinite(tsNum)) {
    return { verified: false, reason: "timestamp_not_numeric" };
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) {
    return { verified: false, reason: "timestamp_outside_replay_window" };
  }
  if (!/^[0-9a-f]+$/i.test(parsed.v1)) {
    return { verified: false, reason: "signature_format_invalid" };
  }

  const bodyText = new TextDecoder("utf-8").decode(rawBody);
  const baseString = `${parsed.t}.${bodyText}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(baseString),
  );
  const expectedHex = bufferToHex(sigBuf);

  if (!constantTimeEqualsHex(parsed.v1.toLowerCase(), expectedHex)) {
    return { verified: false, reason: "signature_mismatch" };
  }
  return {
    verified: true,
    delivery_id: `${parsed.t}.${parsed.v1.slice(0, 16)}`,
  };
}
