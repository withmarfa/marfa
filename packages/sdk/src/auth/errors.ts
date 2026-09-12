/**
 * Typed OAuth error surface. Mirrors the wire `error` codes from
 * RFC 6749 §5.2 and the rotation-replay extension.
 */

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "invalid_token"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "access_denied"
  | "insufficient_scope"
  | "token_reuse_detected"
  | "server_error"
  | "temporarily_unavailable"
  // RFC 8628 (Device Authorization Grant) — codes returned by the
  // /device/token polling endpoint. `authorization_pending` and
  // `slow_down` are normal-flow signals but bubble up if the SDK's
  // polling helper isn't used.
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  // RFC 7591 (Dynamic Client Registration) — the registration endpoint's own
  // refusals. Both mean nothing was minted, so a caller holding a working
  // registration keeps it rather than clearing one it cannot replace.
  | "invalid_client_metadata"
  | "invalid_redirect_uri";

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly status: number;

  constructor(code: OAuthErrorCode, message: string, status = 400) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}
