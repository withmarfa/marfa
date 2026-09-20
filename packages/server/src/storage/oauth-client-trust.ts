/**
 * Trust classification for OAuth clients, held outside the store so the
 * rule can be read and tested without one. It decides what counts
 * as a "public" (unverified) client.
 *
 * A public client is one with no confidential credential behind it: PKCE
 * only, `token_endpoint_auth_method: none`, and/or the plugin's `public`
 * boolean set. Every unauthenticated Dynamic Client Registration (DCR)
 * client takes this shape — it self-asserts its `client_name` with no
 * vetted identity to back it. The consent screen surfaces this so the user
 * can distinguish a self-asserted name from a confidential client's.
 *
 * The two source columns (`public` boolean, `token_endpoint_auth_method`
 * string) are read as nullable because the plugin's table allows NULL on
 * both. We treat the client as public if EITHER signal indicates it — a
 * confidential client must positively present a secret-bearing auth method,
 * so when both signals are absent/ambiguous we fail toward "unverified"
 * (the safer default for a phishing warning).
 */
export function isPublicClient(
  publicFlag: boolean | null | undefined,
  tokenEndpointAuthMethod: string | null | undefined,
): boolean {
  if (publicFlag === true) return true;
  // `none` is the RFC 7591 / RFC 6749 token-endpoint auth method for a
  // public client. Any `client_secret_*` method marks a confidential one.
  if (tokenEndpointAuthMethod === "none") return true;
  if (
    typeof tokenEndpointAuthMethod === "string" &&
    tokenEndpointAuthMethod.startsWith("client_secret")
  ) {
    return false;
  }
  // Neither signal positively marks the client confidential. A
  // confidential client always carries `public: false` AND a
  // `client_secret_*` auth method; absent both, treat as public so the
  // unverified-app warning errs on the side of caution.
  return publicFlag !== false || tokenEndpointAuthMethod == null;
}
