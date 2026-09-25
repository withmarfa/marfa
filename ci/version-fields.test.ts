/**
 * No file in the repository holds a product version.
 *
 * A version exists only when a git tag is cut: `release.yml` runs
 * `scripts/release/stamp-version.sh` in its own checkout, which writes the
 * tag's version into every manifest there, and nothing on a branch runs it.
 * So every manifest here carries the placeholder, and a change that moves
 * one off it is refused, whatever else it does. The placeholder is `0.0.0`,
 * which npm and cargo both accept as a version and which no release can ever
 * be, so a stamped build and an unstamped one cannot be confused.
 *
 * Three files carry one: `package.json` (`version`, on every package; the
 * root is a workspace, not a package, and holds none), `Cargo.toml` and
 * `Cargo.lock`. Cargo manifests are read through `cargo metadata` rather
 * than parsed here, because TOML has more than one spelling for a version
 * (`version = `, `version.workspace = true`, a dotted key, a commented
 * header) and cargo's own reading is the one a build uses. The lock's
 * entries for the workspace's own crates, the ones with no `source`, are
 * cargo's own formatting and are read directly. The API document's
 * `info.version` is the contract version, not a product version.
 *
 * Two kinds of file that are not manifests are read for a product version
 * written as text: `packages/server/src/contract.ts`, where the contract
 * version lives and a product version could be mistaken for it, and every
 * README a published package ships, where an install line is the natural
 * place to write one. Either would pass the manifest rules untouched. What
 * is refused is the release grammar, three dotted numbers; the contract
 * version is one integer and is not one.
 *
 * The placeholder has to be present, not merely not-something-else: the
 * stamp sets the version wherever it finds the placeholder, so a manifest
 * that dropped the field would build unversioned. A `Cargo.toml` is also
 * held to the line the stamp rewrites, `version = "0.0.0"` or
 * `version.workspace = true`, because cargo reads a crate with no version as
 * `0.0.0` and the stamp would then refuse it at the tag. The manifests are
 * read from `git ls-files`, the same listing the stamp walks.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PLACEHOLDER = "0.0.0";

export interface Manifest {
  path: string;
  text: string;
}

/** One manifest holding something other than the placeholder. */
export interface VersionHeld {
  path: string;
  /** The version found; `(none)` where a package.json has none, and for a
   *  Cargo.toml the line found or `(no placeholder line)`. */
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

/** The crate's own version line, as the stamp reads it: the first `version`
 *  key under `[package]` or `[workspace.package]`, never a dependency's. */
function packageVersionLine(text: string): string | undefined {
  let own = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) {
      own = line === "[package]" || line === "[workspace.package]";
    } else if (own && /^version[ .]/.test(line)) {
      return line;
    }
  }
  return undefined;
}

/** A `Cargo.toml` without the line the stamp rewrites. */
function cargoTomlLine(m: Manifest): VersionHeld[] {
  const line = packageVersionLine(m.text);
  if (line === "version.workspace = true") return [];
  if (line === `version = "${PLACEHOLDER}"`) return [];
  return [{ path: m.path, version: line ?? "(no placeholder line)" }];
}

/** Every version a manifest holds that is not the placeholder, and every
 *  `Cargo.toml` the stamp could not rewrite. */
export function versionsHeld(manifests: readonly Manifest[]): VersionHeld[] {
  const held: VersionHeld[] = [];
  for (const m of manifests) {
    if (m.path.endsWith("package.json")) held.push(...packageJsonVersions(m));
    else if (m.path.endsWith("Cargo.lock")) held.push(...cargoLockVersions(m));
    else if (m.path.endsWith("Cargo.toml")) held.push(...cargoTomlLine(m));
  }
  return held;
}

interface CargoPackage {
  name: string;
  version: string;
  manifest_path: string;
}

/**
 * Every crate of the cargo workspace at `dir` whose version is not the
 * placeholder, as cargo itself reads the manifests. Offline and without
 * dependencies: the question is about the workspace's own crates, and a
 * check must not reach for the registry.
 */
export function cargoVersionsHeld(dir: string, root: string): VersionHeld[] {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--no-deps", "--offline", "--format-version", "1"],
      { cwd: dir, encoding: "utf8" },
    ),
  ) as { packages: CargoPackage[] };
  return metadata.packages
    .filter((p) => p.version !== PLACEHOLDER)
    .map((p) => ({
      path: `${relative(realpathSync(root), p.manifest_path)} (${p.name})`,
      version: p.version,
    }));
}

/** A product version as a release tag carries it: three dotted numbers. */
const VERSION_TEXT = /\bv?\d+\.\d+\.\d+\b/g;

/** Every product version a file writes as text. */
export function versionsWritten(files: readonly Manifest[]): VersionHeld[] {
  return files.flatMap((f) =>
    [...f.text.matchAll(VERSION_TEXT)].map((match) => ({
      path: f.path,
      version: match[0],
    })),
  );
}

/** The file that holds the contract version, beside the build's. */
const CONTRACT_FILE = "packages/server/src/contract.ts";

/**
 * Every directory a published package is built from: a package.json that is
 * not private, and a crate cargo would publish.
 */
function publishedDirs(manifests: readonly Manifest[]): string[] {
  const dirs = new Set<string>();
  for (const m of manifests) {
    if (!m.path.endsWith("package.json") || m.path === "package.json") continue;
    const pkg = JSON.parse(m.text) as { private?: boolean };
    if (pkg.private !== true) dirs.add(dirname(m.path));
  }
  for (const dir of cargoDirs(manifests)) {
    const metadata = JSON.parse(
      execFileSync(
        "cargo",
        ["metadata", "--no-deps", "--offline", "--format-version", "1"],
        { cwd: dir, encoding: "utf8" },
      ),
    ) as { packages: (CargoPackage & { publish: string[] | null })[] };
    for (const p of metadata.packages) {
      if (p.publish === null) {
        dirs.add(relative(realpathSync(ROOT), dirname(p.manifest_path)));
      }
    }
  }
  return [...dirs].sort();
}

/** The READMEs a published package ships, read off the tree, with or
 *  without an extension: npm ships a bare `README` too. */
function publishedReadmes(dirs: readonly string[]): Manifest[] {
  return execFileSync(
    "git",
    ["ls-files", "--", ...dirs.map((dir) => `:(glob)${dir}/**/README*`)],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line.length > 0)
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
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

/** Every directory holding a tracked `Cargo.toml`: each is asked of cargo,
 *  so a crate outside every tracked lock is read too. */
function cargoDirs(manifests: readonly Manifest[]): string[] {
  return manifests
    .filter((m) => m.path.endsWith("Cargo.toml"))
    .map((m) => dirname(join(ROOT, m.path)));
}

describe("no file holds a version", () => {
  const manifests = trackedManifests();
  const scratch: string[] = [];

  afterEach(() => {
    while (scratch.length > 0) {
      rmSync(scratch.pop()!, { recursive: true, force: true });
    }
  });

  it("finds the manifests, so an empty pass cannot be a missing tree", () => {
    const kinds = new Set(manifests.map((m) => m.path.split("/").pop()));
    expect([...kinds].sort()).toEqual([
      "Cargo.lock",
      "Cargo.toml",
      "package.json",
    ]);
    expect(cargoDirs(manifests).length).toBeGreaterThan(0);
  });

  it("every tracked manifest carries the placeholder", () => {
    expect(versionsHeld(manifests)).toEqual([]);
  });

  it("every crate cargo reads off the tree carries the placeholder", () => {
    for (const dir of cargoDirs(manifests)) {
      expect(cargoVersionsHeld(dir, ROOT), dir).toEqual([]);
    }
  });

  it("finds every published package and its README", () => {
    // Derived rather than listed, so a package that starts publishing is
    // read here without anyone adding it; counted, so one that is dropped
    // is noticed.
    const dirs = publishedDirs(manifests);
    expect(dirs).toEqual([
      "core/bindings/node",
      "core/marfa-client",
      "packages/client",
    ]);
    expect(publishedReadmes(dirs).map((f) => f.path)).toEqual([
      "packages/client/README.md",
    ]);
  });

  it("no published README and not the contract file writes a product version", () => {
    const files = [
      ...publishedReadmes(publishedDirs(manifests)),
      {
        path: CONTRACT_FILE,
        text: readFileSync(join(ROOT, CONTRACT_FILE), "utf8"),
      },
    ];
    expect(versionsWritten(files)).toEqual([]);
  });

  it("would refuse a version written as text, and not the contract integer", () => {
    // The witness: the rule over files that do write one, beside the
    // contract file as it is, which must pass.
    expect(
      versionsWritten([
        {
          path: "packages/client/README.md",
          text: "npm install @withmarfa/client@0.0.1\n",
        },
        {
          path: "packages/client/README.md",
          text: "Tagged as v1.2.3.\n",
        },
        {
          path: CONTRACT_FILE,
          text: 'export const CONTRACT_VERSION = 1;\nexport const BUILD = "0.0.4";\n',
        },
        {
          path: CONTRACT_FILE,
          text: readFileSync(join(ROOT, CONTRACT_FILE), "utf8"),
        },
      ]),
    ).toEqual([
      { path: "packages/client/README.md", version: "0.0.1" },
      { path: "packages/client/README.md", version: "v1.2.3" },
      { path: CONTRACT_FILE, version: "0.0.4" },
    ]);
  });

  it("would refuse a package.json or Cargo.lock that holds a version, or none", () => {
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
        path: "core/Cargo.lock",
        text: '[[package]]\nname = "example"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
      },
    ]);
    expect(held).toEqual([
      { path: "packages/example/package.json", version: "0.1.0" },
      { path: "packages/unversioned/package.json", version: "(none)" },
      { path: "package.json", version: "0.1.0" },
      { path: "core/Cargo.lock (example)", version: "0.1.0" },
    ]);
  });

  it("reads a crate's own version line, never a dependency's", () => {
    expect(
      versionsHeld([
        {
          path: "d/Cargo.toml",
          text: 'package.name = "d"\npackage.version = "1.2.3"\n\n[dependencies.foo]\nversion = "0.0.0"\n',
        },
      ]),
    ).toEqual([{ path: "d/Cargo.toml", version: "(no placeholder line)" }]);
  });

  it("would refuse a Cargo.toml without the line the stamp rewrites", () => {
    // cargo reads a crate with no version as 0.0.0, so the cargo check below
    // passes it; the stamp would refuse it at the tag.
    expect(
      versionsHeld([
        { path: "a/Cargo.toml", text: '[package]\nname = "a"\n' },
        {
          path: "b/Cargo.toml",
          text: '[package]\nname = "b"\nversion.workspace = true\n',
        },
        {
          path: "c/Cargo.toml",
          text: '[package]\nname = "c"\nversion = "0.0.0"\n',
        },
      ]),
    ).toEqual([{ path: "a/Cargo.toml", version: "(no placeholder line)" }]);
  });

  it("would refuse a crate whose manifest holds a version, however spelled", () => {
    // A workspace of one crate, spelled two ways a line parser misses and
    // cargo reads: a commented table header, and dotted keys with no header.
    const dir = mkdtempSync(join(tmpdir(), "version-fields-"));
    scratch.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "lib.rs"), "");

    writeFileSync(
      join(dir, "Cargo.toml"),
      '[package] # the crate\nname = "probe"\nedition = "2024"\nversion = "0.1.0"\n',
    );
    expect(cargoVersionsHeld(dir, dir)).toEqual([
      { path: "Cargo.toml (probe)", version: "0.1.0" },
    ]);

    writeFileSync(
      join(dir, "Cargo.toml"),
      'package.name = "probe"\npackage.edition = "2024"\npackage.version = "0.1.0"\n',
    );
    expect(cargoVersionsHeld(dir, dir)).toEqual([
      { path: "Cargo.toml (probe)", version: "0.1.0" },
    ]);

    writeFileSync(
      join(dir, "Cargo.toml"),
      '[package]\nname = "probe"\nedition = "2024"\nversion = "0.0.0"\n',
    );
    expect(cargoVersionsHeld(dir, dir)).toEqual([]);
  });
});
