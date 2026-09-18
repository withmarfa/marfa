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
 * silences the tree-against-lock comparison, and that is legitimate for a
 * version nobody has published and wrong for one somebody has.
 *
 * **That reasoning used to end with "it is a decision that shows up in the
 * diff, which is the property being bought", and the diff turned out to be
 * a property nothing was buying.** It shows up there and nothing read it.
 * The case that made it real is not a careless regeneration: a change
 * confined to `packages/shared` moves `@withmarfa/sdk`'s surface, because
 * that package re-exports shared types — widening one moves what a consumer
 * compiles against while no `sdk` source is touched and its own export count
 * does not change. Nothing in such a change looks like an `sdk` change, so
 * the reviewer has no reason to look at its line in the lock, and the
 * artifact that would have shown the problem is the same artifact the
 * regeneration overwrote. A regenerated lock is not evidence; it is what
 * erases the evidence.
 *
 * The package matters here rather than being an example: `@withmarfa/sdk`
 * re-exports from `shared`. Surface text stops at the package boundary, so a
 * referenced-but-not-re-exported type never reaches the hash. Naming the
 * wrong one would describe a mechanism this repository does not have.
 *
 * So the comparison against the tree is joined by `compareSurfaceLocks`
 * below, which compares the committed lock against the lock on the base
 * this change is merging into. That is a different question and it is the
 * one the docstring above was asserting without checking: **a version that
 * named one surface on the base must not name a different one after the
 * merge.** It still reaches no registry. It is anchored to the branch that
 * publishes rather than to what has been published, which is the strongest
 * anchor available without a network, and it is stronger than a person
 * choosing to look.
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
 *
 * **What a moved surface costs, which this file used to state wrongly.**
 * Breaking an export is a break and ships as at least a minor, with a commit
 * footer naming it — not as a major. Removing one is the obvious case;
 * narrowing a signature, tightening a type or dropping a parameter is the
 * same break and takes the same bump, because what decides it is whether a
 * caller compiled before and does not now. Pre-launch nothing outside this estate
 * consumes these packages, so a major buys no consumer anything, and on a
 * workspace dependency it costs something real: a package still pinned to the
 * old major resolves a second copy of it into the install tree beside the one
 * every other package resolves, and two copies of a types package is two
 * definitions of the same shape. The rule changes the day there is an external
 * consumer to protect, and not before.
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

/**
 * A package whose recorded surface moved while its version stood still.
 *
 * The baseline is a committed lock and the head side is the file on disk,
 * which are the same thing in CI and not locally. This is a statement about the
 * change rather than about the tree: whatever the working copy builds, this
 * pull request would leave the repository claiming that one version named
 * two different surfaces.
 */
export interface SurfaceLockDrift {
  name: string;
  /** The version both locks record, which is the whole problem. */
  version: string;
  from: string;
  to: string;
  fromExports: number;
  toExports: number;
}

/**
 * Compare a committed lock against the lock on the base it merges into.
 *
 * **Only one shape is a violation**, and the three that are not are worth
 * naming so nobody adds them later thinking they were forgotten.
 *
 * - *Hash moved, version moved.* The intended flow. A new version is free to
 *   name any surface it likes; that is what a version is for.
 * - *Hash stood, version moved.* A release with no surface change — a bug
 *   fix, a dependency bump, a re-publish. Nothing here to refuse.
 * - *Package absent from one side.* Added or removed by this change. The
 *   tree-against-lock comparison already owns both, with better messages,
 *   and restating them here would make two rules free to drift.
 * - *Hash moved, version stood.* The violation: the base says version V
 *   exported one surface and this change says V exports another.
 *
 * Note what is **not** asked: whether the working tree agrees with either
 * lock. `compareToSurfaceLock` asks that, and asking it twice in two places
 * is how the two would come to disagree.
 */
export function compareSurfaceLocks(
  baseline: SurfaceLock,
  head: SurfaceLock,
): SurfaceLockDrift[] {
  const drifts: SurfaceLockDrift[] = [];
  for (const name of Object.keys(head).sort(byCodeUnit)) {
    const before = baseline[name];
    const after = head[name];
    if (!before || !after) continue;
    if (before.version !== after.version) continue;
    if (before.hash === after.hash) continue;
    drifts.push({
      name,
      version: after.version,
      from: before.hash,
      to: after.hash,
      fromExports: before.exports,
      toExports: after.exports,
    });
  }
  return drifts;
}

/** A sentence a reader can act on, for the case a diff would not explain. */
export function describeSurfaceLockDrift(d: SurfaceLockDrift): string {
  const counts =
    d.fromExports === d.toExports
      ? `Still ${String(d.toExports)} exported names, so a declaration changed shape or a name was swapped for another — neither moves the count.`
      : `${String(d.toExports)} exported names now, ${String(d.fromExports)} on the base.`;
  return (
    `${d.name}@${d.version}: the surface recorded for this version is not the surface the base records for it. ` +
    `${counts} ` +
    `Move ${d.name}'s version and regenerate, so the two surfaces have two version numbers. ` +
    `If nothing in ${d.name} was touched, look for the change in a package it re-exports: widening a type in a dependency ` +
    `moves what this package's consumers compile against without moving a line of its own source, and that is the case this check exists for. ` +
    `Regenerating the lock again will not clear this — regenerating is what produced the second surface.`
  );
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
        `Removing an export is at least a minor, with a commit footer naming the break. Not a major: nothing outside ` +
        `this estate consumes these packages yet, and a major on a workspace dependency nests a second copy of it in ` +
        `the install tree beside the one every other package resolves. ${REGENERATE}`
      );
    case "version-moved":
      return (
        `${v.name} moved ${v.from} to ${v.to} and the lock still records ${v.from}, ` +
        `so the surface it holds is a claim about a version nothing is building. ${REGENERATE}`
      );
  }
}

/**
 * The whole rule, as a value rather than as control flow in a script.
 *
 * The script that runs this in CI used to hold the decision itself: compare,
 * branch on the length, print, exit. Nothing could reach that branch from a
 * test, so `if (drifts.length >= 0)` and an exit code of zero on the refusal
 * path both passed the entire suite. **The guard could be switched off inside
 * the file that is the guard**, which is the failure this whole change exists
 * to prevent, one level up. So the decision lives here and the script is an
 * I/O shell around it.
 *
 * `code` is the process exit status, and 1 and 2 mean different things: 1 is
 * a surface that moved under a standing version, 2 is a check that could not
 * see enough to say. Collapsing them would make a malformed lock file read as
 * a violation, which sends the next reader looking for a change nobody made.
 */
export interface SurfaceLockVerdict {
  code: 0 | 1;
  report: string;
}

export function decideSurfaceLockDrift(
  baseline: SurfaceLock,
  head: SurfaceLock,
  baseRef: string,
): SurfaceLockVerdict {
  const drifts = compareSurfaceLocks(baseline, head);
  if (drifts.length === 0) {
    return {
      code: 0,
      report:
        "published surface lock: no package's surface moved under a standing " +
        `version (${String(Object.keys(head).length)} packages, base ${baseRef})`,
    };
  }
  const plural = drifts.length === 1 ? "" : "s";
  return {
    code: 1,
    report:
      `A published surface moved without its version moving, in ${String(drifts.length)} package${plural}:\n\n` +
      drifts.map((d) => `  - ${describeSurfaceLockDrift(d)}`).join("\n\n"),
  };
}

/**
 * A parse is not a read.
 *
 * The comparison skips a package the baseline does not carry, which is right
 * for a package that genuinely did not exist yet. It cannot tell that apart
 * from a baseline that carries nothing at all — so `{}`, `[]`, or entries
 * missing `version` or `hash` all produce an empty drift list and a green
 * tick, which is precisely the "reports not knowing as agreement" this file's
 * own docstring promises never happens. The head side has the tree check
 * behind it; the baseline side has nothing, so the shape is asserted here.
 */
export function assertLockShape(value: unknown, what: string): SurfaceLock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not a JSON object.`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(
      `${what} records no packages. An empty lock compares equal to every tree.`,
    );
  }
  for (const [name, entry] of entries) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${what}: ${name} is not an object.`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.version !== "string" || typeof e.hash !== "string") {
      throw new Error(
        `${what}: ${name} carries no version or no hash, so it would be skipped rather than compared.`,
      );
    }
  }
  return value as SurfaceLock;
}
