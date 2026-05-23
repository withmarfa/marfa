/**
 * Google "channel" push-notification verification.
 *
 * Google's `channels.watch` push notifications do NOT carry a body or
 * a signed payload — Google POSTs to the registered `address` with
 * only headers describing what changed (resource id, channel id,
 * resource state). Verification is therefore by **shared-secret
 * header echo**: when the channel is created, we pass an opaque
 * `token` parameter; Google echoes it on every push as
 * `X-Goog-Channel-Token`. We compare against the channel's stored
 * secret in constant time.
 *
 * Pre-conditions for verification:
 *   - `X-Goog-Channel-Token` header present and matches `secret`.
 *   - `X-Goog-Channel-Id` header present (sanity check + dedup key).
 *
 * The `external_delivery_id` is `<channel-id>:<message-number>` so
 * the control plane's idempotency KV de-duplicates Google retries
 * (Google retries pushes when the receiver doesn't 200 within a few
 * seconds; same channel + same message number = same delivery).
 *
 * Spec reference:
 *   https://developers.google.com/calendar/api/guides/push
 *   https://developers.google.com/workspace/drive/api/guides/push
 */
import type { Verifier } from "./types.js";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Returns the verification result synchronously — Google push
 * notifications carry no body and don't need any `subtle.crypto`
 * round-trip. The exported function below wraps this in `Promise.resolve`
 * so it conforms to the async `Verifier` contract without an
 * unnecessary `async` keyword (which the lint config flags).
 */
import type { VerifyResult } from "./types.js";

function verifyGoogleChannelSync(
  headers: Headers,
  secret: string,
): VerifyResult {
  const token = headers.get("x-goog-channel-token");
  if (token === null || token.length === 0) {
    return { verified: false, reason: "missing_x_goog_channel_token" };
  }

  if (secret.length === 0) {
    return { verified: false, reason: "channel_secret_unset" };
  }

  if (!constantTimeEqual(token, secret)) {
    return { verified: false, reason: "channel_token_mismatch" };
  }

  const channelId = headers.get("x-goog-channel-id");
  if (channelId === null || channelId.length === 0) {
    return { verified: false, reason: "missing_x_goog_channel_id" };
  }

  const messageNumber = headers.get("x-goog-message-number");
  const deliveryId =
    messageNumber !== null && messageNumber.length > 0
      ? `${channelId}:${messageNumber}`
      : channelId;

  return { verified: true, external_delivery_id: deliveryId };
}

export const verifyGoogleChannel: Verifier = (rawBody, headers, secret) => {
  void rawBody; // No body on Google push notifications.
  return Promise.resolve(verifyGoogleChannelSync(headers, secret));
};
