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
 * So this replaces the array and nothing else. Every subdirectory is a
 * candidate; the loaders that call this already refuse anything without a
 * built entry or with an invalid manifest, and they say so when they do.
 * Discovery deliberately does not repeat that judgement — a directory that
 * looks wrong is the loaders' business, and duplicating the rule here is
 * how the two would come to disagree.
 *
 * Sorted, so a boot log and a catalog reconcile read the same way twice
 * running. Directory order is filesystem order, which is neither stable
 * nor meaningful.
 */
import { readdirSync } from "node:fs";

/**
 * Subdirectories of `integrationsRoot`, sorted.
 *
 * A missing root is an empty list rather than a throw. The server runs in
 * configurations that carry no integrations at all — a SQLite deployment,
 * a test harness pointed at a scratch directory — and in those the honest
 * answer is that there are none, not that the deployment is broken.
 * Anything else that goes wrong reading the directory is a real fault and
 * is left to propagate.
 */
export function discoverIntegrationDirs(integrationsRoot: string): string[] {
  let entries;
  try {
    entries = readdirSync(integrationsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return (
    entries
      .filter((e) => e.isDirectory())
      // A leading dot or underscore means scaffolding rather than an
      // integration. Dot-directories are tooling — `.turbo`, an editor's
      // scratch space, a partially-extracted download. The underscore is
      // the convention `_template` already announces itself with, and
      // honouring it is what stops the scaffold shipping.
      //
      // That is a live fix rather than tidiness. The old hand-maintained
      // table left `_template` out of the catalog while the runtime loader
      // prepended it by hand, so the scaffold was already registered as a
      // dispatchable integration on every deployment and carries its own
      // schedule queue on staging. Reading the directory without this rule
      // would have put it in the installable catalog too.
      //
      // Everything that genuinely wants the template names it explicitly —
      // the boot smoke test, the worker-entry smoke script, the image
      // verification — so none of them depends on discovery finding it.
      .filter((e) => !e.name.startsWith(".") && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort()
  );
}
