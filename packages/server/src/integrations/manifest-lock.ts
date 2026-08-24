/**
 * The manifest lock: what each manifest this build ships declared, and at
 * which version, recorded so a change cannot reach `main` without moving
 * one.
 *
 * It covers the client manifests, which are the manifests this repository
 * can read: they are compiled into the build and reachable from a
 * constant. An installed integration's arrives from withmarfa/integrations
 * at whatever commit the image pinned, so there is nothing here to compare
 * it against and an entry for one would be a claim about a tree this build
 * cannot see.
 *
 * The defect this exists for. A catalog row is keyed on
 * `(manifest_name, manifest_version)` and is never rewritten, so a manifest
 * whose CONTENT changes while its version stands still can never be
 * registered: it collides with the stale row it was meant to replace, and
 * the catalog keeps answering for a capability the build has. That is not
 * hypothetical. `supports_user_mappings` was added to `marfa/rss-watcher`
 * without a version bump, and the result was a shipped, tested, merged
 * capability that was unreachable on every running instance, with nothing
 * reporting it. The version bump that fixed it had to be its own commit.
 *
 * The opposite shape is recorded here too, and refused: a version that
 * moves with no content change. It registers a sibling row identical to
 * the one beside it, which is a second catalog entry that means nothing and
 * one more manifest for a connection to be stranded on.
 *
 * Why a hash of the manifest rather than of the file: a comment or an
 * import reordering is not a change to what the integration declares, and
 * demanding a version bump for one would train people to bump without
 * meaning it. The hash is over the manifest's own canonical JSON.
 */
import { createHash } from "node:crypto";
import type { IntegrationManifest } from "@withmarfa/shared";

export interface ManifestLockEntry {
  version: string;
  /** SHA-256 over the manifest's canonical JSON, minus `version` itself. */
  hash: string;
}

export type ManifestLock = Record<string, ManifestLockEntry>;

/**
 * Stable stringify: object keys sorted at every depth, so a formatter
 * reordering a manifest literal does not read as a declaration change.
 * Arrays keep their order, because order is meaningful in `target_types`
 * and `triggers` in a way key order never is.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Hash what a manifest DECLARES, with `version` excluded.
 *
 * Excluding it is what lets the two failure shapes be told apart. With
 * `version` in the hash, every version bump changes the hash and a bump
 * with no real change is indistinguishable from a real one.
 */
export function hashManifestDeclaration(manifest: IntegrationManifest): string {
  const declaration: Record<string, unknown> = {
    ...(manifest as unknown as Record<string, unknown>),
  };
  delete declaration.version;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(declaration)))
    .digest("hex");
}

export function buildManifestLock(
  manifests: readonly { manifest: IntegrationManifest }[],
): ManifestLock {
  const lock: ManifestLock = {};
  for (const { manifest } of manifests) {
    lock[manifest.name] = {
      version: manifest.version,
      hash: hashManifestDeclaration(manifest),
    };
  }
  // Sorted so the committed file is diffable and a new integration lands as
  // one added line rather than a reshuffle.
  return Object.fromEntries(
    Object.entries(lock).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export type LockViolation =
  | {
      kind: "content_changed_without_version";
      name: string;
      version: string;
    }
  | {
      kind: "version_moved_without_content";
      name: string;
      from: string;
      to: string;
    }
  | { kind: "missing_from_lock"; name: string; version: string }
  | { kind: "missing_from_build"; name: string };

/** Compare the built manifests against the committed lock. */
export function compareToLock(
  built: ManifestLock,
  committed: ManifestLock,
): LockViolation[] {
  const violations: LockViolation[] = [];
  for (const [name, entry] of Object.entries(built)) {
    const prior = committed[name];
    if (!prior) {
      violations.push({
        kind: "missing_from_lock",
        name,
        version: entry.version,
      });
      continue;
    }
    if (prior.hash !== entry.hash && prior.version === entry.version) {
      violations.push({
        kind: "content_changed_without_version",
        name,
        version: entry.version,
      });
    }
    if (prior.hash === entry.hash && prior.version !== entry.version) {
      violations.push({
        kind: "version_moved_without_content",
        name,
        from: prior.version,
        to: entry.version,
      });
    }
  }
  for (const name of Object.keys(committed)) {
    if (!(name in built)) violations.push({ kind: "missing_from_build", name });
  }
  return violations;
}

export function describeViolation(v: LockViolation): string {
  switch (v.kind) {
    case "content_changed_without_version":
      return `${v.name} changed what it declares while staying at ${v.version}. A catalog row is keyed on (name, version) and is never rewritten, so this manifest cannot be registered anywhere it is already at ${v.version}: bump the version.`;
    case "version_moved_without_content":
      return `${v.name} moved ${v.from} -> ${v.to} without changing what it declares. That registers a second catalog row identical to the first; drop the bump.`;
    case "missing_from_lock":
      return `${v.name}@${v.version} is not in the manifest lock. Regenerate it with \`pnpm --filter @withmarfa/server run manifest-lock:generate\`.`;
    case "missing_from_build":
      return `${v.name} is in the manifest lock but this build ships no manifest for it. If it was removed deliberately, regenerate the lock.`;
  }
}
