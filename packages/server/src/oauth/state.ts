/**
 * OAuth callback state signing.
 *
 * The `state` query param ferries data from `POST /connections/:id/oauth/start`
 * → upstream provider's authorize page → `GET /oauth/callback/:provider`.
 * The provider treats it as opaque; we use it to carry the
 * `connection_id` and the `redirect_uri` we registered with the
 * provider so the callback can recover both without trusting the
 * caller.
 *
 * Implementation: AES-256-GCM via the existing `encryptSecret` /
 * `decryptSecret` helpers under a dedicated HKDF domain
 * (`SECRET_INFO.oauthCallbackState`). Encryption gives us tamper
 * resistance + opacity in one primitive — we don't need a separate
 * HMAC because GCM is authenticated.
 *
 * State envelope:
 *   { connection_id, redirect_uri, expires_at_ms, nonce }
 *
 * The 10-minute TTL is generous enough for the user to complete a
 * provider's authorize flow (including 2FA prompts) and short enough
 * that a leaked state can't be replayed days later.
 */
import { randomBytes } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  SECRET_INFO,
} from "../crypto/secret-encryption.js";

export interface OAuthStateEnvelope {
  connection_id: string;
  redirect_uri: string;
  /** PKCE verifier (T-010). Carried through the upstream provider's
   *  authorize → callback redirect inside the encrypted state envelope so
   *  the callback can present it at the token exchange. Optional so an
   *  in-flight envelope without it still decodes; the start route always
   *  emits one. */
  code_verifier?: string;
  /** Epoch ms after which this state is rejected. */
  expires_at_ms: number;
  /** Per-issue random — defends against accidental state reuse and
   *  makes ciphertexts distinct even for identical envelopes. */
  nonce: string;
}

export const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;

export function signOAuthState(input: {
  connection_id: string;
  redirect_uri: string;
  code_verifier?: string;
  ttl_ms?: number;
  now_ms?: number;
}): string {
  const now = input.now_ms ?? Date.now();
  const envelope: OAuthStateEnvelope = {
    connection_id: input.connection_id,
    redirect_uri: input.redirect_uri,
    ...(input.code_verifier !== undefined && {
      code_verifier: input.code_verifier,
    }),
    expires_at_ms: now + (input.ttl_ms ?? DEFAULT_STATE_TTL_MS),
    nonce: randomBytes(12).toString("hex"),
  };
  return encryptSecret(
    JSON.stringify(envelope),
    SECRET_INFO.oauthCallbackState,
  );
}

export type VerifyOAuthStateResult =
  | { ok: true; envelope: OAuthStateEnvelope }
  | { ok: false; reason: "invalid" | "expired" | "malformed" };

export function verifyOAuthState(
  state: string,
  now_ms = Date.now(),
): VerifyOAuthStateResult {
  let plaintext: string;
  try {
    plaintext = decryptSecret(state, SECRET_INFO.oauthCallbackState);
  } catch {
    // Tag mismatch / wrong key / truncated input — all the same to
    // the caller: state is invalid.
    return { ok: false, reason: "invalid" };
  }
  let envelope: OAuthStateEnvelope;
  try {
    envelope = JSON.parse(plaintext) as OAuthStateEnvelope;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof envelope.connection_id !== "string" ||
    typeof envelope.redirect_uri !== "string" ||
    typeof envelope.expires_at_ms !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (envelope.expires_at_ms < now_ms) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, envelope };
}
