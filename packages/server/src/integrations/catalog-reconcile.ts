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
import type { IntegrationManifest } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { registerIntegrationManifest } from "./register-manifest.js";
import { loadInTreeManifests } from "./load-manifests.js";
import { CLIENT_MANIFESTS } from "./client-manifests.js";

/** Anything the catalog can be asked to carry. Deliberately no more than
 *  the manifest: a discovered integration knows which directory it came
 *  from and a client has no directory at all, and the reconcile has
 *  no business caring either way. */
export interface CatalogManifest {
  manifest: IntegrationManifest;
}

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
  manifests: readonly CatalogManifest[],
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
  manifests: readonly CatalogManifest[],
): Promise<CatalogReconcileResult> {
  const held = await storage.coordination.withJobLock(RECONCILE_LOCK, () =>
    reconcileUnlocked(storage, manifests),
  );
  // `withJobLock` resolves to undefined when another instance holds the
  // lock. That is a skip rather than a failure: the holder is doing the
  // same work.
  return held ?? EMPTY;
}

export interface ShippedCatalogOutcome {
  result: CatalogReconcileResult;
  /** Directories that yielded no usable manifest, with the reason. */
  skipped: { dirName: string; reason: string }[];
  /** True when no integrations directory could be resolved. What the build
   *  ships still reconciled; the discovered half is empty for a reason an
   *  operator should be told about rather than left to infer. */
  rootUnresolved: boolean;
}

/**
 * Reconcile the catalog against everything this build ships: the
 * integrations discovered in the runtime's directory, plus the client
 * manifests the server carries as workspace dependencies.
 *
 * **The union is the point.** A deployment installs integrations into a
 * directory, so discovery is the only honest way to learn what it has. A
 * client is not installed anywhere, because its code runs on the user's
 * machine, so the only place its manifest can come from is the build.
 * Reading one source and not the other drops half the catalog.
 *
 * An unresolvable integrations root is a partial answer rather than no
 * answer, and it is reported as one. The build's own manifests need no
 * directory, so they reconcile regardless: a deployment that cannot find
 * its integrations still knows about its own clients.
 *
 * **A name arriving from both sources is refused rather than resolved.**
 * Registration keys on `(name, version)`, so a directory that shipped a
 * manifest a client already owns would not produce a duplicate row: it
 * would register whichever the array happened to order first and drop the
 * other into `alreadyPresent`, and the deployment would run against a
 * declared surface nobody chose. That is unreachable today, but the union
 * is permanent structure and a silent winner is the wrong default for it.
 */
export async function reconcileShippedCatalog(
  storage: Storage,
  options: { integrationsRoot: string | null },
): Promise<ShippedCatalogOutcome> {
  const discovered = options.integrationsRoot
    ? await loadInTreeManifests({ integrationsRoot: options.integrationsRoot })
    : { manifests: [], skipped: [] };

  const clientNames = new Set(CLIENT_MANIFESTS.map((c) => c.manifest.name));
  const collided = discovered.manifests.filter((entry) =>
    clientNames.has(entry.manifest.name),
  );
  // Both sides are withheld, not just the loser. Picking one is the thing
  // being refused, and a deployment told which manifest it is missing and
  // why can fix it; a deployment silently running the other cannot.
  const collidedNames = new Set(collided.map((entry) => entry.manifest.name));
  const registrable = [...discovered.manifests, ...CLIENT_MANIFESTS].filter(
    (entry) => !collidedNames.has(entry.manifest.name),
  );

  const result = await reconcileIntegrationCatalog(storage, registrable);

  const collisions = [...collidedNames].map((name) => ({
    name,
    version: "",
    reason:
      `${name} reached the catalog from the installed integrations ` +
      `directory and from the manifests this build ships. A client is not ` +
      `something a deployment installs, so one of the two is wrong; ` +
      `neither was registered, because registration keys on (name, ` +
      `version) and picking one would decide it silently.`,
  }));

  return {
    // A new object rather than a push: a locked-out reconcile returns a
    // shared constant, and appending to its array would leak into every
    // later call in the process.
    result: { ...result, failed: [...result.failed, ...collisions] },
    skipped: discovered.skipped,
    rootUnresolved: options.integrationsRoot === null,
  };
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
