/**
 * Stripe-style signature verification.
 * Spec: https://stripe.com/docs/webhooks/signatures
 *
 * Header format:
 *   Stripe-Signature: t=<unix-seconds>,v1=<hex>[,v0=<hex>]
 *
 * Signed string: `<timestamp>.<rawBody-as-utf8>`. Replay window is
 * 5 minutes — Stripe's default tolerance.
 *
 * Stripe re-uses the same signature when re-delivering an event, so
 * the (timestamp, signature-prefix) pair is unique per delivery and
 * stable across retries — surfaced as `external_delivery_id`.
 */
import type { Verifier } from "./types.js";
import { constantTimeEqualsHex, hmacSha256Hex } from "./crypto.js";

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

export const verifyStripe: Verifier = async (rawBody, headers, secret) => {
  const sig = headers.get("stripe-signature");
  if (!sig) {
    return { verified: false, reason: "missing_signature_header" };
  }

  const parsed = parseStripeSignature(sig);
  if (!parsed) {
    return { verified: false, reason: "signature_format_invalid" };
  }

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
  const expected = await hmacSha256Hex(
    secret,
    new TextEncoder().encode(baseString),
  );
  if (!constantTimeEqualsHex(parsed.v1, expected)) {
    return { verified: false, reason: "signature_mismatch" };
  }

  return {
    verified: true,
    external_delivery_id: `${parsed.t}.${parsed.v1.slice(0, 16)}`,
  };
};
