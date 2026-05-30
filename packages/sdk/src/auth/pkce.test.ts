import { describe, it, expect, vi, afterEach } from "vitest";
import { sha256 } from "./sha256.js";
import { computeCodeChallenge, generateCodeVerifier } from "./pkce.js";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("sha256 (pure-JS)", () => {
  // FIPS 180-4 known-answer vectors.
  it("hashes the empty string", () => {
    expect(hex(sha256(enc("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('hashes "abc"', () => {
    expect(hex(sha256(enc("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes a 56-byte multi-block input", () => {
    expect(
      hex(
        sha256(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });
});

describe("computeCodeChallenge", () => {
  // RFC 7636 Appendix B reference vector.
  const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches the RFC 7636 vector via Web Crypto", async () => {
    expect(await computeCodeChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("matches the RFC 7636 vector via the JS fallback (no crypto.subtle)", async () => {
    // Simulate an insecure-context browser: crypto.getRandomValues is
    // present, crypto.subtle is not.
    const realGetRandomValues = globalThis.crypto.getRandomValues.bind(
      globalThis.crypto,
    );
    vi.stubGlobal("crypto", { getRandomValues: realGetRandomValues });
    expect(globalThis.crypto.subtle).toBeUndefined();
    expect(await computeCodeChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("agrees with Web Crypto on a generated verifier", async () => {
    const verifier = generateCodeVerifier();
    const viaSubtle = await computeCodeChallenge(verifier);
    const realGetRandomValues = globalThis.crypto.getRandomValues.bind(
      globalThis.crypto,
    );
    vi.stubGlobal("crypto", { getRandomValues: realGetRandomValues });
    const viaFallback = await computeCodeChallenge(verifier);
    expect(viaFallback).toBe(viaSubtle);
  });
});
