import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerifyInboundWebhook } from "./types.js";

/**
 * Stripe-style signature verification.
 * Spec: https://stripe.com/docs/webhooks/signatures
 *
 * Header format:
 *   Stripe-Signature: t=<unix-seconds>,v1=<hex>[,v0=<hex>]
 *
 * Signed string: `<timestamp>.<rawBody>`. Replay window is 5 minutes —
 * Stripe's default tolerance.
 *
 * Stripe webhook payloads carry an `id` field on the body (`evt_*`),
 * but the canonical idempotency mechanism is the
 * `Idempotency-Key`-style trip-up at the parser level. We expose
 * `external_delivery_id` from `Stripe-Signature.t + first 16 hex of v1`
 * — unique per delivery and stable enough to dedupe retries; the route
 * handler can fall back to a request-id derived value if the row's
 * unique constraint also catches duplicates downstream.
 */
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

export const verifyStripe: VerifyInboundWebhook = (
  rawBody,
  headers,
  secret,
) => {
  const sig = headers.get("stripe-signature");
  if (!sig) {
    return { verified: false, reason: "missing Stripe-Signature header" };
  }

  const parsed = parseStripeSignature(sig);
  if (!parsed) {
    return { verified: false, reason: "Stripe-Signature is malformed" };
  }

  const tsNum = Number(parsed.t);
  if (!Number.isFinite(tsNum)) {
    return {
      verified: false,
      reason: "Stripe-Signature timestamp is not numeric",
    };
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) {
    return {
      verified: false,
      reason: `timestamp outside replay window (${String(ageSeconds)}s > ${String(REPLAY_WINDOW_SECONDS)}s)`,
    };
  }

  if (!/^[0-9a-f]+$/i.test(parsed.v1)) {
    return { verified: false, reason: "Stripe-Signature v1 is not hex" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${parsed.t}.${rawBody.toString("utf8")}`)
    .digest("hex");

  const a = Buffer.from(parsed.v1, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { verified: false, reason: "signature mismatch" };
  }

  // The (timestamp, signature-prefix) pair is unique per Stripe delivery
  // and stable across retries — Stripe re-uses the same signature when
  // re-delivering the same event.
  return {
    verified: true,
    external_delivery_id: `${parsed.t}.${parsed.v1.slice(0, 16)}`,
  };
};
