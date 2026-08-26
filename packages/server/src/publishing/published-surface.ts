/**
 * The published surface lock: what every publishable package exported, in
 * what shape, and at which version, recorded so a surface cannot change
 * without the record changing with it.
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
 * Why the declaration file rather than the runtime module. A type-only
 * export is part of the contract a consumer compiles against, and importing
 * the built JavaScript would see only the values. One of the two original
 * removals was a type identifier, which a runtime check would have missed.
 *
 * Why a hash of the declarations rather than of the whole built file. A
 * comment, an import reordering or a changed implementation is not a change
 * to what the package offers, and demanding a version bump for one trains
 * people to bump without meaning it. The hash is over each exported name
 * paired with the declaration emitted for it, so it moves when the contract
 * moves and not otherwise.
 *
 * The names alone are not the contract, which cost this guard its whole
 * purpose once. A three-member union widened to four members changes the
 * type every consumer compiles against and moves no name at all, so the
 * guard was asked exactly the question it exists to answer and returned
 * green. The declaration is hashed beside the name for that reason, and a
 * widened union, a changed signature or a reshaped interface all move the
 * hash.
 *
 * **What it cannot see, stated so nobody assumes otherwise.**
 *
 * It does not know which versions are on the registry, deliberately —
 * reaching npm would make the ordinary suite network-dependent and fail
 * closed on an outage. So regenerating the lock at an unchanged version
 * silences it, and that is legitimate for a version nobody has published
 * and wrong for one somebody has. The guard holds the repository to "a
 * surface change moves the record"; whether the standing version is
 * already out there is a fact only a person has, and regenerating without
 * bumping is a decision rather than a shortcut. It is a decision that
 * shows up in the diff, which is the property being bought.
 *
 * It follows type references only into the package's own declaration
 * files. An exported interface whose field is typed by a private helper
 * declared beside it is covered, because that helper is part of what the
 * package emits. One typed by something a dependency declares is not
 * expanded, and what that costs depends on which dependency. A sibling
 * workspace package has its own entry here, so its shape is held
 * somewhere. A third-party one has nothing holding it: a package that
 * exports a schema typed by a validation library is exposing that
 * library's types to consumers, and a major version of it reshapes what
 * they compile against without moving anything this lock records.
 * Whatever a package genuinely re-exports is covered wherever it was
 * declared, because the declaration a consumer compiles against is that
 * one.
 *
 * It hashes declarations as the compiler prints them, with comments
 * removed and layout normalized, so neither a reworded doc comment nor a
 * change in how the emitter indents reaches the digest.
 *
 * Two things move every hash at once rather than none: the printer, so a
 * TypeScript upgrade that renders any declaration differently, and the
 * emitter that produced the `.d.ts` being printed, so a bundler upgrade
 * that renames or reorders what it emits. Both are loud and one command
 * clears them.
 *
 * A name is hashed against the subpath that exports it as well as its
 * declaration, so renaming an entry point or moving a name between two
 * of them moves the hash even though the file, the names and the shapes
 * are untouched. A binding's keyword is hashed too, because `const` and
 * `let` print identically otherwise and widening one breaks any consumer
 * relying on it being fixed.
 *
 * **What it still cannot see is a shape that is not this package's to
 * declare.** A re-exported third-party type is recorded as the reference
 * it is, so a major version of that dependency reshapes what consumers
 * compile against without moving anything here. That is a real gap and
 * not a small one; it is stated rather than closed because closing it
 * means hashing declarations this repository does not own and cannot
 * version. Deciding whether such a change needs a version bump is a
 * judgement this guard informs rather than makes.
 */
import { createHash } from "node:crypto";

/** One package's recorded surface. */
export interface SurfaceLockEntry {
  version: string;
  /** sha256 over each exported name paired with its declaration. */
  hash: string;
  /** How many names that hash covers. Recorded for the failure message. */
  exports: number;
}

/** The whole lock, keyed by package name. */
export type SurfaceLock = Record<string, SurfaceLockEntry>;

/** One exported name and the declaration a consumer compiles against. */
export interface SurfaceExport {
  name: string;
  /** How the compiler prints it, with comments removed. */
  declaration: string;
}

/** What a package currently offers, as read from its declaration files. */
export interface PackageSurface {
  name: string;
  version: string;
  /** De-duplicated across every entry point, in no guaranteed order. */
  exports: SurfaceExport[];
}

/**
 * Order by code unit, never by locale. `localeCompare` reads collation
 * tables that move between ICU versions, so a Node upgrade would reorder
 * every surface and move every hash at once, reporting a changed contract
 * for every package on a day none of them changed.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Hash a surface.
 *
 * Sorted, so the digest depends on the set of exports and not on the order
 * a compiler happened to report them.
 *
 * Hashed as JSON rather than as joined text because a declaration spans
 * lines and can contain any separator one might pick: JSON escaping is what
 * stops one export's text from forging the boundary between two, which
 * would let a real change be passed off as no change at all.
 */
export function hashSurface(exports: readonly SurfaceExport[]): string {
  const canonical = exports
    .map((e): [string, string] => [e.name, e.declaration])
    .sort((a, b) => byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Build a lock from the surfaces read off the tree. */
export function buildSurfaceLock(
  surfaces: readonly PackageSurface[],
): SurfaceLock {
  const out: SurfaceLock = {};
  for (const s of [...surfaces].sort((a, b) => byCodeUnit(a.name, b.name))) {
    out[s.name] = {
      version: s.version,
      hash: hashSurface(s.exports),
      exports: s.exports.length,
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
      lockedVersion: string;
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
 * **The version is compared beside the hash, never before it.** Reading the
 * version first and skipping the hash comparison on a mismatch is how this
 * check spent its life inert: it made moving a version the way to switch
 * the check off, so the one change most likely to move a surface was the
 * one that stopped the surface being looked at.
 *
 * **What "the surface moved" means, now that a version cannot short-circuit
 * it.** The lock is a snapshot of the tree, and the only question asked is
 * whether the snapshot still describes it. So the normal, correct flow is
 * quiet: move a version, regenerate, commit both, and the lock describes
 * the tree again. A moved surface with a stale lock is refused whether or
 * not the version moved with it, because a version bump is not evidence
 * that anyone looked at the surface — regenerating is the act that records
 * having looked, and it is the half a reviewer can see.
 *
 * A version that moved on its own is refused for a narrower reason: the
 * recorded hash is a claim about what one version exported, and once the
 * tree builds a different version that claim describes nothing anyone can
 * check. A lock that has stopped describing the tree cannot be trusted to
 * describe it next time either, and the wrong-versioned hash it carries
 * would make the next real comparison meaningless rather than merely
 * stale.
 *
 * Every kind blocks, and the remedy for all four is the same one command.
 * That is deliberate: there is no violation here a reader can decide to
 * ignore, because a violation that could be ignored is what this guard
 * already tried.
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
    if (entry.hash !== hashSurface(s.exports)) {
      violations.push({
        kind: "surface-moved",
        name: s.name,
        lockedVersion: entry.version,
        version: s.version,
        lockedExports: entry.exports,
        currentExports: s.exports.length,
      });
    }
    if (entry.version !== s.version) {
      violations.push({
        kind: "version-moved",
        name: s.name,
        from: entry.version,
        to: s.version,
      });
    }
  }

  for (const name of Object.keys(lock)) {
    if (!seen.has(name)) violations.push({ kind: "removed", name });
  }

  return violations;
}

/**
 * The violations a merge must not carry.
 *
 * All of them. This stays a named seam because it is where an exclusion
 * would be written, and an exclusion written here is exactly how this
 * guard came to record violations that could never fail a build. Anything
 * added to this filter needs an argument for why a build should ship with
 * the tree and the lock disagreeing.
 */
export function blockingViolations(
  violations: readonly SurfaceViolation[],
): SurfaceViolation[] {
  return [...violations];
}

/** A sentence a reader can act on. */
export function describeSurfaceViolation(v: SurfaceViolation): string {
  const REGENERATE =
    "Run `pnpm --filter @withmarfa/server run surface-lock:generate`.";
  switch (v.kind) {
    case "unlocked":
      return `${v.name}@${v.version} is publishable and absent from the lock. ${REGENERATE}`;
    case "removed":
      return `${v.name} is in the lock and is no longer a publishable package. Run the generator to drop it.`;
    case "surface-moved":
      return (
        `${v.name}: the surface recorded for ${v.lockedVersion} is not the surface the tree builds at ${v.version}. ` +
        (v.lockedExports === v.currentExports
          ? `Still ${String(v.currentExports)} exported names, so a declaration changed shape or a name was swapped for another — neither moves the count. `
          : `${String(v.currentExports)} exported names now, ${String(v.lockedExports)} in the lock. `) +
        `A published version must name one surface: move the version if this one is already on the registry, then regenerate. ` +
        `Removing an export is a major. ${REGENERATE}`
      );
    case "version-moved":
      return (
        `${v.name} moved ${v.from} to ${v.to} and the lock still records ${v.from}, ` +
        `so the surface it holds is a claim about a version nothing is building. ${REGENERATE}`
      );
  }
}
