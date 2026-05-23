/**
 * Tests for the `google-channel` adapter.
 *
 * Covers:
 *   - Valid token + valid channel id → verified, external_delivery_id
 *     formatted as `<channel-id>:<message-number>`.
 *   - Missing X-Goog-Channel-Token → `missing_x_goog_channel_token`.
 *   - Token mismatch → `channel_token_mismatch`.
 *   - Missing X-Goog-Channel-Id → `missing_x_goog_channel_id`.
 *   - Missing X-Goog-Message-Number → external_delivery_id falls back
 *     to the bare channel id.
 *   - Empty secret → `channel_secret_unset` (prevents accepting any
 *     token when the channel record didn't persist its secret).
 */
import { describe, it, expect } from "vitest";
import { verifyGoogleChannel } from "./google-channel.js";

const EMPTY_BODY = new ArrayBuffer(0);

function headers(map: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(map)) h.set(k, v);
  return h;
}

describe("verifyGoogleChannel", () => {
  it("verifies a valid token + extracts delivery id from channel id + message number", async () => {
    const result = await verifyGoogleChannel(
      EMPTY_BODY,
      headers({
        "X-Goog-Channel-Token": "secret-abc",
        "X-Goog-Channel-Id": "channel-xyz",
        "X-Goog-Message-Number": "42",
        "X-Goog-Resource-State": "exists",
      }),
      "secret-abc",
    );
    expect(result.verified).toBe(true);
    expect(result.external_delivery_id).toBe("channel-xyz:42");
    expect(result.reason).toBeUndefined();
  });

  it("falls back to bare channel id when X-Goog-Message-Number is missing", async () => {
    const result = await verifyGoogleChannel(
      EMPTY_BODY,
      headers({
        "X-Goog-Channel-Token": "secret-abc",
        "X-Goog-Channel-Id": "channel-xyz",
      }),
      "secret-abc",
    );
    expect(result.verified).toBe(true);
    expect(result.external_delivery_id).toBe("channel-xyz");
  });

  it("rejects when X-Goog-Channel-Token is missing", async () => {
    const result = await verifyGoogleChannel(
      EMPTY_BODY,
      headers({ "X-Goog-Channel-Id": "channel-xyz" }),
      "secret-abc",
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("missing_x_goog_channel_token");
  });

  it("rejects when the token does not match", async () => {
    const result = await verifyGoogleChannel(
      EMPTY_BODY,
      headers({
        "X-Goog-Channel-Token": "wrong-secret",
        "X-Goog-Channel-Id": "channel-xyz",
      }),
      "secret-abc",
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("channel_token_mismatch");
  });

  it("rejects when X-Goog-Channel-Id is missing", async () => {
    const result = await verifyGoogleChannel(
      EMPTY_BODY,
      headers({ "X-Goog-Channel-Token": "secret-abc" }),
      "secret-abc",
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("missing_x_goog_channel_id");
  });

  it("rejects when the channel secret is empty (defends against unset-secret race)", async () => {
    const result = await verifyGoogleChannel(
      EMPTY_BODY,
      headers({
        "X-Goog-Channel-Token": "anything",
        "X-Goog-Channel-Id": "channel-xyz",
      }),
      "",
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("channel_secret_unset");
  });

  it("ignores the request body (Google push notifications carry none)", async () => {
    const nonEmptyBody = new TextEncoder().encode("noise").buffer;
    const result = await verifyGoogleChannel(
      nonEmptyBody,
      headers({
        "X-Goog-Channel-Token": "secret-abc",
        "X-Goog-Channel-Id": "channel-xyz",
        "X-Goog-Message-Number": "1",
      }),
      "secret-abc",
    );
    expect(result.verified).toBe(true);
  });
});
