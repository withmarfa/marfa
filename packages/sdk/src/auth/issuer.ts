/**
 * Single source of truth for issuer-URL normalization. The storage keys
 * in `MarfaAuth` (`marfa.auth.tokens:<origin>:<client>`) and the discovery
 * cache key in `discovery.ts` must agree on what "the same issuer" means,
 * or the cache misses and storage gets sharded by accident.
 *
 * Normalization = `URL(input).origin` (protocol + host + port, lowercased
 * host, no path / query / hash / trailing slash). Falls through to the
 * input string when the URL constructor throws — used by tests that pass
 * non-URL issuers and would otherwise have to construct an origin by hand.
 */
export function normalizeIssuer(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return input.replace(/\/+$/, "");
  }
}
