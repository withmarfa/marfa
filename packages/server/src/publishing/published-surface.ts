/**
 * The published surface lock: what every publishable package in the pnpm
 * workspace exports, in what shape, recorded so a surface cannot change
 * without the record changing with it. The Node binding is outside it; see
 * `read-surfaces.ts`.
 *
 * A version is not recorded. A version is a tag, so no version exists on a
 * branch for a surface to stand under; what the lock holds is the surface
 * itself. The tree is compared against the lock on every run, and a moved
 * surface is refused until the lock is regenerated, which puts the move in
 * the pull request's diff as the names that were added, removed or changed,
 * and lets two commits' locks be compared name by name.
 *
 * Why the declaration file rather than the runtime module: a type-only
 * export is part of the contract a consumer compiles against, and the built
 * JavaScript carries only the values.
 *
 * Why a hash of the declarations rather than of the whole built file: a
 * comment, an import reordering or a changed implementation is not a change
 * to what the package offers. The hash is over each exported name paired
 * with the declaration emitted for it, so it moves when the contract moves
 * and not otherwise.
 *
 * The names alone are not the contract: a three-member union widened to
 * four changes what every consumer compiles against and moves no name. So
 * every declaration is hashed, and the lock records a hash per name beside
 * the hash of the whole, so a diff of the lock says which names moved.
 *
 * Type references are followed only into the package's own declaration
 * files. An exported interface typed by a private helper declared beside it
 * is covered, because that helper is part of what the package emits. One
 * typed by something a dependency declares is recorded as the reference it
 * is, so a major version of that dependency reshapes what consumers compile
 * against without moving anything here. That gap is stated rather than
 * closed, because closing it means hashing declarations this repository
 * does not own.
 *
 * Declarations are hashed as the compiler prints them, with comments
 * removed and layout normalized, so neither a reworded doc comment nor a
 * change in how the emitter indents reaches the digest. A TypeScript or
 * bundler upgrade that renders declarations differently moves every hash at
 * once, which is loud, and one command clears it.
 *
 * A name is hashed against the subpath that exports it as well as its
 * declaration, so moving a name between entry points moves the hash even
 * though the file and the shape are untouched. A binding's keyword is hashed
 * too, because `const` and `let` print identically otherwise and widening
 * one breaks a consumer relying on it being fixed.
 */
import { createHash } from "node:crypto";

/** One package's recorded surface. */
export interface SurfaceLockEntry {
  /** sha256 over every exported name paired with its declaration. */
  hash: string;
  /** Each exported name, with the sha256 of its declaration. */
  exports: Record<string, string>;
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
  return sha256(JSON.stringify(canonical));
}

/** The per-name half of an entry, sorted so the file diffs by name. */
function hashEachExport(
  exports: readonly SurfaceExport[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of [...exports].sort((a, b) => byCodeUnit(a.name, b.name))) {
    out[e.name] = sha256(e.declaration);
  }
  return out;
}

/** Build a lock from the surfaces read off the tree. */
export function buildSurfaceLock(
  surfaces: readonly PackageSurface[],
): SurfaceLock {
  const out: SurfaceLock = {};
  for (const s of [...surfaces].sort((a, b) => byCodeUnit(a.name, b.name))) {
    out[s.name] = {
      hash: hashSurface(s.exports),
      exports: hashEachExport(s.exports),
    };
  }
  return out;
}

/** How two recordings of one package's surface differ, by name. */
export interface SurfaceDelta {
  added: string[];
  removed: string[];
  /** Names on both sides whose declaration hash differs. */
  changed: string[];
}

/** Compare two recordings of one package's surface, name by name. */
export function surfaceDelta(
  before: SurfaceLockEntry,
  after: SurfaceLockEntry,
): SurfaceDelta {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const name of Object.keys(after.exports).sort(byCodeUnit)) {
    const was = before.exports[name];
    if (was === undefined) added.push(name);
    else if (was !== after.exports[name]) changed.push(name);
  }
  for (const name of Object.keys(before.exports).sort(byCodeUnit)) {
    if (!(name in after.exports)) removed.push(name);
  }
  return { added, removed, changed };
}

/** A single way the tree and the lock disagree. */
export type SurfaceViolation =
  | { kind: "unlocked"; name: string }
  | { kind: "removed"; name: string }
  | { kind: "surface-moved"; name: string; delta: SurfaceDelta }
  | { kind: "names-stale"; name: string; delta: SurfaceDelta };

/**
 * Compare the tree against the lock.
 *
 * The lock is a snapshot of the tree, and the only question asked is
 * whether the snapshot still describes it. The normal, correct flow is
 * quiet: change the surface, regenerate, commit both. A moved surface with
 * a stale lock is refused, because regenerating is the act that records
 * having looked, and it is the half a reviewer can see.
 *
 * Every kind blocks, and the remedy for all four is the same one command.
 * There is no violation here a reader can decide to ignore, because a
 * violation that could be ignored is a guard that blocks nothing.
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
      violations.push({ kind: "unlocked", name: s.name });
      continue;
    }
    const current = {
      hash: hashSurface(s.exports),
      exports: hashEachExport(s.exports),
    };
    const delta = surfaceDelta(entry, current);
    if (entry.hash !== current.hash) {
      violations.push({ kind: "surface-moved", name: s.name, delta });
    } else if (
      delta.added.length + delta.removed.length + delta.changed.length >
      0
    ) {
      // The whole hash is what gates; the per-name map is what a reader
      // diffs. A map that no longer describes the hash would tell a reader
      // the wrong names moved, so it is held to the tree as well.
      violations.push({ kind: "names-stale", name: s.name, delta });
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
 * would be written, and an exclusion written here is how a guard comes to
 * record violations that never fail a build. Anything added to this filter
 * needs an argument for why a build should ship with the tree and the lock
 * disagreeing.
 */
export function blockingViolations(
  violations: readonly SurfaceViolation[],
): SurfaceViolation[] {
  return [...violations];
}

/**
 * The delta as a phrase. A hash can move with no name moving, when a
 * declaration's subpath changed and nothing else, and that is said rather
 * than left as an empty string.
 */
export function describeSurfaceDelta(d: SurfaceDelta): string {
  const parts: string[] = [];
  if (d.added.length > 0) parts.push(`added ${d.added.join(", ")}`);
  if (d.removed.length > 0) parts.push(`removed ${d.removed.join(", ")}`);
  if (d.changed.length > 0) parts.push(`changed ${d.changed.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "no name moved";
}

/** A sentence a reader can act on. */
export function describeSurfaceViolation(v: SurfaceViolation): string {
  const REGENERATE =
    "Run `pnpm --filter @withmarfa/server run surface-lock:generate`.";
  switch (v.kind) {
    case "unlocked":
      return `${v.name} is publishable and absent from the lock. ${REGENERATE}`;
    case "removed":
      return `${v.name} is in the lock and is no longer a publishable package. Run the generator to drop it.`;
    case "surface-moved":
      return (
        `${v.name}: the surface the tree builds is not the surface the lock records (${describeSurfaceDelta(v.delta)}). ` +
        `A removed or reshaped name is a break for a consumer. ${REGENERATE}`
      );
    case "names-stale":
      return (
        `${v.name}: the lock's hash matches the tree and its names do not (${describeSurfaceDelta(v.delta)}), ` +
        `so the lock was edited by hand. ${REGENERATE}`
      );
  }
}

/**
 * A parse is not a read.
 *
 * A comparison that skips what it cannot read reports not knowing as
 * agreement: `{}`, `[]`, or entries missing `hash` or `exports` would all
 * compare equal to everything. The shape is asserted before a lock read
 * off disk is compared with anything.
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
    if (
      typeof e.hash !== "string" ||
      typeof e.exports !== "object" ||
      e.exports === null ||
      Array.isArray(e.exports) ||
      Object.keys(e.exports).length === 0
    ) {
      throw new Error(
        `${what}: ${name} carries no hash or no exports, so it would be skipped rather than compared.`,
      );
    }
  }
  return value as SurfaceLock;
}
