import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "./webhooks.js";

function makeHeader(timestamp: number, body: string, secret: string): string {
  const sig = createHmac("sha256", secret)
    .update(`${String(timestamp)}.${body}`)
    .digest("hex");
  return `t=${String(timestamp)},v1=${sig}`;
}

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ event: "item.created", item: { id: "x" } });
  const secret = "whsec_test";
  const now = 1_712_345_678;

  it("accepts a correctly-signed header", () => {
    const header = makeHeader(now, body, secret);
    const result = verifyWebhookSignature({
      header,
      rawBody: body,
      secret,
      nowSeconds: () => now,
    });
    expect(result).toEqual({ valid: true });
  });

  it("rejects a missing or empty header as malformed", () => {
    expect(
      verifyWebhookSignature({
        header: null,
        rawBody: body,
        secret,
        nowSeconds: () => now,
      }),
    ).toEqual({ valid: false, reason: "malformed" });
    expect(
      verifyWebhookSignature({
        header: "",
        rawBody: body,
        secret,
        nowSeconds: () => now,
      }),
    ).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects a header that lacks v1 or t as malformed", () => {
    expect(
      verifyWebhookSignature({
        header: "v1=deadbeef",
        rawBody: body,
        secret,
        nowSeconds: () => now,
      }),
    ).toEqual({ valid: false, reason: "malformed" });
    expect(
      verifyWebhookSignature({
        header: "t=123,v2=deadbeef",
        rawBody: body,
        secret,
        nowSeconds: () => now,
      }),
    ).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects a timestamp older than the tolerance window as too_old", () => {
    // Signed 10 minutes ago; default tolerance is 300s.
    const header = makeHeader(now - 600, body, secret);
    expect(
      verifyWebhookSignature({
        header,
        rawBody: body,
        secret,
        nowSeconds: () => now,
      }),
    ).toEqual({ valid: false, reason: "too_old" });
  });

  it("rejects a far-future timestamp as too_old (outside window)", () => {
    // Signed 10 minutes in the future; default futureSkew is 60s.
    const header = makeHeader(now + 600, body, secret);
    expect(
      verifyWebhookSignature({
        header,
        rawBody: body,
        secret,
        nowSeconds: () => now,
      }),
    ).toEqual({ valid: false, reason: "too_old" });
  });

  it("rejects a header signed with a different secret as mismatch", () => {
    const header = makeHeader(now, body, "wrong-secret");
    expect(
      verifyWebhookSignature({
        header,
        rawBody: body,
        secret,
        nowSeconds: () => now,
      }),
    ).toEqual({ valid: false, reason: "mismatch" });
  });

  it("rejects a tampered body as mismatch", () => {
    const header = makeHeader(now, body, secret);
    expect(
      verifyWebhookSignature({
        header,
        rawBody: body + "tampered",
        secret,
        nowSeconds: () => now,
      }),
    ).toEqual({ valid: false, reason: "mismatch" });
  });
});
