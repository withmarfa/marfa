/**
 * No file in the repository holds a product version.
 *
 * A version exists only when a git tag is cut. The release workflow reads
 * the tag, stamps it into every manifest in its own checkout and commits
 * nothing, so every manifest here carries the placeholder and a change that
 * moves one off it is refused, whatever else it does. The placeholder is
 * `0.0.0`, which npm, cargo and SwiftPM all accept as a version and which
 * no release can ever be, so a stamped build and an unstamped one cannot be
 * confused.
 *
 * Three files carry one: `package.json` (`version`), `Cargo.toml`
 * (`version = ` under `[package]` or `[workspace.package]`; a crate that
 * says `version.workspace = true` holds none of its own) and `Cargo.lock`,
 * whose entries for the workspace's own crates, the ones with no `source`,
 * are rewritten by cargo from the manifests. `Package.swift` holds no
 * version by construction: SwiftPM versions a package by its tag.
 *
 * The manifests are read from `git ls-files`, so an untracked scratch
 * package is not judged and a tracked one cannot hide.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PLACEHOLDER = "0.0.0";

export interface Manifest {
  path: string;
  text: string;
}

/** One manifest holding a version the placeholder rule refuses. */
export interface VersionHeld {
  path: string;
  version: string;
}

function packageJsonVersions(m: Manifest): VersionHeld[] {
  const pkg = JSON.parse(m.text) as { version?: unknown };
  if (typeof pkg.version !== "string") return [];
  return pkg.version === PLACEHOLDER
    ? []
    : [{ path: m.path, version: pkg.version }];
}

function cargoTomlVersions(m: Manifest): VersionHeld[] {
  const held: VersionHeld[] = [];
  let section = "";
  for (const line of m.text.split("\n")) {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) {
      section = heading[1] ?? "";
      continue;
    }
    if (section !== "package" && section !== "workspace.package") continue;
    const version = /^\s*version\s*=\s*"([^"]*)"/.exec(line);
    if (version && version[1] !== PLACEHOLDER) {
      held.push({ path: m.path, version: version[1] ?? "" });
    }
  }
  return held;
}

function cargoLockVersions(m: Manifest): VersionHeld[] {
  const held: VersionHeld[] = [];
  for (const block of m.text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    // A crate cargo fetched carries `source`; a workspace member does not,
    // and its version is the manifest's, which the stamp rewrites.
    if (/^source\s*=/m.test(block)) continue;
    const version = /^version\s*=\s*"([^"]*)"/m.exec(block);
    if (version && version[1] !== PLACEHOLDER) {
      const name = /^name\s*=\s*"([^"]*)"/m.exec(block)?.[1] ?? "?";
      held.push({ path: `${m.path} (${name})`, version: version[1] ?? "" });
    }
  }
  return held;
}

/** Every version a manifest holds that is not the placeholder. */
export function versionsHeld(manifests: readonly Manifest[]): VersionHeld[] {
  const held: VersionHeld[] = [];
  for (const m of manifests) {
    if (m.path.endsWith("package.json")) held.push(...packageJsonVersions(m));
    else if (m.path.endsWith("Cargo.toml")) held.push(...cargoTomlVersions(m));
    else if (m.path.endsWith("Cargo.lock")) held.push(...cargoLockVersions(m));
  }
  return held;
}

/** The tracked manifests, read off the tree. */
function trackedManifests(): Manifest[] {
  const listed = execFileSync(
    "git",
    ["ls-files", "--", "*package.json", "*Cargo.toml", "*Cargo.lock"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line.length > 0);
  return listed.map((path) => ({
    path,
    text: readFileSync(join(ROOT, path), "utf8"),
  }));
}

describe("no file holds a version", () => {
  const manifests = trackedManifests();

  it("finds the manifests, so an empty pass cannot be a missing tree", () => {
    const kinds = new Set(manifests.map((m) => m.path.split("/").pop()));
    expect([...kinds].sort()).toEqual([
      "Cargo.lock",
      "Cargo.toml",
      "package.json",
    ]);
  });

  it("every tracked manifest carries the placeholder", () => {
    expect(versionsHeld(manifests)).toEqual([]);
  });

  it("would refuse a manifest that holds a version", () => {
    // The witness: the same rule over manifests that do hold one, so the
    // green above is the rule passing and not the rule reading nothing.
    const held = versionsHeld([
      {
        path: "packages/example/package.json",
        text: JSON.stringify({ name: "@withmarfa/example", version: "0.1.0" }),
      },
      {
        path: "core/Cargo.toml",
        text: '[workspace.package]\nversion = "0.1.0"\nedition = "2024"\n',
      },
      {
        path: "core/example/Cargo.toml",
        text: '[package]\nname = "example"\nversion.workspace = true\n\n[dependencies]\nserde = { version = "1" }\n',
      },
      {
        path: "core/Cargo.lock",
        text: '[[package]]\nname = "example"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
      },
    ]);
    expect(held).toEqual([
      { path: "packages/example/package.json", version: "0.1.0" },
      { path: "core/Cargo.toml", version: "0.1.0" },
      { path: "core/Cargo.lock (example)", version: "0.1.0" },
    ]);
  });
});
