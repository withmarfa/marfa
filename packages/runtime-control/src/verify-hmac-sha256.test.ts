import { describe, it, expect } from "vitest";
import { verifyHmacSha256 } from "./verify-hmac-sha256.js";

const SECRET = "shhh-secret";

async function sign(body: ArrayBuffer, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, body);
  let hex = "";
  const bytes = new Uint8Array(sig);
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

describe("verifyHmacSha256", () => {
  it("verifies a correctly signed body", async () => {
    const body = new TextEncoder().encode('{"hello":"world"}').buffer;
    const hex = await sign(body, SECRET);
    const headers = new Headers({
      "x-myme-signature": `sha256=${hex}`,
      "x-myme-delivery-id": "delivery_42",
    });
    const result = await verifyHmacSha256(body, headers, SECRET);
    expect(result.verified).toBe(true);
    expect(result.delivery_id).toBe("delivery_42");
  });

  it("rejects when signature header is missing", async () => {
    const body = new TextEncoder().encode("{}").buffer;
    const result = await verifyHmacSha256(body, new Headers(), SECRET);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("missing_signature_header");
  });

  it("rejects when signature lacks the sha256= prefix", async () => {
    const body = new TextEncoder().encode("{}").buffer;
    const headers = new Headers({ "x-myme-signature": "abcd" });
    const result = await verifyHmacSha256(body, headers, SECRET);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("signature_format_invalid");
  });

  it("rejects when computed HMAC doesn't match", async () => {
    const body = new TextEncoder().encode('{"hello":"world"}').buffer;
    const hex = await sign(body, "different-secret");
    const headers = new Headers({ "x-myme-signature": `sha256=${hex}` });
    const result = await verifyHmacSha256(body, headers, SECRET);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("is case-insensitive on the hex chars", async () => {
    const body = new TextEncoder().encode("hi").buffer;
    const hex = await sign(body, SECRET);
    const headers = new Headers({
      "x-myme-signature": `sha256=${hex.toUpperCase()}`,
    });
    const result = await verifyHmacSha256(body, headers, SECRET);
    expect(result.verified).toBe(true);
  });

  it("falls back to undefined delivery_id when the header is absent", async () => {
    const body = new TextEncoder().encode("hi").buffer;
    const hex = await sign(body, SECRET);
    const headers = new Headers({ "x-myme-signature": `sha256=${hex}` });
    const result = await verifyHmacSha256(body, headers, SECRET);
    expect(result.verified).toBe(true);
    expect(result.delivery_id).toBeUndefined();
  });
});
