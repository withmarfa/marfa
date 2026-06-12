import { describe, expect, it, afterEach } from "vitest";
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

describe("secret-encryption production fail-closed", () => {
  // Snapshot the two env vars these cases mutate so production mode and
  // any injected secret never leak into the rest of the suite (every
  // other test relies on the deterministic dev fallback).
  const savedNodeEnv = process.env.NODE_ENV;
  const savedSecret = process.env.MARFA_AUTH_SECRET;

  function restore(value: string | undefined, key: string): void {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }

  afterEach(() => {
    restore(savedNodeEnv, "NODE_ENV");
    restore(savedSecret, "MARFA_AUTH_SECRET");
  });

  it("throws when encrypting in production with no secret set", () => {
    process.env.NODE_ENV = "production";
    delete process.env.MARFA_AUTH_SECRET;
    expect(() =>
      encryptSecret("topsecret", SECRET_INFO.inboundWebhookSecret),
    ).toThrow(/MARFA_AUTH_SECRET/);
  });

  it("encrypts with the configured secret in production", () => {
    process.env.NODE_ENV = "production";
    process.env.MARFA_AUTH_SECRET = "p".repeat(32);
    const ciphertext = encryptSecret(
      "topsecret",
      SECRET_INFO.inboundWebhookSecret,
    );
    expect(decryptSecret(ciphertext, SECRET_INFO.inboundWebhookSecret)).toBe(
      "topsecret",
    );
  });

  it("round-trips deterministically in dev with no secret set", () => {
    process.env.NODE_ENV = "test";
    delete process.env.MARFA_AUTH_SECRET;
    const ciphertext = encryptSecret(
      "dev-secret",
      SECRET_INFO.connectionOauthToken,
    );
    expect(decryptSecret(ciphertext, SECRET_INFO.connectionOauthToken)).toBe(
      "dev-secret",
    );
  });
});
