/**
 * Web Crypto Slack-signature verifier for inbound webhooks.
 * Spec: https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Headers:
 *   X-Slack-Signature: v0=<hex>
 *   X-Slack-Request-Timestamp: <unix-seconds>
 *
 * Signed string: `v0:<timestamp>:<rawBody-as-utf8>`. The timestamp is
 * checked against a 5-minute replay window — Slack's documented limit.
 *
 * Slack's Events API doesn't ship a per-event delivery-id header on the
 * envelope; the `event_id` lives inside the JSON body. This adapter
 * returns no `delivery_id`; the control-plane handler falls back to a
 * request-time UUID.
 */
import type { VerifyResult } from "./verify-hmac-sha256.js";

const REPLAY_WINDOW_SECONDS = 60 * 5;

function constantTimeEqualsString(a: string, b: string): boolean {
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

export async function verifySlack(
  rawBody: ArrayBuffer,
  headers: Headers,
  secret: string,
): Promise<VerifyResult> {
  const sig = headers.get("x-slack-signature");
  const ts = headers.get("x-slack-request-timestamp");

  if (!sig) return { verified: false, reason: "missing_signature_header" };
  if (!ts) return { verified: false, reason: "missing_timestamp_header" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    return { verified: false, reason: "timestamp_not_numeric" };
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) {
    return { verified: false, reason: "timestamp_outside_replay_window" };
  }

  // base = "v0:" + ts + ":" + body. Slack signs the body as UTF-8, so we
  // decode + re-encode through TextEncoder for the signing input.
  const bodyText = new TextDecoder("utf-8").decode(rawBody);
  const baseString = `v0:${ts}:${bodyText}`;

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
  const expected = "v0=" + bufferToHex(sigBuf);

  if (!constantTimeEqualsString(sig, expected)) {
    return { verified: false, reason: "signature_mismatch" };
  }
  return { verified: true };
}
