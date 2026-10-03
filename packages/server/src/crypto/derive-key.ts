import { hkdfSync } from "node:crypto";

/**
 * Keys derived from `MARFA_AUTH_SECRET` via HKDF-SHA256, one per purpose,
 * each scoped by an `info` string from `SECRET_INFO`: rotating the master
 * secret changes every key derived from it. The settings schema holds the
 * secret to its rules at boot, so a caller passes `AppConfig.authSecret`.
 */

// The salt is part of every key derived here, so changing its text would
// change every key and invalidate every blob link already issued.
const SALT = Buffer.from("marfa-secret-encryption", "utf8");
const KEY_LENGTH_BYTES = 32;

/** A key for one purpose, derived from the master secret under `info`. */
export function deriveKey(masterSecret: string, info: string): Buffer {
  const derived = hkdfSync(
    "sha256",
    Buffer.from(masterSecret, "utf8"),
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
  readView: "read-view",
} as const;
