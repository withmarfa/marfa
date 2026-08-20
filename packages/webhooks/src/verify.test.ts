/**
 * Adapter test suite for `@withmarfa/webhooks`.
 *
 * Runs under Node's vitest (default environment) — Node 20+ exposes
 * Web Crypto natively as `globalThis.crypto.subtle`, so the same
 * implementation that runs in Cloudflare Workers also runs here.
 *
 * The cross-runtime parity claim is structural: both runtimes import
 * this code path (no separate `node:crypto` adapter). Workers-side
 * coverage is exercised by the server's webhook-receipt suite. Drift
 * between the two is impossible because there is no second
 * implementation to drift from.
 */
import { describe, it, expect } from "vitest";
import {
  ADAPTERS,
  isVerificationMethod,
  VERIFICATION_METHODS,
  verifyHmacSha256,
  verifySlack,
  verifyStripe,
  verifyGitHub,
  verifyCloudflareEmail,
} from "./index.js";

const SECRET = "topsecret-shared-key";

// ---------------------------------------------------------------------------
// Helpers — sign payloads with Web Crypto so the test reproduces the
// same algorithm the verifier uses.
// ---------------------------------------------------------------------------

async function hmacHex(secret: string, data: ArrayBuffer): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, data);
  let hex = "";
  const bytes = new Uint8Array(sig);
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function asBuffer(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// ---------------------------------------------------------------------------
// Dispatch / discriminated-union surface
// ---------------------------------------------------------------------------

describe("verification dispatch", () => {
  it("isVerificationMethod accepts the four supported methods", () => {
    for (const m of VERIFICATION_METHODS) {
      expect(isVerificationMethod(m)).toBe(true);
    }
  });

  it("isVerificationMethod rejects unknown methods, including the unsupported 'custom' method", () => {
    expect(isVerificationMethod("custom")).toBe(false);
    expect(isVerificationMethod("rot13")).toBe(false);
    expect(isVerificationMethod("")).toBe(false);
  });

  it("ADAPTERS table has an entry for every method", () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([
      "cloudflare-email",
      "github",
      "google-channel",
      "hmac-sha256",
      "slack",
      "stripe",
    ]);
  });
});

// ---------------------------------------------------------------------------
// hmac-sha256
// ---------------------------------------------------------------------------

describe("verifyHmacSha256", () => {
  it("verifies a correctly signed body", async () => {
    const body = asBuffer('{"hello":"world"}');
    const sig = await hmacHex(SECRET, body);
    const headers = new Headers({
      "x-marfa-signature": `sha256=${sig}`,
      "x-marfa-delivery-id": "delivery_42",
    });
    const r = await verifyHmacSha256(body, headers, SECRET);
    expect(r.verified).toBe(true);
    expect(r.external_delivery_id).toBe("delivery_42");
  });

  it("accepts a bare hex signature without the sha256= prefix", async () => {
    const body = asBuffer("payload");
    const sig = await hmacHex(SECRET, body);
    const headers = new Headers({ "x-marfa-signature": sig });
    const r = await verifyHmacSha256(body, headers, SECRET);
    expect(r.verified).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const body = asBuffer('{"hello":"world"}');
    const sig = await hmacHex(SECRET, body);
    const headers = new Headers({ "x-marfa-signature": `sha256=${sig}` });
    const r = await verifyHmacSha256(
      asBuffer('{"hello":"WORLD"}'),
      headers,
      SECRET,
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("rejects when the signature header is missing", async () => {
    const r = await verifyHmacSha256(asBuffer("x"), new Headers(), SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("missing_signature_header");
  });

  it("rejects a malformed (non-hex) signature", async () => {
    const headers = new Headers({ "x-marfa-signature": "sha256=NOTHEX!" });
    const r = await verifyHmacSha256(asBuffer("x"), headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("signature_format_invalid");
  });

  it("is case-insensitive on the hex chars", async () => {
    const body = asBuffer("hi");
    const sig = await hmacHex(SECRET, body);
    const headers = new Headers({
      "x-marfa-signature": `sha256=${sig.toUpperCase()}`,
    });
    const r = await verifyHmacSha256(body, headers, SECRET);
    expect(r.verified).toBe(true);
  });

  it("surfaces external_delivery_id even when verification fails", async () => {
    const body = asBuffer("x");
    const headers = new Headers({
      "x-marfa-signature": "sha256=00",
      "x-marfa-delivery-id": "still-attributable",
    });
    const r = await verifyHmacSha256(body, headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.external_delivery_id).toBe("still-attributable");
  });
});

// ---------------------------------------------------------------------------
// slack
// ---------------------------------------------------------------------------

describe("verifySlack", () => {
  async function expected(ts: string, body: ArrayBuffer): Promise<string> {
    const baseString = `v0:${ts}:${new TextDecoder().decode(body)}`;
    const baseBytes = new TextEncoder().encode(baseString);
    return `v0=${await hmacHex(SECRET, baseBytes.buffer.slice(baseBytes.byteOffset, baseBytes.byteOffset + baseBytes.byteLength))}`;
  }
  function hdrs(ts: string, sig: string): Headers {
    return new Headers({
      "x-slack-signature": sig,
      "x-slack-request-timestamp": ts,
    });
  }

  it("verifies a fresh, correctly signed request", async () => {
    const body = asBuffer("token=abc&team_id=T123");
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await expected(ts, body);
    const r = await verifySlack(body, hdrs(ts, sig), SECRET);
    expect(r.verified).toBe(true);
  });

  it("rejects a stale timestamp (older than the 5-minute replay window)", async () => {
    const body = asBuffer("x");
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 30);
    const sig = await expected(ts, body);
    const r = await verifySlack(body, hdrs(ts, sig), SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("timestamp_outside_replay_window");
  });

  it("rejects a timestamp far in the future (beyond the clock-skew tolerance)", async () => {
    const body = asBuffer("x");
    const ts = String(Math.floor(Date.now() / 1000) + 60 * 30);
    const sig = await expected(ts, body);
    const r = await verifySlack(body, hdrs(ts, sig), SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("timestamp_outside_replay_window");
  });

  it("verifies a timestamp slightly in the future (within the clock-skew tolerance)", async () => {
    const body = asBuffer("token=abc&team_id=T123");
    const ts = String(Math.floor(Date.now() / 1000) + 30);
    const sig = await expected(ts, body);
    const r = await verifySlack(body, hdrs(ts, sig), SECRET);
    expect(r.verified).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const body = asBuffer("original");
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await expected(ts, body);
    const r = await verifySlack(asBuffer("tampered"), hdrs(ts, sig), SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("rejects when X-Slack-Signature is missing", async () => {
    const r = await verifySlack(asBuffer("x"), new Headers(), SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("missing_signature_header");
  });

  it("rejects when X-Slack-Request-Timestamp is missing", async () => {
    const headers = new Headers({ "x-slack-signature": "v0=00" });
    const r = await verifySlack(asBuffer("x"), headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("missing_timestamp_header");
  });
});

// ---------------------------------------------------------------------------
// stripe
// ---------------------------------------------------------------------------

describe("verifyStripe", () => {
  async function header(ts: string, body: ArrayBuffer): Promise<string> {
    const baseString = `${ts}.${new TextDecoder().decode(body)}`;
    const baseBytes = new TextEncoder().encode(baseString);
    const v1 = await hmacHex(
      SECRET,
      baseBytes.buffer.slice(
        baseBytes.byteOffset,
        baseBytes.byteOffset + baseBytes.byteLength,
      ),
    );
    return `t=${ts},v1=${v1}`;
  }

  it("verifies a correctly signed payload and surfaces external_delivery_id", async () => {
    const body = asBuffer('{"id":"evt_123","type":"charge.succeeded"}');
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = new Headers({ "stripe-signature": await header(ts, body) });
    const r = await verifyStripe(body, headers, SECRET);
    expect(r.verified).toBe(true);
    // `<ts>.<first-16-of-v1>` per Stripe's documented retry contract.
    expect(r.external_delivery_id).toMatch(
      new RegExp(`^${ts}\\.[0-9a-f]{16}$`),
    );
  });

  it("rejects when the timestamp is older than the replay window", async () => {
    const body = asBuffer("payload");
    const ts = String(Math.floor(Date.now() / 1000) - 60 * 30);
    const headers = new Headers({ "stripe-signature": await header(ts, body) });
    const r = await verifyStripe(body, headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("timestamp_outside_replay_window");
  });

  it("rejects a timestamp far in the future (beyond the clock-skew tolerance)", async () => {
    const body = asBuffer("payload");
    const ts = String(Math.floor(Date.now() / 1000) + 60 * 30);
    const headers = new Headers({ "stripe-signature": await header(ts, body) });
    const r = await verifyStripe(body, headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("timestamp_outside_replay_window");
  });

  it("verifies a timestamp slightly in the future (within the clock-skew tolerance)", async () => {
    const body = asBuffer('{"id":"evt_123","type":"charge.succeeded"}');
    const ts = String(Math.floor(Date.now() / 1000) + 30);
    const headers = new Headers({ "stripe-signature": await header(ts, body) });
    const r = await verifyStripe(body, headers, SECRET);
    expect(r.verified).toBe(true);
  });

  it("rejects a malformed Stripe-Signature header", async () => {
    const headers = new Headers({ "stripe-signature": "garbage" });
    const r = await verifyStripe(asBuffer("x"), headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("signature_format_invalid");
  });

  it("rejects when Stripe-Signature is missing", async () => {
    const r = await verifyStripe(asBuffer("x"), new Headers(), SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("missing_signature_header");
  });
});

// ---------------------------------------------------------------------------
// github
// ---------------------------------------------------------------------------

describe("verifyGitHub", () => {
  it("verifies a correctly-signed payload and surfaces X-GitHub-Delivery", async () => {
    const body = asBuffer('{"action":"opened","number":1}');
    const sig = await hmacHex(SECRET, body);
    const headers = new Headers({
      "x-hub-signature-256": `sha256=${sig}`,
      "x-github-delivery": "abc-def-123",
    });
    const r = await verifyGitHub(body, headers, SECRET);
    expect(r.verified).toBe(true);
    expect(r.external_delivery_id).toBe("abc-def-123");
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const body = asBuffer("x");
    const sig = await hmacHex("wrong-secret", body);
    const headers = new Headers({ "x-hub-signature-256": `sha256=${sig}` });
    const r = await verifyGitHub(body, headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("rejects a header without the sha256= prefix", async () => {
    const body = asBuffer("x");
    const sig = await hmacHex(SECRET, body);
    const headers = new Headers({ "x-hub-signature-256": sig });
    const r = await verifyGitHub(body, headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("signature_format_invalid");
  });

  it("rejects when the header is absent", async () => {
    const r = await verifyGitHub(asBuffer("x"), new Headers(), SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("missing_signature_header");
  });

  it("surfaces external_delivery_id even on failed verification", async () => {
    const body = asBuffer("x");
    const headers = new Headers({
      "x-hub-signature-256": "sha256=00",
      "x-github-delivery": "still-attributable",
    });
    const r = await verifyGitHub(body, headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.external_delivery_id).toBe("still-attributable");
  });
});

// ---------------------------------------------------------------------------
// cloudflare-email
// ---------------------------------------------------------------------------

describe("verifyCloudflareEmail", () => {
  it("verifies a correctly-signed email envelope", async () => {
    const body = asBuffer(
      '{"from":{"address":"sender@example.com"},"subject":"hi","text_body":"hello"}',
    );
    const sig = await hmacHex(SECRET, body);
    const headers = new Headers({
      "content-type": "application/json",
      "x-marfa-signature": `sha256=${sig}`,
      "x-marfa-delivery-id": "<CA+abc@mail.example.com>",
    });
    const r = await verifyCloudflareEmail(body, headers, SECRET);
    expect(r.verified).toBe(true);
    expect(r.external_delivery_id).toBe("<CA+abc@mail.example.com>");
  });

  it("rejects a payload signed with the wrong worker secret", async () => {
    const body = asBuffer('{"x":1}');
    const sig = await hmacHex("wrong-worker-secret", body);
    const headers = new Headers({ "x-marfa-signature": `sha256=${sig}` });
    const r = await verifyCloudflareEmail(body, headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("signature_mismatch");
  });

  it("surfaces Message-ID as external_delivery_id even when verification fails", async () => {
    const body = asBuffer('{"x":1}');
    const headers = new Headers({
      "x-marfa-signature": "sha256=00",
      "x-marfa-delivery-id": "<replayed-message-id@example.com>",
    });
    const r = await verifyCloudflareEmail(body, headers, SECRET);
    expect(r.verified).toBe(false);
    expect(r.external_delivery_id).toBe("<replayed-message-id@example.com>");
  });
});
