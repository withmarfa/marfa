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
  /**
   * Narrowed to a client-run manifest at the type, so a member that forgot
   * the field is a build error rather than a boot-time throw. The throw
   * below stays for the case the type cannot reach — a manifest widened to
   * `IntegrationManifest` somewhere upstream and handed in — but nothing
   * that compiles here should ever reach it.
   */
  manifest: IntegrationManifest & { runs_on: "client" };
}

/** Every client manifest this build ships. */
export const CLIENT_MANIFESTS: readonly ClientManifest[] = [
  { name: SYNC_MANIFEST.name, manifest: SYNC_MANIFEST },
];

/**
 * This list is a shipping mechanism, not a definition. What makes a manifest
 * a client is its own `runs_on` declaration, which the run route and the
 * catalog reconcile both read; membership here only says the server carries
 * the manifest as a workspace dependency instead of finding it on a disk.
 *
 * **The two are held together by the type rather than by a check.**
 * `ClientManifest.manifest` is narrowed to `runs_on: "client"`, so a member
 * that forgot the field does not compile. A runtime guard here would be
 * unreachable, and unreachable enforcement is worse than none: it reads as
 * protection to everyone after you and defends nothing. `client-manifests.test.ts`
 * asserts the same invariant, which is what reddens if the narrowing is ever
 * widened.
 */
