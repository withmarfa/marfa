/**
 * Which integrations this deployment has, read from the directory rather
 * than from a list.
 *
 * The runtime has always loaded integrations dynamically: it resolves a
 * built entry point under `MARFA_INTEGRATIONS_ROOT`, imports it, reads the
 * manifest and validates it. The one static part was a hand-maintained
 * array of directory names in the shared package, and it is the reason
 * nothing could be installed into a deployment that did not ship inside
 * the image — not because the loader could not load it, but because
 * nothing would name it.
 *
 * So this replaces the array and nothing else. Every `<handle>/<name>`
 * directory is a candidate; the loaders that call this already refuse
 * anything without a built entry or with an invalid manifest, and they say
 * so when they do. Discovery deliberately does not repeat that judgment —
 * a directory that looks wrong is the loaders' business, and duplicating
 * the rule here is how the two would come to disagree.
 *
 * The two levels mirror the manifest identifier, so a directory states
 * which integration it holds rather than merely being habitually named
 * after it. It is also what lets two publishers each ship a "podcasts"
 * without colliding, which a flat directory cannot express.
 *
 * Sorted, so a boot log and a catalog reconcile read the same way twice
 * running. Directory order is filesystem order, which is neither stable
 * nor meaningful.
 */
import { join } from "node:path";
import { readdirSync } from "node:fs";

/**
 * Immediate subdirectories of `dir`, scaffolding skipped, unsorted.
 *
 * A missing directory is an empty list rather than a throw, at both levels
 * and for the same reason. At the root, the server runs in configurations
 * that carry no integrations at all — a SQLite deployment, a test harness
 * pointed at a scratch directory — and in those the honest answer is that
 * there are none, not that the deployment is broken. At a handle, the
 * directory was there a moment earlier when the root was read, so its
 * absence now is a concurrent removal rather than a fault, and the answer
 * is the same. Anything else that goes wrong reading a directory is a real
 * fault and is left to propagate.
 */
function subdirectories(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return (
    entries
      .filter((e) => e.isDirectory())
      // A leading dot or underscore means scaffolding rather than an
      // integration, and the rule holds at both levels because either one
      // can carry it. Dot-directories are tooling — `.turbo`, an editor's
      // scratch space, a partially-extracted download. The underscore is
      // the convention `_template` already announces itself with, and
      // honoring it is what stops the scaffold shipping.
      //
      // That is a live fix rather than tidiness. The old hand-maintained
      // table left `_template` out of the catalog while the runtime loader
      // prepended it by hand, so the scaffold was already registered as a
      // dispatchable integration on every deployment and carries its own
      // schedule queue on staging. Reading the directory without this rule
      // would have put it in the installable catalog too.
      //
      // The scaffold sits at the handle level, flat and underscored, which
      // is what keeps it invisible here. Everything that genuinely wants it
      // names it explicitly — the boot smoke test, the worker-entry smoke
      // script, the image verification — so none of them depends on
      // discovery finding it.
      .filter((e) => !e.name.startsWith(".") && !e.name.startsWith("_"))
      .map((e) => e.name)
  );
}

/**
 * The `<handle>/<name>` integration directories under `integrationsRoot`,
 * sorted.
 *
 * A handle holding no integration directory contributes nothing, whether
 * it is empty, holds only loose files, or holds only scaffolding. That is
 * the same non-judgment the rest of this file makes: an empty handle is
 * not evidence of a fault, and a handle holding files rather than
 * directories names no candidate for a loader to reject.
 */
export function discoverIntegrationDirs(integrationsRoot: string): string[] {
  const names: string[] = [];
  for (const handle of subdirectories(integrationsRoot)) {
    for (const leaf of subdirectories(join(integrationsRoot, handle))) {
      // Joined with a literal slash rather than the platform separator:
      // this is the manifest's identifier, which reads the same on every
      // platform, and callers resolve it back into a path.
      names.push(`${handle}/${leaf}`);
    }
  }
  return names.sort();
}
