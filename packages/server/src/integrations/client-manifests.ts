/**
 * The manifests this build ships rather than discovers.
 *
 * **Where the code runs is a field on the manifest; this file is only
 * about where the manifest comes from.** An integration is anything that
 * ships a manifest and installs as a connection, whatever its upstream, so
 * the client is not a different kind of thing — it is one that declares
 * `runs_on: "client"`. What that costs a deployment is discoverability:
 * integrations arrive as directories under
 * `MARFA_INTEGRATIONS_ROOT`, and the loader finds them by reading that
 * directory. A client's code has to run somewhere else: sync watches a
 * filesystem, so it can only run on the machine holding the files. There
 * is nothing to install into a directory that dispatches nowhere.
 *
 * The catalog still has to carry it, because the catalog describes what is
 * installable and a connection resolves the manifest frozen on its catalog
 * row. So the manifest arrives as a workspace dependency of the server and
 * is handed to the boot-time reconcile alongside whatever the directory
 * yielded. It ships with the build rather than being installed into a
 * deployment, which is the whole of the distinction: a deployment can add
 * an integration without rebuilding, and cannot add a client at all.
 *
 * Two answers this deliberately avoids, because both put the client back
 * among the integrations: a special case in the loader for one directory,
 * and the image staging a client's manifest into the integrations root as
 * an exception.
 */
import type { IntegrationManifest } from "@withmarfa/shared";
import { SYNC_MANIFEST } from "@withmarfa/sync-manifest";

export interface ClientManifest {
  /** Manifest `name`, `<namespace>/<name>`. */
  name: string;
  manifest: IntegrationManifest;
}

/** Every client manifest this build ships. */
export const CLIENT_MANIFESTS: readonly ClientManifest[] = [
  { name: SYNC_MANIFEST.name, manifest: SYNC_MANIFEST },
];

/**
 * This list is a shipping mechanism, not a definition. What makes a
 * manifest a client is its own `runs_on` declaration, which the run route
 * and the catalog reconcile both read; membership here only says the
 * server carries the manifest as a workspace dependency instead of finding
 * it on a disk. The two must agree, so the module refuses to load if they
 * do not — a client manifest that forgot the field would be dispatched
 * like any other integration, which is the failure this file exists to
 * prevent and could not previously detect.
 */
for (const entry of CLIENT_MANIFESTS) {
  if (entry.manifest.runs_on !== "client") {
    throw new Error(
      `CLIENT_MANIFESTS carries ${entry.name}, whose manifest declares ` +
        `runs_on "${entry.manifest.runs_on}". A manifest this build ships ` +
        `rather than discovers runs on the user's machine and has to say so.`,
    );
  }
}
