import { createHash } from "node:crypto";
import { join } from "node:path";
import type { StoreIdentity } from "../local/types.js";

/**
 * The one directory under `userData` every store lives beneath.
 *
 * Named rather than written at the root, so an app that keeps other state
 * in `userData` — window bounds, a cache, its own preferences — can clear
 * every store without knowing how many there are or what they are called.
 */
const STORES_DIRECTORY = "marfa-local";

/** The database inside a store's directory. */
const STORE_FILE = "store.db";

/**
 * How much of the digest is kept.
 *
 * Sixteen hex characters is 64 bits. The set being separated is the
 * accounts one person signs into on one machine, which is a handful, so
 * this is far past the point where a collision is a thing to reason about
 * and still short enough to read.
 */
const DIGEST_LENGTH = 16;

/** As much of the origin as makes a legible folder name. */
const HINT_LENGTH = 32;

/** What separates the three fields, and what none of them may contain. */
const SEPARATOR = "\u0000";

/**
 * Refuse an identity that could collide with another.
 *
 * A field containing the separator makes the three ambiguous again:
 * `space="b\u0000c" account="d"` and `space="b" account="c\u0000d"` produce
 * one digest, one directory and one store for two accounts. Refused rather
 * than escaped, because an identity with a NUL in it is wrong wherever it
 * came from, and a path that took it would be the second store nobody can
 * account for.
 */
function assertSeparable(identity: StoreIdentity): void {
  for (const field of ["origin", "spaceId", "accountId"] as const) {
    if (identity[field].includes(SEPARATOR)) {
      throw new Error(
        `@withmarfa/sdk/electron: this store identity's ${field} contains a NUL, which is what separates the three ` +
          `fields when they are hashed into a path. Two identities carrying one could share a store.`,
      );
    }
  }
}

export interface LocalStoreLocation {
  /** `app.getPath("userData")`. */
  userData: string;
  /** Which server, space and account the store belongs to. */
  identity: StoreIdentity;
}

/**
 * A readable hint at which server a store belongs to.
 *
 * Decoration, not identity: the digest below is what separates two stores.
 * It exists because a person clearing one store opens this folder in a file
 * browser, and a directory of bare digests tells them nothing about which
 * one to remove.
 */
function hint(origin: string): string {
  const host = ((): string => {
    try {
      return new URL(origin).host;
    } catch {
      // Not a URL the platform would accept either, but the path still has
      // to be derivable — a store that cannot be located is a worse failure
      // than one with an unhelpful folder name.
      return origin;
    }
  })();
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, HINT_LENGTH);
  return slug === "" ? "store" : slug;
}

/**
 * What makes two stores different, as a fixed-length name.
 *
 * The separator is load-bearing and is the one part of this that fails
 * silently when it is dropped. Concatenating the three fields maps
 * `space=bc account=d` and `space=b account=cd` onto one directory, so two
 * accounts would open one store, and the engine's identity check — which
 * exists to catch exactly this — would never see a mismatch to refuse.
 *
 * A NUL separates them because nothing upstream produces one. That is a
 * property of the callers rather than of the type, and this is exported, so
 * {@link assertSeparable} makes it a rule rather than an assumption: a field
 * carrying the separator reproduces the collision the separator prevents.
 */
function digest(identity: StoreIdentity): string {
  return createHash("sha256")
    .update(
      [identity.origin, identity.spaceId, identity.accountId].join(SEPARATOR),
    )
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
}

/**
 * The directory holding one store's files.
 *
 * A directory rather than a bare path, because a store is more than its
 * database: SQLite writes `-wal` and `-shm` siblings, the engine's writer
 * lock is a `.lock` file beside it, and a store that has to be set aside
 * leaves both the old database and a recovery sidecar behind. Putting the
 * set in one place is what makes "remove this account's store" a single
 * safe operation rather than a pattern match over a shared folder.
 */
export function localStoreDirectory(options: LocalStoreLocation): string {
  const { userData, identity } = options;
  assertSeparable(identity);
  return join(
    userData,
    STORES_DIRECTORY,
    `${hint(identity.origin)}-${digest(identity)}`,
  );
}

/**
 * Where a store for this identity lives under an Electron app's `userData`.
 *
 * Keyed on all three fields of the identity, which is what lets a second
 * account on one machine have its own store. Keyed on fewer, two accounts
 * would meet at one path and the engine would refuse to open the second —
 * correctly, since a store holds one corpus and one cursor, but the refusal
 * reads to a person as the app being broken rather than as an app that
 * failed to give them somewhere to put the second account.
 */
export function localStorePath(options: LocalStoreLocation): string {
  return join(localStoreDirectory(options), STORE_FILE);
}
