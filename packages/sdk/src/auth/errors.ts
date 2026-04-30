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
  | "temporarily_unavailable";

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
