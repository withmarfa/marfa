/**
 * Marfa sends nothing about itself until its owner sets where, so product code
 * carries no vendor's name or token and no vendor's SDK, except the places
 * below, each with its reason.
 *
 * Product code is what an owner runs or reads, and what builds it: `core/`,
 * `packages/`, `deploy/`, `scripts/install.sh`, `scripts/release/`, the release
 * workflow, `.env.example` and the committed `openapi.json`. The contract
 * (`conformance/`), the other workflows and `ci/` are not shipped, and
 * `ci/test-telemetry.test.ts` and the Rust tests hold what a run sends.
 *
 * An allowed path must still exist and still name the vendor, so a file that
 * is renamed or cleaned up fails here until its entry goes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCOPE = [
  "core",
  "packages",
  "deploy",
  "scripts/install.sh",
  "scripts/release",
  ".github/workflows/release.yml",
  ".env.example",
  "openapi.json",
];

/** A path ending in `/` allows the folder; any other allows that file alone. */
const ALLOWED: readonly (readonly [path: string, reason: string])[] = [
  [
    "core/marfa-server/src/telemetry/sinks.rs",
    "the server's one place that builds a PostHog exception report",
  ],
  [
    "core/marfa-server/src/settings/registry.rs",
    "declares the two stored settings, posthog_host and posthog_project_token",
  ],
  [
    "core/marfa-server/src/settings/together.rs",
    "the rules that hold those two settings together and with private addresses",
  ],
  [
    "core/marfa-server/src/app/archive/restore/mod.rs",
    "names the two settings a restore leaves out",
  ],
  [
    "core/marfa-telemetry/",
    "the crate the server's report is built in, which sends nothing itself",
  ],
  [
    "core/marfa-server/tests/",
    "tests of the settings and the report, with a receiver the test owns",
  ],
  [
    "core/marfa-cli/tests/",
    "tests that the binary sends nothing to a PostHog host",
  ],
  [
    "core/TELEMETRY.md",
    "tells an owner what the server sends and which settings turn it on",
  ],
  [
    "core/scripts/no-telemetry.sh",
    "removes the variables a shell could carry before a test run starts a process",
  ],
  [
    "deploy/README.md",
    "tells an operator the two stored settings and that no variable sets them, and that releases carry the cloudflared connector",
  ],
  [
    ".env.example",
    "tells an operator the two stored settings and that no variable sets them",
  ],
  [
    "openapi.json",
    "carries the descriptions of the two settings the server declares",
  ],
  [
    "packages/client/src/generated/schema.ts",
    "generated from openapi.json, with the same descriptions",
  ],
  [
    "core/marfa-rules/icons/icon-set-simple-icons.json",
    "a brand icon an item can show, which is not telemetry",
  ],
  [
    "scripts/release/cloudflared.txt",
    "pins the tunnel connector every release ships: its version and the SHA-256 of each download",
  ],
  [
    "scripts/release/cloudflared-pins.sh",
    "reads that pin file for the scripts that fetch and check the connector",
  ],
  [
    "scripts/release/fetch-cloudflared.sh",
    "downloads the connector, holds it to its pin and adds its licence to the notices",
  ],
  [
    "scripts/release/build-programs.sh",
    "runs the fetch so that the programs' folder holds the connector",
  ],
  [
    "scripts/release/pack-programs.sh",
    "packs the connector beside the two programs in each release archive",
  ],
  [
    "scripts/release/check-archive.sh",
    "refuses an archive whose connector is missing, is not the pinned program or does not run",
  ],
  [
    "scripts/release/image-context.sh",
    "lays the connector out for the image from the Linux archives",
  ],
  [
    "scripts/release/write-formula.sh",
    "installs the connector beside the two programs, off the path, in the Homebrew formula",
  ],
  [
    "scripts/release/install-proof.sh",
    "runs the connector the installer put in place",
  ],
  [
    "scripts/install.sh",
    "installs the connector beside the two programs, where the server looks for it",
  ],
  [
    "deploy/Dockerfile",
    "copies the connector into the image beside the two programs",
  ],
  [
    ".github/workflows/release.yml",
    "carries the connector from the Mac build into its archive, which no job signs",
  ],
];

/** A vendor token starts `phc_`; a name is matched in any case. */
const VENDOR = ["-e", "posthog", "-e", "phc_", "-e", "cloudflared"];

function allows(path: string): boolean {
  return ALLOWED.some(([entry]) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );
}

/** The tracked text files in scope that name the vendor. */
function hits(): string[] {
  try {
    return execFileSync(
      "git",
      ["grep", "-I", "-i", "-l", ...VENDOR, "--", ...SCOPE],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

function tracked(pattern: string): string[] {
  return execFileSync("git", ["ls-files", "--", pattern], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

const DEPENDENCY_TABLES = /(^|-)dependencies$/;

/** Every dependency a Cargo manifest names, by its own name and by its `package`. */
export function cargoDependencies(manifest: string): string[] {
  const found: string[] = [];
  const walk = (table: Record<string, unknown>, key: string): void => {
    if (DEPENDENCY_TABLES.test(key)) {
      for (const [name, value] of Object.entries(table)) {
        found.push(name);
        const renamed = (value as { package?: unknown } | null)?.package;
        if (typeof renamed === "string") found.push(renamed);
      }
      return;
    }
    for (const [name, value] of Object.entries(table)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, name);
      }
    }
  };
  walk(parseToml(manifest), "");
  return found;
}

/** Every package a `package.json` depends on, overrides included. */
export function npmDependencies(manifest: string): string[] {
  const json = JSON.parse(manifest) as Record<string, unknown>;
  const names = (value: unknown): string[] =>
    value && typeof value === "object" ? Object.keys(value) : [];
  const pnpm = (json.pnpm ?? {}) as Record<string, unknown>;
  return [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]
    .flatMap((field) => names(json[field]))
    .concat(names(pnpm.overrides));
}

/** The packages a Cargo lockfile resolved. */
export function lockedCrates(lock: string): string[] {
  return [...lock.matchAll(/^name = "([^"]+)"$/gm)].map((match) => match[1]!);
}

const isVendor = (name: string) => /posthog|cloudflared/i.test(name);

describe("product code names no vendor outside its allowlist", () => {
  const found = hits();

  it("holds in every tracked file of what ships", () => {
    expect(found.filter((path) => !allows(path))).toEqual([]);
  });

  it("is not looking at an empty tree", () => {
    // The witness: the scan finds the vendor where it is allowed.
    expect(found).toContain("core/marfa-server/src/telemetry/sinks.rs");
    expect(found).toContain(
      "core/marfa-rules/icons/icon-set-simple-icons.json",
    );
  });

  it("has an allowlist whose every entry exists and still names the vendor", () => {
    const stale = ALLOWED.filter(
      ([entry]) =>
        !found.some((path) =>
          entry.endsWith("/") ? path.startsWith(entry) : path === entry,
        ),
    ).map(([entry]) => entry);
    expect(stale).toEqual([]);
  });

  it("gives every entry a reason", () => {
    for (const [entry, reason] of ALLOWED) {
      expect(reason.length, entry).toBeGreaterThan(10);
    }
  });

  it("allows a generated file by its exact path, never its folder", () => {
    const folders = ALLOWED.filter(([entry]) => entry.endsWith("/")).map(
      ([entry]) => entry,
    );
    expect(folders).toEqual([
      "core/marfa-telemetry/",
      "core/marfa-server/tests/",
      "core/marfa-cli/tests/",
    ]);
  });
});

describe("no product manifest depends on a vendor's SDK", () => {
  const manifests = (name: string) =>
    ["core", "packages"].flatMap((folder) =>
      tracked(`:(glob)${folder}/**/${name}`).filter(
        (path) => !path.includes("node_modules"),
      ),
    );

  it("holds for every Cargo manifest and lockfile in the core and the Swift crate", () => {
    const cargo = manifests("Cargo.toml");
    // The witness: the workspace's manifests are found.
    expect(cargo).toContain("core/Cargo.toml");
    expect(cargo).toContain("core/marfa-server/Cargo.toml");
    const named = cargo.flatMap((path) =>
      cargoDependencies(readFileSync(join(ROOT, path), "utf8"))
        .filter(isVendor)
        .map((name) => `${path}: ${name}`),
    );
    expect(named).toEqual([]);
    const locks = manifests("Cargo.lock");
    expect(locks.length).toBeGreaterThan(0);
    const locked = locks.flatMap((path) =>
      lockedCrates(readFileSync(join(ROOT, path), "utf8"))
        .filter(isVendor)
        .map((name) => `${path}: ${name}`),
    );
    expect(locked).toEqual([]);
  });

  it("holds for every package.json under core/ and packages/", () => {
    const npm = manifests("package.json");
    expect(npm).toContain("packages/client/package.json");
    const named = npm.flatMap((path) =>
      npmDependencies(readFileSync(join(ROOT, path), "utf8"))
        .filter(isVendor)
        .map((name) => `${path}: ${name}`),
    );
    expect(named).toEqual([]);
  });

  it("sees a vendor SDK however a manifest names it", () => {
    const planted = `
[package]
name = "x"
[dependencies]
serde = "1"
posthog-rs = "0.3"
[dev-dependencies]
analytics = { package = "posthog-rs", version = "0.3" }
[target.'cfg(unix)'.build-dependencies]
posthog-core = "1"
[workspace.dependencies]
posthog-rs = "0.3"
`;
    expect(cargoDependencies(planted).filter(isVendor)).toEqual([
      "posthog-rs",
      "posthog-rs",
      "posthog-core",
      "posthog-rs",
    ]);
    expect(
      npmDependencies(
        JSON.stringify({
          devDependencies: { "posthog-node": "1" },
          pnpm: { overrides: { "posthog-js": "1" } },
        }),
      ).filter(isVendor),
    ).toEqual(["posthog-node", "posthog-js"]);
    expect(
      lockedCrates('[[package]]\nname = "posthog-rs"\nversion = "1"\n'),
    ).toEqual(["posthog-rs"]);
    // And it leaves a plain manifest alone.
    expect(
      cargoDependencies('[dependencies]\nserde = "1"\n').filter(isVendor),
    ).toEqual([]);
  });
});
