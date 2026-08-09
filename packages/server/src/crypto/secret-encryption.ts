import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Failures here indicate corruption or operator misconfiguration (e.g.
 * MARFA_AUTH_SECRET rotated mid-flight without re-encrypting stored
 * ciphertexts). They are not user-facing API errors — the calling route
 * handler should surface a generic 500 / "internal error" rather than
 * forwarding the message. We throw a plain Error to keep this module
 * free of @withmarfa/shared coupling beyond what's strictly necessary.
 */
class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretCryptoError";
  }
}

/**
 * Generic AES-256-GCM encrypt/decrypt for short server-side secrets that
 * the verifier needs back in plaintext (HMAC verification keys, OAuth
 * access/refresh tokens, etc). Used for inbound webhook secrets and
 * OAuth tokens.
 *
 * The key is derived from `MARFA_AUTH_SECRET` via HKDF-SHA256, with a
 * caller-supplied `info` string that scopes derivations: rotating
 * `MARFA_AUTH_SECRET` invalidates ALL stored ciphertexts (callers must
 * re-encrypt as part of a key rotation runbook).
 *
 * On-disk shape: a single hex-encoded string with the layout
 *   [12 bytes IV][16 bytes auth tag][N bytes ciphertext]
 * concatenated then hex-encoded. The format is self-contained — no
 * sidecar columns to keep in sync.
 *
 * Exported as a named module rather than wired through the storage
 * interface because the helper is dialect-agnostic: it operates on
 * strings going in and out of the DB layer.
 */

const SALT = Buffer.from("marfa-secret-encryption", "utf8");
const KEY_LENGTH_BYTES = 32; // AES-256
const IV_LENGTH_BYTES = 12; // GCM standard
const TAG_LENGTH_BYTES = 16;

function getMasterSecret(): Buffer {
  const raw = process.env.MARFA_AUTH_SECRET;
  if (raw && raw.length >= 16) return Buffer.from(raw, "utf8");
  // In production the secret MUST be present and long enough. loadConfig()
  // enforces this at boot; this is the fail-closed backstop so a code path
  // that reaches here without a valid secret throws rather than silently
  // deriving a per-process random key — that key would not survive a
  // restart, leaving every at-rest ciphertext (OAuth tokens, webhook
  // secrets, OAuth callback state, system.credential rows) undecryptable.
  if (process.env.NODE_ENV === "production") {
    throw new SecretCryptoError(
      "MARFA_AUTH_SECRET must be set to at least 32 characters in production",
    );
  }
  // Dev/test only: derive a stable per-process secret so encryption stays
  // deterministic within a single process without requiring the env var.
  devFallbackSecret ??= randomBytes(32);
  return devFallbackSecret;
}
let devFallbackSecret: Buffer | null = null;

function deriveKey(info: string): Buffer {
  const ikm = getMasterSecret();
  const derived = hkdfSync(
    "sha256",
    ikm,
    SALT,
    Buffer.from(info, "utf8"),
    KEY_LENGTH_BYTES,
  );
  return Buffer.from(derived);
}

/**
 * Encrypt a plaintext string into an opaque hex-encoded ciphertext that
 * round-trips through `decryptSecret(..., info)`. The `info` string
 * scopes the HKDF derivation — callers MUST use a stable, descriptive
 * label per use (e.g. "inbound-webhook-secrets",
 * "connection-oauth-tokens"). Different infos produce different keys;
 * mismatched infos at decrypt-time fail loudly.
 */
export function encryptSecret(plaintext: string, info: string): string {
  const key = deriveKey(info);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("hex");
}

/**
 * Decrypt a hex-encoded ciphertext produced by `encryptSecret(..., info)`.
 * Throws a MarfaError with code INTERNAL_ERROR on tag-mismatch or malformed
 * input — callers should treat any error as a fatal corruption signal,
 * not a recoverable condition.
 */
export function decryptSecret(ciphertextHex: string, info: string): string {
  let blob: Buffer;
  try {
    blob = Buffer.from(ciphertextHex, "hex");
  } catch {
    throw new SecretCryptoError("Failed to decode encrypted secret");
  }

  if (blob.length < IV_LENGTH_BYTES + TAG_LENGTH_BYTES + 1) {
    throw new SecretCryptoError("Encrypted secret is truncated");
  }

  const iv = blob.subarray(0, IV_LENGTH_BYTES);
  const tag = blob.subarray(
    IV_LENGTH_BYTES,
    IV_LENGTH_BYTES + TAG_LENGTH_BYTES,
  );
  const ciphertext = blob.subarray(IV_LENGTH_BYTES + TAG_LENGTH_BYTES);

  const key = deriveKey(info);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new SecretCryptoError(
      "Failed to decrypt secret (tag mismatch or wrong info string)",
    );
  }
}

/**
 * Domain-tag constants for the two known consumers. Adding a new
 * consumer? Add the info string here so the call sites all read from
 * one place.
 */
export const SECRET_INFO = {
  inboundWebhookSecret: "inbound-webhook-secrets",
  connectionOauthToken: "connection-oauth-tokens",
  /**
   * API-key credentials carried by `system.credential` rows of
   * `kind: api_key`. Used by integrations that re-present an existing
   * long-lived API key as a Connection's credential — the sync agent
   * re-presentation is the first consumer.
   *
   * The plaintext key continues to live on the local machine that
   * uses it (e.g. `~/.marfa/sync.connection.json` for the sync agent);
   * the encrypted copy on the server is for record-keeping and a
   * future self-service refresh flow. Different domain than
   * `connectionOauthToken` so a future operator audit can
   * distinguish the two ciphertext sets.
   */
  apiKeyCredential: "api-key-credentials",
  /**
   * OAuth callback state. Used by `signOAuthState` /
   * `verifyOAuthState` to opaquely tamper-proof the `state` query
   * param across the round trip from `POST /connections/:id/oauth/start`
   * → upstream provider → `GET /oauth/callback`. Encrypts
   * a small JSON envelope so the callback can recover the
   * connection_id and validate freshness without trusting
   * query-string contents.
   */
  oauthCallbackState: "oauth-callback-state",
} as const;
