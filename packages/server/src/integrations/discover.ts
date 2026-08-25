/**
 * Which integrations this deployment has, read from the directory rather
 * than from a list.
 *
 * The runtime loads integrations dynamically: it resolves a built entry
 * point under `MARFA_INTEGRATIONS_ROOT`, imports it, reads the manifest and
 * validates it. Which ones it has is the directory's answer rather than a
 * list's, which is what lets a deployment install one the image never
 * shipped: a list nothing outside this repository can edit could name no
 * such integration.
 *
 * This names candidates and nothing else. Every `<namespace>/<name>`
 * directory is one; the loaders that call this already refuse
 * anything without a built entry or with an invalid manifest, and they say
 * so when they do. Discovery deliberately does not repeat that judgment —
 * a directory that looks wrong is the loaders' business, and duplicating
 * the rule here is how the two would come to disagree.
 *
 * The two levels mirror the manifest identifier, so a directory states
 * which integration it holds rather than merely being habitually named
 * after it. It is also what lets two namespaces each hold a "podcasts"
 * without colliding, which a flat directory cannot express.
 *
 * Sorted, so a boot log and a catalog reconcile read the same way twice
 * running. Directory order is filesystem order, which is neither stable
 * nor meaningful.
 */
import { join } from "node:path";
import { readdirSync } from "node:fs";

/**
 * Immediate subdirectories of `dir`, dot- and underscore-prefixed names
 * skipped, unsorted.
 *
 * A missing directory is an empty list rather than a throw, at both levels
 * and for the same reason. At the root, the server runs in configurations
 * that carry no integrations at all — a SQLite deployment, a test harness
 * pointed at a scratch directory — and in those the honest answer is that
 * there are none, not that the deployment is broken. At a namespace, the
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
      // A leading dot or underscore marks a directory that is not an
      // integration, and the rule holds at both levels because either one
      // can carry such a directory. Dot-directories are tooling —
      // `.turbo`, an editor's scratch space, a partially-extracted
      // download. An underscore marks working material by the same
      // convention.
      //
      // The scaffold is kept out by this rule, and the prefix it carries
      // is the whole of the protection. That is worth stating because the
      // sentence here used to say otherwise: it said the declaration
      // governed the scaffold, and for a while that was false in a way
      // nothing caught. `installed-integrations.txt` decides what the image
      // stages, and an image is not the only place this loader runs. A
      // developer points `MARFA_INTEGRATIONS_ROOT` at a built checkout, and
      // a scaffold with no prefix registers there as one more integration
      // with the declaration nowhere in the path. So the two mechanisms
      // answer different questions and neither stands in for the other.
      //
      // That file refuses a declared name carrying either prefix for the
      // mirror of this rule: such a name would stage into the image and
      // never load.
      .filter((e) => !e.name.startsWith(".") && !e.name.startsWith("_"))
      .map((e) => e.name)
  );
}

/**
 * The `<namespace>/<name>` integration directories under `integrationsRoot`,
 * sorted.
 *
 * A namespace holding no integration directory contributes nothing, whether
 * it is empty, holds only loose files, or holds only scaffolding. That is
 * the same non-judgment the rest of this file makes: an empty namespace is
 * not evidence of a fault, and a namespace holding files rather than
 * directories names no candidate for a loader to reject.
 */
export function discoverIntegrationDirs(integrationsRoot: string): string[] {
  const names: string[] = [];
  for (const namespace of subdirectories(integrationsRoot)) {
    for (const leaf of subdirectories(join(integrationsRoot, namespace))) {
      // Joined with a literal slash rather than the platform separator:
      // this is the manifest's identifier, which reads the same on every
      // platform, and callers resolve it back into a path.
      names.push(`${namespace}/${leaf}`);
    }
  }
  return names.sort();
}
