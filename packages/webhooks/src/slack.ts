/**
 * Slack signature verification.
 * Spec: https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Headers:
 *   X-Slack-Signature: v0=<hex>
 *   X-Slack-Request-Timestamp: <unix-seconds>
 *
 * Signed string: `v0:<timestamp>:<rawBody-as-utf8>`. Freshness is
 * backward-looking against a 5-minute replay window — Slack's documented
 * limit — with a small clock-skew tolerance for future timestamps.
 *
 * Slack's Events API doesn't ship a per-event delivery-id header; the
 * `event_id` lives inside the JSON body. Callers fall back to a
 * request-time identifier when no `external_delivery_id` is returned.
 */
import type { Verifier } from "./types.js";
import { constantTimeEqualsString, hmacSha256Hex } from "./crypto.js";

const REPLAY_WINDOW_SECONDS = 60 * 5;
// Freshness is backward-looking: a timestamp older than the replay window
// is rejected, but a future timestamp is only tolerated up to a small
// clock-skew allowance. A symmetric `Math.abs` check would accept
// timestamps a full window into the future, doubling the effective replay
// window an attacker can operate in.
const MAX_CLOCK_SKEW_SECONDS = 60;

export const verifySlack: Verifier = async (rawBody, headers, secret) => {
  const sig = headers.get("x-slack-signature");
  const ts = headers.get("x-slack-request-timestamp");

  if (!sig) return { verified: false, reason: "missing_signature_header" };
  if (!ts) return { verified: false, reason: "missing_timestamp_header" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    return { verified: false, reason: "timestamp_not_numeric" };
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - tsNum;
  if (
    ageSeconds > REPLAY_WINDOW_SECONDS ||
    ageSeconds < -MAX_CLOCK_SKEW_SECONDS
  ) {
    return { verified: false, reason: "timestamp_outside_replay_window" };
  }

  // Slack signs over `v0:<ts>:<body-as-utf8>`. We have to decode the
  // body bytes through TextDecoder and re-encode the full base string
  // through TextEncoder for the HMAC input — concatenation in the byte
  // domain isn't safe (UTF-8 multi-byte sequences could split).
  const bodyText = new TextDecoder("utf-8").decode(rawBody);
  const baseString = `v0:${ts}:${bodyText}`;
  const expectedHex = await hmacSha256Hex(
    secret,
    new TextEncoder().encode(baseString),
  );
  const expected = `v0=${expectedHex}`;

  if (!constantTimeEqualsString(sig, expected)) {
    return { verified: false, reason: "signature_mismatch" };
  }
  return { verified: true };
};
