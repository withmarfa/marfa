/**
 * Bringing the integration catalog up to what the build ships.
 *
 * The catalog was a snapshot of whenever each integration was first
 * registered. Nothing re-registered on deploy, so a manifest change reached
 * the code and never the catalog: on 21 August 2026 eight of fifteen
 * integrations were behind on both environments, and thirteen frozen blobs
 * still declared a runtime substrate deleted a month earlier. The only
 * thing that had ever moved a row was somebody running a script by hand.
 *
 * This closes that at the same seam the platform type set already uses.
 * `seedPlatformTypes` runs at every boot for exactly this reason: a
 * redeploy carrying a changed shipped schema has to move the row, or the
 * instance keeps resolving whatever it was first seeded with. The catalog
 * needs the same guarantee, with one deliberate difference.
 *
 * **It registers, it never re-binds.** A missing `(name, version)` pair
 * gets a row; an existing row is left exactly as it is. That asymmetry is
 * the safety property, not an omission. A connection resolves the manifest
 * frozen on its catalog row, so rewriting a row in place would change an
 * installed connection's declared surface with nobody told, and moving a
 * connection to a newer row is a deliberate act with a consent gate on it
 * (`connections/upgrade-pipeline.ts`). Registering a sibling row that no
 * connection points at yet cannot affect anything already installed.
 *
 * **It reports what it did.** A reconcile that quietly registered nothing
 * is indistinguishable from one that never ran, which is the failure mode
 * the whole ticket is about.
 */
import type { Storage } from "../storage/interface.js";
import { registerIntegrationManifest } from "./register-manifest.js";
import type { InTreeManifest } from "./load-manifests.js";

/** One reconcile at a time across a multi-instance deployment. Web and
 *  worker containers boot together and would otherwise both register the
 *  same absent row, racing to create duplicate siblings under one
 *  `(name, version)` pair. */
const RECONCILE_LOCK = "integration-catalog-reconcile";

export interface CatalogReconcileResult {
  /** Rows created by this run. */
  registered: { name: string; version: string }[];
  /** Manifests whose exact version was already registered. */
  alreadyPresent: { name: string; version: string }[];
  /** Manifests this run could not register, with the reason. */
  failed: { name: string; version: string; reason: string }[];
  /** True when another instance held the lock and this run did nothing. */
  skippedLocked: boolean;
}

const EMPTY: CatalogReconcileResult = {
  registered: [],
  alreadyPresent: [],
  failed: [],
  skippedLocked: true,
};

async function reconcileUnlocked(
  storage: Storage,
  manifests: readonly InTreeManifest[],
): Promise<CatalogReconcileResult> {
  const result: CatalogReconcileResult = {
    registered: [],
    alreadyPresent: [],
    failed: [],
    skippedLocked: false,
  };

  for (const entry of manifests) {
    const tag = { name: entry.manifest.name, version: entry.manifest.version };
    try {
      // Catalog rows are platform-scoped (`space_id IS NULL`), which is
      // what makes one registered manifest visible to every space. The
      // reconcile has no caller and therefore no space, so it writes the
      // same rows registration always has.
      const outcome = await registerIntegrationManifest(
        storage,
        entry.manifest,
        undefined,
      );
      if (outcome.status === "registered") result.registered.push(tag);
      else result.alreadyPresent.push(tag);
    } catch (err) {
      // One manifest that cannot register must not stop the rest. The
      // usual cause is a target type that resolves nowhere, which is a
      // defect in that manifest rather than in the catalog.
      result.failed.push({
        ...tag,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Register every shipped manifest version that the catalog does not
 * already carry. Safe to run on every boot and safe to run concurrently.
 */
export async function reconcileIntegrationCatalog(
  storage: Storage,
  manifests: readonly InTreeManifest[],
): Promise<CatalogReconcileResult> {
  const held = await storage.coordination.withJobLock(RECONCILE_LOCK, () =>
    reconcileUnlocked(storage, manifests),
  );
  // `withJobLock` resolves to undefined when another instance holds the
  // lock. That is a skip rather than a failure: the holder is doing the
  // same work.
  return held ?? EMPTY;
}

/** One line an operator can read in the boot log. Deliberately says
 *  something even when nothing changed, because "the catalog reconciled and
 *  had nothing to do" and "the reconcile never ran" must not look alike. */
export function describeReconcile(result: CatalogReconcileResult): string {
  if (result.skippedLocked) {
    return "Integration catalog reconcile skipped: another instance holds the lock.";
  }
  const parts = [
    `${String(result.registered.length)} registered`,
    `${String(result.alreadyPresent.length)} already current`,
  ];
  if (result.failed.length > 0) {
    parts.push(`${String(result.failed.length)} failed`);
  }
  return `Integration catalog reconciled: ${parts.join(", ")}.`;
}
