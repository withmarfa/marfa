/**
 * The manifests this build ships rather than discovers.
 *
 * **An integration is something a deployment installs; a client is
 * something the platform knows about.** That distinction is the whole
 * reason this file exists. Integrations arrive as directories under
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
  /** Manifest `name`, `<handle>/<name>`. */
  name: string;
  manifest: IntegrationManifest;
}

/** Every client manifest this build ships. */
export const CLIENT_MANIFESTS: readonly ClientManifest[] = [
  { name: SYNC_MANIFEST.name, manifest: SYNC_MANIFEST },
];
