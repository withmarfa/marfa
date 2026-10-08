/**
 * The identifier one deployment answers to, minted the first time anything
 * asks for it and never again.
 *
 * **Its own settings key, not a field inside the instance configuration.**
 * `PUT /config` is a wholesale replacement: a body that omits a key erases
 * it, which is the door's stated contract. An identity stored there would be
 * erasable by an ordinary configuration write, and an instance that can lose
 * its name to a `PUT` has no identity at all.
 *
 * **Not a prefix, not a permission, not a column.** Nothing is namespaced by
 * it and nothing is authorized by it. It names the deployment so that an
 * operator holding two databases, two archives or two log streams can tell
 * which is which, and that is its whole job.
 */
import { generateId } from "@withmarfa/shared";
import type { SettingsStore } from "./interface.js";

/** The settings key the instance identifier is held under. */
export const INSTANCE_ID_KEY = "instance.id";

/**
 * This instance's identifier, minting one if it has none.
 *
 * Idempotent, and that is the whole contract: every caller gets the value
 * that is stored, and what is stored never changes once written.
 *
 * **Claimed rather than set**: two replicas booting against one database both see no row, both generate one,
 * and a read-then-write lets the second overwrite the first — after which
 * the instance has answered two different names for itself and whichever an
 * archive recorded is wrong. `claim` is an atomic insert-or-bail, so the
 * loser's own insert does nothing and the read below returns the winner's.
 * Its answer is therefore not consulted: which of the two callers minted the
 * stored value is not a fact anything here needs.
 */
export async function ensureInstanceId(
  settings: SettingsStore,
): Promise<string> {
  const existing = await settings.get(INSTANCE_ID_KEY);
  if (existing !== null) return existing;
  await settings.claim(INSTANCE_ID_KEY, generateId());
  const stored = await settings.get(INSTANCE_ID_KEY);
  if (stored === null) {
    // Unreachable through any door: no route and no job removes this key,
    // so it is a throw
    // rather than a return of the unpersisted value because an instance that
    // answers a name its database does not hold is the one outcome worth
    // refusing — an archive would record it and nothing could resolve it
    // afterwards.
    throw new Error(`settings key ${INSTANCE_ID_KEY} vanished after a claim`);
  }
  return stored;
}
