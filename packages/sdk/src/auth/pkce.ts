/**
 * PKCE primitives — RFC 7636. Verifier is 43–128 chars of base64url
 * generated from random bytes; challenge is BASE64URL(SHA-256(verifier)).
 *
 * Uses Web Crypto so the auth subpath is universal (browser + Node 15+
 * + Cloudflare Workers + Deno). The SDK's data-plane root path keeps
 * its node:crypto dependency for HMAC webhook verification; nothing
 * Node-only leaks into ./auth.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a fresh PKCE code verifier. Default length 64 — within RFC's
 * 43–128 range; longer is harder to brute force, shorter speeds up dev
 * tooling. 64 is a balanced default.
 */
export function generateCodeVerifier(length = 64): string {
  if (length < 43 || length > 128) {
    throw new Error(
      `PKCE verifier length must be 43-128, got ${String(length)}`,
    );
  }
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += ALPHABET.charAt(byte % ALPHABET.length);
  }
  return out;
}

/** Compute the S256 challenge: BASE64URL(SHA-256(verifier)). */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(hash));
}

/** Generate a random opaque state value for CSRF protection on the redirect. */
export function generateState(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
