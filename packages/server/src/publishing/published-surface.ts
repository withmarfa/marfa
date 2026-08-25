/**
 * The published surface lock: what every publishable package exported, and
 * at which version, recorded so a surface cannot change without the version
 * moving with it.
 *
 * The defect this exists for. `@withmarfa/shared` was published at 4.0.0,
 * then seven commits landed on it with the version untouched, one of them
 * removing an exported constant and another dropping a type identifier. So
 * `4.0.0` names at least two different export surfaces depending on when it
 * was published, and four repositories pinning it exactly are relying on a
 * lockfile's integrity hash rather than on the version to get a particular
 * one. A pin that names two things is not a pin.
 *
 * It happened again the same week: a discovery change removed four exports
 * from the same package's root and left the version alone. Nothing broke,
 * because nothing consumed them and publishing is tag-triggered so merging
 * published nothing — the removal simply waits at the head of the branch
 * for whoever next cuts a tag.
 *
 * Why a hash of the export names rather than of the built file. A comment,
 * an import reordering or a changed implementation is not a change to what
 * the package offers, and demanding a version bump for one trains people to
 * bump without meaning it. The hash is over the sorted list of exported
 * names, so it moves when the surface moves and not otherwise.
 *
 * Why the declaration file rather than the runtime module. A type-only
 * export is part of the contract a consumer compiles against, and importing
 * the built JavaScript would see only the values. One of the two original
 * removals was a type identifier, which a runtime check would have missed.
 *
 * The opposite shape is refused too: a version that moves with no surface
 * change is allowed, because a patch release for a fixed implementation is
 * a legitimate thing. Only the surface-moved-and-version-did-not case is an
 * error, which is the asymmetry the manifest lock does not have and this one
 * needs.
 *
 * **What it cannot see, stated so nobody assumes otherwise.** This compares
 * the tree against the committed lock. It does not know which versions are
 * on the registry, deliberately — reaching npm would make the ordinary
 * suite network-dependent and fail closed on an outage. So regenerating the
 * lock at an unchanged version silences it, and that is legitimate for a
 * version nobody has published and wrong for one somebody has. The guard
 * holds the repository to "a surface change moves a version"; whether the
 * standing version is already out there is a fact only a person has, and
 * regenerating without bumping is a decision rather than a shortcut.
 */
import { createHash } from "node:crypto";

/** One package's recorded surface. */
export interface SurfaceLockEntry {
  version: string;
  /** sha256 over the sorted export names, newline-joined. */
  hash: string;
  /** How many names that hash covers. Recorded for the failure message. */
  exports: number;
}

/** The whole lock, keyed by package name. */
export type SurfaceLock = Record<string, SurfaceLockEntry>;

/** What a package currently offers, as read from its declaration files. */
export interface PackageSurface {
  name: string;
  version: string;
  /** Sorted, de-duplicated export names across every entry point. */
  exportNames: string[];
}

/**
 * Hash a surface. Sorted and newline-joined so the digest depends on the
 * set of names and not on the order a compiler happened to report them.
 */
export function hashExportNames(names: readonly string[]): string {
  return createHash("sha256")
    .update([...names].sort().join("\n"))
    .digest("hex");
}

/** Build a lock from the surfaces read off the tree. */
export function buildSurfaceLock(
  surfaces: readonly PackageSurface[],
): SurfaceLock {
  const out: SurfaceLock = {};
  for (const s of [...surfaces].sort((a, b) => a.name.localeCompare(b.name))) {
    out[s.name] = {
      version: s.version,
      hash: hashExportNames(s.exportNames),
      exports: s.exportNames.length,
    };
  }
  return out;
}

/** A single way the tree and the lock disagree. */
export type SurfaceViolation =
  | { kind: "unlocked"; name: string; version: string }
  | { kind: "removed"; name: string }
  | {
      kind: "surface-moved";
      name: string;
      version: string;
      lockedExports: number;
      currentExports: number;
    }
  | {
      kind: "version-moved";
      name: string;
      from: string;
      to: string;
    };

/**
 * Compare the tree against the lock.
 *
 * `version-moved` is reported and is not an error on its own — the caller
 * decides. A version moving with the surface is the correct case and the
 * whole point; a version moving without it is a legitimate patch release.
 * The error is a surface that moved under a version that did not.
 */
export function compareToSurfaceLock(
  surfaces: readonly PackageSurface[],
  lock: SurfaceLock,
): SurfaceViolation[] {
  const violations: SurfaceViolation[] = [];
  const seen = new Set<string>();

  for (const s of surfaces) {
    seen.add(s.name);
    const entry = lock[s.name];
    if (!entry) {
      violations.push({ kind: "unlocked", name: s.name, version: s.version });
      continue;
    }
    const hash = hashExportNames(s.exportNames);
    if (entry.version !== s.version) {
      violations.push({
        kind: "version-moved",
        name: s.name,
        from: entry.version,
        to: s.version,
      });
      continue;
    }
    if (entry.hash !== hash) {
      violations.push({
        kind: "surface-moved",
        name: s.name,
        version: s.version,
        lockedExports: entry.exports,
        currentExports: s.exportNames.length,
      });
    }
  }

  for (const name of Object.keys(lock)) {
    if (!seen.has(name)) violations.push({ kind: "removed", name });
  }

  return violations;
}

/** The violations a merge must not carry. */
export function blockingViolations(
  violations: readonly SurfaceViolation[],
): SurfaceViolation[] {
  return violations.filter((v) => v.kind !== "version-moved");
}

/** A sentence a reader can act on. */
export function describeSurfaceViolation(v: SurfaceViolation): string {
  switch (v.kind) {
    case "unlocked":
      return `${v.name}@${v.version} is publishable and absent from the lock. Run \`pnpm --filter @withmarfa/server run surface-lock:generate\`.`;
    case "removed":
      return `${v.name} is in the lock and is no longer a publishable package. Run the generator to drop it.`;
    case "surface-moved":
      return (
        `${v.name} exports ${String(v.currentExports)} names, the lock records ${String(v.lockedExports)} at the same version ${v.version}. ` +
        `A published version must name one surface: move the version, then regenerate. ` +
        `Removing an export is a major.`
      );
    case "version-moved":
      return `${v.name} moved ${v.from} to ${v.to}; regenerate the lock.`;
  }
}
