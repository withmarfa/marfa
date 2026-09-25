import { hkdfSync, randomBytes } from "node:crypto";

/**
 * Keys derived from `MARFA_AUTH_SECRET` via HKDF-SHA256, one per purpose,
 * each scoped by an `info` string from `SECRET_INFO`: rotating the master
 * secret changes every key derived from it.
 */

/**
 * Failures here indicate operator misconfiguration. They are not user-facing
 * API errors, so a route handler surfaces a generic 500 rather than the
 * message; a plain Error keeps this module free of `@withmarfa/shared`.
 */
class DerivedKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivedKeyError";
  }
}

const SALT = Buffer.from("marfa-secret-encryption", "utf8");
const KEY_LENGTH_BYTES = 32;

function getMasterSecret(): Buffer {
  const raw = process.env.MARFA_AUTH_SECRET;
  if (raw && raw.length >= 16) return Buffer.from(raw, "utf8");
  // `loadConfig()` enforces the secret at boot in production; this is the
  // fail-closed backstop, so a path that reaches here without one throws
  // rather than deriving from a per-process random key that would not
  // survive a restart.
  if (process.env.NODE_ENV === "production") {
    throw new DerivedKeyError(
      "MARFA_AUTH_SECRET must be set to at least 32 characters in production",
    );
  }
  // Outside production a stable per-process secret keeps derivation
  // deterministic within one process without requiring the variable.
  devFallbackSecret ??= randomBytes(32);
  return devFallbackSecret;
}
let devFallbackSecret: Buffer | null = null;

/** A key for one purpose, derived from the master secret under `info`. */
export function deriveKey(info: string): Buffer {
  const derived = hkdfSync(
    "sha256",
    getMasterSecret(),
    SALT,
    Buffer.from(info, "utf8"),
    KEY_LENGTH_BYTES,
  );
  return Buffer.from(derived);
}

/** The purposes a key is derived for, so every call site reads its `info`
 *  from one place. */
export const SECRET_INFO = {
  /** The MAC over an instance-served blob link's hash and expiry. */
  blobLink: "blob-link",
} as const;
