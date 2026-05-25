import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Reason a webhook signature did not validate. Receivers should treat
 * any non-`valid` result as "do not trust this delivery".
 *
 * - `malformed` — the signature header was missing, empty, or not in
 *   the `t=<unix>,v1=<hex>` form.
 * - `too_old` — the parsed timestamp is outside the tolerance window
 *   (default: more than 300s in the past, or more than 60s in the
 *   future to allow for mild clock skew).
 * - `mismatch` — the recomputed HMAC did not match the provided hex.
 */
export type WebhookVerifyReason = "malformed" | "too_old" | "mismatch";

export interface WebhookVerifyResult {
  valid: boolean;
  reason?: WebhookVerifyReason;
}

export interface VerifyWebhookSignatureInput {
  /** The `X-Marfa-Signature` header value as received. */
  header: string | null | undefined;
  /** The raw HTTP request body, exactly as received (pre-JSON-parse). */
  rawBody: string;
  /** The webhook secret shared with the Marfa server. */
  secret: string;
  /**
   * Maximum age (seconds in the past) to accept. Default 300 (5 min).
   * Matches the documented platform contract.
   */
  tolerance?: number;
  /**
   * Maximum future skew (seconds) to tolerate. Default 60 — matches
   * the documented platform contract. Timestamps further ahead than
   * this are rejected as `too_old` (name is legacy; it captures
   * "outside the acceptable window").
   */
  futureSkew?: number;
  /**
   * Injection point for tests. Defaults to `Date.now() / 1000`.
   */
  nowSeconds?: () => number;
}

const STRIPE_HEADER_RE = /^t=(\d+),v1=([0-9a-f]+)$/;

/**
 * Verify a webhook signature produced by the Marfa server. The server
 * emits `X-Marfa-Signature: t=<unix>,v1=<hex-sha256>` where the HMAC
 * signs `<timestamp>.<raw-body>`.
 *
 * Pass the raw body string exactly as received (before JSON.parse) and
 * the same `secret` configured on the webhook. Returns a structured
 * result so receivers can log the failure reason without retrying on
 * a permanently-malformed payload.
 */
export function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): WebhookVerifyResult {
  const tolerance = input.tolerance ?? 300;
  const futureSkew = input.futureSkew ?? 60;
  const nowSeconds = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  const header = input.header?.trim() ?? "";
  const match = STRIPE_HEADER_RE.exec(header);
  if (!match?.[1] || !match[2]) {
    return { valid: false, reason: "malformed" };
  }

  const timestamp = match[1];
  const providedSig = match[2];

  const ts = Number(timestamp);
  const now = nowSeconds();
  if (now - ts > tolerance || ts - now > futureSkew) {
    return { valid: false, reason: "too_old" };
  }

  const computedSig = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest("hex");

  // Both values are hex digests of a fixed algorithm output (sha256),
  // so they must be the same length if well-formed. Check length first
  // to avoid timingSafeEqual's throw-on-mismatch. If lengths differ,
  // that's a mismatch either way.
  if (computedSig.length !== providedSig.length) {
    return { valid: false, reason: "mismatch" };
  }

  const computedBuf = Buffer.from(computedSig, "utf8");
  const providedBuf = Buffer.from(providedSig, "utf8");
  if (!timingSafeEqual(computedBuf, providedBuf)) {
    return { valid: false, reason: "mismatch" };
  }

  return { valid: true };
}
