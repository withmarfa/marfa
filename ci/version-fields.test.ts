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
 * Three files carry one: `package.json` (`version`, on every package; the
 * root is a workspace, not a package, and holds none), `Cargo.toml`
 * (`version = ` under `[package]` or `[workspace.package]`; a crate that
 * says `version.workspace = true` holds none of its own) and `Cargo.lock`,
 * whose entries for the workspace's own crates, the ones with no `source`,
 * are rewritten by cargo from the manifests. `Package.swift` holds no
 * version by construction: SwiftPM versions a package by its tag. The API
 * document's `info.version` is the contract version, an integer that moves
 * when the wire breaks, and is not a product version.
 *
 * The placeholder has to be present, not merely not-something-else: the
 * stamp script sets the version wherever it finds the placeholder, so a
 * manifest that dropped the field would build unversioned. The manifests
 * are read from `git ls-files`, the same listing the stamp walks, so the
 * two cannot disagree about which files are manifests.
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

/** One manifest holding something other than the placeholder. */
export interface VersionHeld {
  path: string;
  /** The version found, or `(none)` where the placeholder is missing. */
  version: string;
}

function packageJsonVersions(m: Manifest): VersionHeld[] {
  const pkg = JSON.parse(m.text) as { version?: unknown };
  const version = typeof pkg.version === "string" ? pkg.version : "(none)";
  if (m.path === "package.json") {
    // The root is the workspace, not a package: nothing publishes it and
    // nothing reads a version off it.
    return version === "(none)" ? [] : [{ path: m.path, version }];
  }
  return version === PLACEHOLDER ? [] : [{ path: m.path, version }];
}

function cargoTomlVersions(m: Manifest): VersionHeld[] {
  const held: VersionHeld[] = [];
  const sections = new Map<string, string[]>();
  let section = "";
  for (const line of m.text.split("\n")) {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) {
      section = heading[1] ?? "";
      continue;
    }
    if (section !== "package" && section !== "workspace.package") continue;
    const lines = sections.get(section) ?? [];
    lines.push(line);
    sections.set(section, lines);
  }
  for (const [name, lines] of sections) {
    const literal = lines
      .map((line) => /^\s*version\s*=\s*"([^"]*)"/.exec(line)?.[1])
      .find((v) => v !== undefined);
    const fromWorkspace = lines.some((line) =>
      /^\s*version\.workspace\s*=\s*true/.test(line),
    );
    if (literal === PLACEHOLDER || (literal === undefined && fromWorkspace)) {
      continue;
    }
    held.push({ path: `${m.path} [${name}]`, version: literal ?? "(none)" });
  }
  return held;
}

function cargoLockVersions(m: Manifest): VersionHeld[] {
  const held: VersionHeld[] = [];
  for (const block of m.text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    // A crate cargo fetched carries `source`; a workspace member does not,
    // and its version is the manifest's, which the stamp rewrites.
    if (/^source\s*=/m.test(block)) continue;
    const version = /^version\s*=\s*"([^"]*)"/m.exec(block)?.[1] ?? "(none)";
    if (version !== PLACEHOLDER) {
      const name = /^name\s*=\s*"([^"]*)"/m.exec(block)?.[1] ?? "?";
      held.push({ path: `${m.path} (${name})`, version });
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

  it("would refuse a manifest that holds a version, or none", () => {
    // The witness: the same rule over manifests that do hold one, so the
    // green above is the rule passing and not the rule reading nothing.
    const held = versionsHeld([
      {
        path: "packages/example/package.json",
        text: JSON.stringify({ name: "@withmarfa/example", version: "0.1.0" }),
      },
      {
        path: "packages/unversioned/package.json",
        text: JSON.stringify({ name: "@withmarfa/unversioned" }),
      },
      {
        path: "package.json",
        text: JSON.stringify({ name: "@marfa/root", version: "0.1.0" }),
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
        path: "core/loose/Cargo.toml",
        text: '[package]\nname = "loose"\nedition = "2024"\n',
      },
      {
        path: "core/Cargo.lock",
        text: '[[package]]\nname = "example"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
      },
    ]);
    expect(held).toEqual([
      { path: "packages/example/package.json", version: "0.1.0" },
      { path: "packages/unversioned/package.json", version: "(none)" },
      { path: "package.json", version: "0.1.0" },
      { path: "core/Cargo.toml [workspace.package]", version: "0.1.0" },
      { path: "core/loose/Cargo.toml [package]", version: "(none)" },
      { path: "core/Cargo.lock (example)", version: "0.1.0" },
    ]);
  });
});
