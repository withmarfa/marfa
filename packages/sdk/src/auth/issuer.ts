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

/**
 * The OAuth issuer to discover against, given whatever the caller passed.
 *
 * Marfa mounts its authorization server under `/auth`, and its metadata
 * document says so: `issuer` reads `<origin>/auth`. RFC 8414 pairs that
 * with a discovery URL of `<origin>/.well-known/oauth-authorization-server/auth`,
 * inserting the well-known segment before the issuer's path, and the
 * server serves it there. So the pairing is conformant — but only when
 * the issuer carries its path.
 *
 * Callers overwhelmingly pass the API base URL, an origin with no path,
 * because that is the one URL they already have. Discovering against that
 * fails the issuer check, correctly: the document says it speaks for
 * `<origin>/auth` and was asked to speak for `<origin>`. Rather than
 * relaxing the check — the one guard that stops a metadata document
 * pointing a client at another server's token endpoint — a bare origin is
 * resolved to the `/auth` mount it means.
 *
 * An issuer that already carries a path is left alone, so a self-host
 * mounting elsewhere keeps working by passing its real issuer.
 */
export function authIssuerFor(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError(`Issuer is not a URL: ${input}`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.length > 0) return new URL(`${url.origin}${path}`);
  return new URL(`${url.origin}/auth`);
}
