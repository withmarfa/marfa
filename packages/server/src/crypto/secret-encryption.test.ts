import { describe, expect, it } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  SECRET_INFO,
} from "./secret-encryption.js";

describe("secret-encryption", () => {
  it("round-trips a plaintext through encrypt + decrypt", () => {
    const plain = "abc123-test-secret-value";
    const ciphertext = encryptSecret(plain, SECRET_INFO.inboundWebhookSecret);
    const decrypted = decryptSecret(
      ciphertext,
      SECRET_INFO.inboundWebhookSecret,
    );
    expect(decrypted).toBe(plain);
  });

  it("produces a different ciphertext on each call (per-row IV)", () => {
    const a = encryptSecret("same-input", SECRET_INFO.inboundWebhookSecret);
    const b = encryptSecret("same-input", SECRET_INFO.inboundWebhookSecret);
    expect(a).not.toBe(b);
  });

  it("rejects ciphertext encrypted under a different info string", () => {
    const ciphertext = encryptSecret(
      "topsecret",
      SECRET_INFO.inboundWebhookSecret,
    );
    expect(() =>
      decryptSecret(ciphertext, SECRET_INFO.connectionOauthToken),
    ).toThrow(/decrypt/i);
  });

  it("rejects truncated ciphertext", () => {
    const ciphertext = encryptSecret(
      "topsecret",
      SECRET_INFO.inboundWebhookSecret,
    );
    const truncated = ciphertext.slice(0, 20);
    expect(() =>
      decryptSecret(truncated, SECRET_INFO.inboundWebhookSecret),
    ).toThrow();
  });

  it("rejects tampered ciphertext (auth tag mismatch)", () => {
    const ciphertext = encryptSecret(
      "topsecret",
      SECRET_INFO.inboundWebhookSecret,
    );
    // Flip the last byte — corrupts the GCM ciphertext, fails AEAD.
    const last = ciphertext.slice(-1);
    const tampered = ciphertext.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(() =>
      decryptSecret(tampered, SECRET_INFO.inboundWebhookSecret),
    ).toThrow(/decrypt/i);
  });

  it("hex output decodes cleanly", () => {
    const ciphertext = encryptSecret("x", SECRET_INFO.inboundWebhookSecret);
    expect(ciphertext).toMatch(/^[0-9a-f]+$/);
    // 12-byte IV + 16-byte tag + at-least-1-byte ciphertext = ≥29 bytes = ≥58 hex chars.
    expect(ciphertext.length).toBeGreaterThanOrEqual(58);
  });
});
