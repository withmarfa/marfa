import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerifyInboundWebhook } from "./types.js";

/**
 * Slack signature verification.
 * Spec: https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Headers:
 *   X-Slack-Signature: v0=<hex>
 *   X-Slack-Request-Timestamp: <unix-seconds>
 *
 * Signed string: `v0:<timestamp>:<rawBody>`. The timestamp is checked
 * against a 5-minute replay window — Slack's documented limit.
 *
 * Slack itself doesn't ship a per-event delivery-id header on Events
 * API webhooks; the `event_id` lives inside the JSON body. The route
 * handler can fall back to a request-derived id when the adapter
 * doesn't surface one.
 */
const REPLAY_WINDOW_SECONDS = 60 * 5;

export const verifySlack: VerifyInboundWebhook = (rawBody, headers, secret) => {
  const sig = headers.get("x-slack-signature");
  const ts = headers.get("x-slack-request-timestamp");

  if (!sig) {
    return { verified: false, reason: "missing X-Slack-Signature header" };
  }
  if (!ts) {
    return {
      verified: false,
      reason: "missing X-Slack-Request-Timestamp header",
    };
  }

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    return {
      verified: false,
      reason: "X-Slack-Request-Timestamp is not numeric",
    };
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) {
    return {
      verified: false,
      reason: `timestamp outside replay window (${String(ageSeconds)}s > ${String(REPLAY_WINDOW_SECONDS)}s)`,
    };
  }

  const expected =
    "v0=" +
    createHmac("sha256", secret)
      .update(`v0:${ts}:${rawBody.toString("utf8")}`)
      .digest("hex");

  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { verified: false, reason: "signature mismatch" };
  }

  return { verified: true };
};
