import { log } from "../middleware/logger.js";

/**
 * Report shipped type identifiers the seed declined to overwrite.
 *
 * **A collision means a self-hoster registered a type this build has since
 * started shipping.** Both registrations live in the `space_id = ''` bucket —
 * `POST /types` stores there whenever a credential carries no space, which is
 * every deployment running `AUTH_MODE=keys` — so before the seed's guard, the
 * shipped schema simply overwrote theirs on the next boot.
 *
 * **Reported rather than resolved, and the boot path is exactly why.** This
 * runs unattended on every instance at every start. Neither outcome available
 * to it is safe to choose automatically: overwriting destroys a registration
 * the operator made, and refusing to boot takes an instance down for a
 * condition that harms nothing until somebody writes an item. So the row is
 * left as it stands, the type resolves as the operator's, and a person decides.
 *
 * The shape follows `reportReservedRootRows`, which exists for the adjacent
 * case of a root reserved after rows were written under it, and which also
 * reports and never acts.
 */
export function reportSeedCollisions(collided: readonly string[]): void {
  if (collided.length === 0) return;
  log("warn", "shipped types collide with registrations this instance owns", {
    count: collided.length,
    types: [...collided].sort(),
    effect:
      "the existing registration is kept and resolves; the shipped schema is not installed for these ids",
    action:
      "rename the local type, or remove it once its items are migrated, to take the shipped one",
  });
}
