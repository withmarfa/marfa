/**
 * PKCE primitives — RFC 7636. Verifier is 43–128 chars of base64url
 * generated from random bytes; challenge is BASE64URL(SHA-256(verifier)).
 *
 * Uses Web Crypto so the auth subpath is universal (browser + Node 15+
 * + Cloudflare Workers + Deno). The SDK's data-plane root path keeps
 * its node:crypto dependency for HMAC webhook verification; nothing
 * Node-only leaks into ./auth.
 *
 * `crypto.subtle` is gated to secure contexts (https / localhost), so on
 * a plain-http, non-localhost origin — a self-hosted web client served
 * over http on a LAN or Tailscale host — it is undefined. The S256
 * challenge falls back to a pure-JS SHA-256 there; everything else uses
 * `crypto.getRandomValues`, which is not secure-context-gated.
 */
import { sha256 } from "./sha256.js";

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

/** Compute the S256 challenge: BASE64URL(SHA-256(verifier)). Prefers Web
 *  Crypto; falls back to a pure-JS SHA-256 in insecure contexts where
 *  `crypto.subtle` is unavailable. */
/**
 * The PKCE challenge is computed here rather than by
 * `oauth4webapi.calculatePKCECodeChallenge`, which is the one piece of
 * the flow that could not move to the library. That helper reaches
 * straight for `crypto.subtle`, and a browser on a plain-http,
 * non-localhost origin does not have it — the self-hosted-on-a-LAN case
 * `sha256.ts` exists for. Verified by running the library's helper with
 * `crypto.subtle` undefined: it throws, while the discovery call and
 * both token exchanges keep working.
 */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  // The lib types `crypto.subtle` as always-present, but it is undefined in
  // an insecure context (a plain-http, non-localhost origin). Read it
  // through an optional structural shape so the JS fallback stays reachable.
  interface SubtleLike {
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  }
  const subtle = (globalThis.crypto as { subtle?: SubtleLike }).subtle;
  const hash = subtle
    ? new Uint8Array(await subtle.digest("SHA-256", data))
    : sha256(data);
  return base64url(hash);
}

/** Generate a random opaque state value for CSRF protection on the redirect. */
export function generateState(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
