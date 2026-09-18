/**
 * The one-time secret that binds a fresh instance's first mint to whoever can
 * read its log.
 *
 * **Bootstrap is the one unauthenticated write in the product.** A server that
 * has never held a credential accepts a single `POST /keys` and mints the
 * operator key from it. Until now that door was open to anyone who could
 * reach the port during the window between the process starting and the
 * operator's first call — and on a self-host that window is however long it
 * takes somebody to read the quickstart.
 *
 * So the first mint has to present a secret the server generated and printed.
 * Reading the boot log is proof of being the person running the instance,
 * which is exactly the claim bootstrap needs and the only one available before
 * any credential exists.
 *
 * **No environment variable and no fallback**, which are the two shapes this
 * deliberately is not. A variable has to be chosen before the first boot, ends
 * up in a compose file, and is then the same on every instance somebody copied
 * that file from. A fallback — "or no secret if none is set" — is the door
 * standing open again for anyone who does not set it, which is everyone who
 * has not read the paragraph explaining why they should.
 *
 * **Loopback-only was the other candidate and it is wrong here.** Under Docker
 * the request arrives from the compose network or from a reverse proxy, so a
 * loopback test refuses the legitimate caller and admits nothing useful.
 *
 * **Stored in plaintext, and re-printed at every boot until it is used.** It
 * is deleted the moment the operator key exists, so the window in which it is
 * readable is the window in which it is useful. The
 * threat this closes is a network caller during the bootstrap window, not
 * somebody holding the database — anyone with the database can write an
 * `api_keys` row directly and needs no secret at all. Keeping it readable is
 * what lets a restart print the same secret rather than invalidating the one
 * the operator has already copied, and an operator who missed the line can
 * scroll back rather than resetting the instance.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Storage } from "../storage/interface.js";

/** Settings key holding the pending secret. Absent once consumed. */
export const BOOTSTRAP_SECRET_KEY = "bootstrap.secret";

/** Whether this instance has yet minted its first credential. */
export async function isBootstrapped(storage: Storage): Promise<boolean> {
  return (await storage.settings.get("bootstrapped")) === "true";
}

/**
 * The secret this instance's first mint must present, generating one if it has
 * none.
 *
 * Idempotent by design: a restart before the first mint returns the same
 * secret rather than a new one, so a printed value stays good for as long as
 * the window is open.
 */
export async function ensureBootstrapSecret(storage: Storage): Promise<string> {
  const existing = await storage.settings.get(BOOTSTRAP_SECRET_KEY);
  if (existing) return existing;
  // **Claimed rather than set, because two replicas boot at once.** A
  // read-then-upsert lets both see no secret, both generate one, and both
  // print their own — after which one of the two printed values is dead and
  // the operator has no way to tell which. `claim` is the same atomic
  // insert-or-bail the bootstrap sentinel uses; the loser re-reads and prints
  // the winner's. Multi-process against one database is a supported topology,
  // so this is not a hypothetical.
  const secret = randomBytes(32).toString("hex");
  if (await storage.settings.claim(BOOTSTRAP_SECRET_KEY, secret)) return secret;
  const winner = await storage.settings.get(BOOTSTRAP_SECRET_KEY);
  if (winner) return winner;
  // A row existed at claim time and is gone now, so something consumed it in
  // between — the instance is bootstrapped and no secret will be presented
  // again. Claiming once more rather than returning the unpersisted one keeps
  // the promise this function makes: what it hands back is what is stored, so
  // a caller printing it is never printing a value that cannot work.
  await storage.settings.claim(BOOTSTRAP_SECRET_KEY, secret);
  return (await storage.settings.get(BOOTSTRAP_SECRET_KEY)) ?? secret;
}

/**
 * Whether the presented secret is this instance's, compared in constant time.
 *
 * **An instance with no stored secret admits nothing, and that is checked
 * first.** Without it an empty stored value matches an empty presented one —
 * `timingSafeEqual` answers true for two zero-length buffers — and a request
 * with no `Authorization` header presents exactly the empty string. That
 * makes the state "secret gone, sentinel gone" an open door, which is
 * precisely the state a hand-repair of a stuck bootstrap produces.
 *
 * **Byte length is compared, not string length**, because `timingSafeEqual`
 * throws on a byte-length mismatch and `String.length` counts UTF-16 units. A
 * header carrying one multi-byte character passed the old guard and threw
 * inside the comparison, which reaches the caller as a 500 with a stack rather
 * than a 401. Comparing lengths leaks only the length, which is a constant of
 * this build.
 */
export function bootstrapSecretMatches(
  stored: string | null,
  presented: string,
): boolean {
  if (!stored) return false;
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Consume the secret, once the operator key exists.
 *
 * Deleted rather than blanked. A blanked row leaves a value that reads as
 * absent in some places and as an empty string in others, and it also leaves
 * a credential-shaped key in a table nothing else prunes. Deleting makes
 * `get` answer `null`, which is the one state every reader agrees about.
 */
export async function consumeBootstrapSecret(storage: Storage): Promise<void> {
  await storage.settings.release(BOOTSTRAP_SECRET_KEY);
}
