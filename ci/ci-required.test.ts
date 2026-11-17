/**
 * `scripts/ci-required.ts`, pinned: what each kind of change runs, that each
 * job reads its own answer, and that what a job is known to read reaches it.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import { parse as parseToml } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  affected,
  classify,
  documentationOnly,
  DRAFT_JOBS,
  ESLINT_IGNORED,
  forDraft,
  forNightly,
  NIGHTLY_JOBS,
  JOBS,
  projectsOf,
  RULES,
  SHARDS,
  shardsFor,
  type Job,
} from "../scripts/ci-required.js";

const ROOT = resolve(import.meta.dirname, "..");

function runs(paths: string[]): Job[] {
  const answer = classify(paths);
  return JOBS.filter((job) => answer[job]);
}

/** The lane that needs no server. */
const OFFLINE: Job[] = ["conformance-offline"];
/** The shards that run the server fixtures, and those that run the device and CLI fixtures. */
const SERVER_SHARDS: Job[] = ["rust-contract-server"];
const DEVICE_SHARDS: Job[] = ["rust-contract-device"];
const CONTRACT_SHARDS: Job[] = [...SERVER_SHARDS, ...DEVICE_SHARDS];
/** The fixtures: the offline lane holds the citations, and the shards run them. */
const CONTRACT: Job[] = [...OFFLINE, ...CONTRACT_SHARDS];
/** A workspace package's code reaches the workspace's build and tests, and the offline lane. */
const PACKAGES: Job[] = ["quick-checks", "workspace", ...OFFLINE];
/** The build without test hooks and the fixture that boots it. */
const RELEASE: Job[] = ["rust-contract-release"];
/** Every job that reads the server's crates. */
const RUST_SERVER: Job[] = [
  ...CONTRACT_SHARDS,
  ...RELEASE,
  "mcp-conformance",
  "restore-drill",
];
/** A change in the server's closure reaches every Linux job that builds or boots it. */
const RUST_LINUX: Job[] = ["core-checks-linux", ...OFFLINE, ...RUST_SERVER];
/** A change to the core or the command line reaches the Linux jobs the server does not read. */
const DEVICE_LINUX: Job[] = ["core-checks-linux", ...OFFLINE, ...DEVICE_SHARDS];
/** The two jobs that run on a Mac, which a pull request runs only for what a Mac alone can break. */
const MACOS: Job[] = ["core-checks", "core"];
const RUST: Job[] = [...RUST_LINUX, ...MACOS];
const DEVICE: Job[] = [...DEVICE_LINUX, ...MACOS];
/** The two jobs that read `marfa-enrichment`: its fault-injection tests and its native build. */
const ENRICHMENT: Job[] = ["core-native", "core-fault-injection"];
/** The chapters of the contract a fixture reads while it runs, and the shards the fixture is in. */
const READ_AT_RUN_TIME: Record<string, Job[]> = {
  "errors.md": SERVER_SHARDS,
  "coverage.md": SERVER_SHARDS,
  "device.md": DEVICE_SHARDS,
};

describe("what a change runs", () => {
  it.each<[string, string[], Job[]]>([
    [
      "a README in a subfolder",
      [
        "conformance/README.md",
        "conformance/src/suites/sync/README.md",
        "deploy/README.md",
      ],
      ["quick-checks"],
    ],
    [
      "a README Prettier does not read, which the reference check does",
      ["core/README.md"],
      ["quick-checks"],
    ],
    [
      "the command reference, which a Rust test holds to the binary's command tree",
      ["core/marfa-cli/COMMANDS.md"],
      ["quick-checks", "core-checks-linux"],
    ],
    [
      "the telemetry page, which a Rust test holds to the variables the binary reads",
      ["core/TELEMETRY.md"],
      ["quick-checks", "core-checks-linux"],
    ],
    [
      "a published package's README, which the version check reads",
      ["packages/client/README.md"],
      ["quick-checks", "version-fields"],
    ],
    [
      "top-level documentation, the README's images and the licence",
      ["README.md", "LICENSE", "assets/architecture-light.svg"],
      ["quick-checks"],
    ],
    [
      "the glossary, whose access words a workspace test holds to the CLI's and the server's",
      ["GLOSSARY.md"],
      ["quick-checks", "workspace"],
    ],
    [
      "the server's access words, which the same test reads",
      ["core/marfa-server/src/http/pages/words.rs"],
      ["quick-checks", "workspace", "core-checks-linux", ...RUST_SERVER],
    ],
    [
      "the contract version, which the version check reads",
      ["core/marfa-rules/src/contract.rs"],
      [
        ...RUST_LINUX,
        "quick-checks",
        "core",
        "clients-freshness",
        "workspace",
        "version-fields",
      ],
    ],
    ["the licence alone", ["LICENSE"], ["quick-checks"]],
    [
      "agent instructions, settings and Git hooks, in any language ESLint does not read",
      [
        "AGENTS.md",
        "CLAUDE.md",
        "packages/client/AGENTS.md",
        ".agents/skills/release/SKILL.md",
        ".agents/skills/release/helper.py",
        ".claude/settings.json",
        ".codex/config.toml",
        ".githooks/pre-push",
        ".github/ISSUE_TEMPLATE/bug.yml",
      ],
      ["quick-checks"],
    ],
    [
      "JavaScript or TypeScript in an agent folder, which ESLint reads",
      [".agents/skills/release/helper.ts", ".githooks/check.mjs"],
      ["quick-checks", "workspace", "lint"],
    ],
    [
      "a path named like an agent folder that is not one",
      [".codexrc", "githooks/pre-push"],
      [...JOBS],
    ],
    [
      "what only GitHub reads under .github/",
      [
        ".github/dependabot.yml",
        ".github/SECURITY.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
      ],
      ["quick-checks"],
    ],
    [
      "the action that makes the native build image, which the server group, MCP conformance and the restore drill build their server in",
      [".github/actions/native-build-image/action.yml"],
      ["quick-checks", "core-native", "image", ...RUST_SERVER],
    ],
    [
      "an action a workflow could use",
      [".github/actions/setup/action.yml"],
      [...JOBS],
    ],
    [
      "the core's ignore file, which can hide a generated client file",
      ["core/.gitignore"],
      ["quick-checks", "clients-freshness"],
    ],
    [
      "the settings example, which `ci/env-example.test.ts` reads",
      [".env.example"],
      ["quick-checks", "workspace"],
    ],
    [
      "the contract's specification, which only the offline lane and the reference checks read",
      ["conformance/spec/items.md"],
      ["quick-checks", "workspace", ...OFFLINE],
    ],
    [
      "the error table, which a compliance fixture reads at run time and the Rust server embeds",
      ["conformance/spec/errors.md"],
      [
        "quick-checks",
        "workspace",
        ...OFFLINE,
        "core-checks-linux",
        ...SERVER_SHARDS,
      ],
    ],
    [
      "the coverage table, which a compliance fixture reads at run time",
      ["conformance/spec/coverage.md"],
      ["quick-checks", "workspace", ...OFFLINE, ...SERVER_SHARDS],
    ],
    [
      "a type definition, which the core's catalog is written from and its tests hold to the rules for a registered type",
      ["packages/types/core/note.json"],
      [
        ...PACKAGES,
        "types-freshness",
        "clients-freshness",
        "core-checks-linux",
      ],
    ],
    [
      "an edge type definition and a system type definition, which the same tests read",
      [
        "packages/types/core/edges/about.json",
        "packages/types/core/system/folder.json",
      ],
      [
        ...PACKAGES,
        "types-freshness",
        "clients-freshness",
        "core-checks-linux",
      ],
    ],
    [
      "the types package's source, which the core's tests do not read",
      ["packages/types/src/index.ts"],
      [...PACKAGES, "lint", "types-freshness", "clients-freshness"],
    ],
    [
      "the catalog the core carries",
      ["core/marfa-rules/src/builtin_catalog.json"],
      [...RUST_LINUX, "core", "clients-freshness", "workspace", "quick-checks"],
    ],
    [
      "a client-only change, which no contract job reads",
      ["packages/client/src/client.ts"],
      ["quick-checks", "workspace", "lint", "clients-freshness"],
    ],
    [
      "a Rust-only change",
      ["core/marfa-core/src/store/mod.rs"],
      [...DEVICE_LINUX, "core", "quick-checks"],
    ],
    [
      "the core's folder watching, which FSEvents, name case and Finder packages change",
      ["core/marfa-core/src/folder/scan.rs", "core/marfa-core/src/watch.rs"],
      [...DEVICE, "quick-checks"],
    ],
    [
      "the command line, with its login keychain and launchd autostart",
      ["core/marfa-cli/src/main.rs"],
      [...DEVICE, "quick-checks"],
    ],
    [
      "the core's lockfile, since a dependency bump can break an Apple build",
      ["core/Cargo.lock"],
      [
        ...RUST,
        ...ENRICHMENT,
        "core-deny",
        "image",
        "quick-checks",
        "version-fields",
      ],
    ],
    [
      "the action that installs the compiler, which every job that builds Rust runs",
      [".github/actions/rust-toolchain/action.yml"],
      [...RUST, ...ENRICHMENT, "image", "quick-checks", "version-fields"],
    ],
    [
      "the core's compiler version, since a new compiler can break any build of the core",
      ["core/rust-toolchain.toml"],
      [
        ...RUST,
        ...ENRICHMENT,
        "core-deny",
        "image",
        "quick-checks",
        "version-fields",
      ],
    ],
    [
      "the native readers' scripts, pins and patches, which the native build, the image's programs and the Rust server's build run, and MCP conformance and the restore drill boot the same program",
      [
        "core/marfa-enrichment/native/release.sh",
        "core/marfa-enrichment/native/manifest.txt",
        "core/marfa-enrichment/native/patches/pdfium-steps.patch",
        "core/marfa-enrichment/native/shim.cc",
        "core/marfa-enrichment/native/linux/Dockerfile",
      ],
      ["quick-checks", "core-native", "image", ...RUST_SERVER],
    ],
    [
      "the reader's parsers, which are pure Rust and read the same on a Mac",
      [
        "core/marfa-enrichment/src/ooxml.rs",
        "core/marfa-enrichment/src/lib.rs",
        "core/marfa-enrichment/fixtures/sample.docx",
      ],
      ["quick-checks", ...RUST_LINUX, ...ENRICHMENT],
    ],
    [
      "the reader's isolation, which is Landlock and seccomp on Linux and sandbox_init on a Mac",
      [
        "core/marfa-enrichment/src/isolated/confine.rs",
        "core/marfa-enrichment/src/isolated/footprint.rs",
        "core/marfa-enrichment/src/isolated/parent.rs",
        "core/marfa-enrichment/build.rs",
        "core/marfa-enrichment/Cargo.toml",
        "core/marfa-enrichment/tests/isolation.rs",
      ],
      ["quick-checks", "version-fields", "core-deny", ...RUST, ...ENRICHMENT],
    ],
    [
      "nextest's budget and the runner that caps a test, which the fault-injection tests run under",
      ["core/.config/nextest.toml", "core/scripts/test-limits.sh"],
      [
        "quick-checks",
        "workspace",
        "core-checks",
        "core-checks-linux",
        "core-fault-injection",
        "core",
      ],
    ],
    [
      "a Rust test, which is not in the binary",
      ["core/marfa-cli/tests/folder.rs"],
      ["quick-checks", "core-checks", "core-checks-linux", "core"],
    ],
    [
      "a Swift-only change, which the Linux job does not check",
      ["core/bindings/swift/src/lib.rs"],
      ["quick-checks", "core-checks", "core", "swift-package"],
    ],
    [
      "the dependency policy, which only `cargo deny check` reads",
      ["core/deny.toml"],
      [
        "quick-checks",
        "core-checks-linux",
        "core-deny",
        ...RUST_SERVER,
        ...OFFLINE,
      ],
    ],
    [
      "the Swift crate's lockfile, which pins the uniffi the glue is made with",
      ["core/bindings/swift/Cargo.lock"],
      [
        "quick-checks",
        "core-checks",
        "core",
        "core-deny",
        "swift-package",
        "version-fields",
      ],
    ],
    [
      "the Swift crate's manifest, which declares it",
      ["core/bindings/swift/Cargo.toml"],
      [
        "quick-checks",
        "workspace",
        "core-checks",
        "core",
        "core-deny",
        "swift-package",
        "version-fields",
      ],
    ],
    [
      "the script that builds the Swift package",
      ["core/bindings/swift/build.sh"],
      ["quick-checks", "core-checks", "core", "swift-package"],
    ],
    [
      "the Node module's Rust, a member of the core workspace, which the device fixtures drive a build of",
      ["core/bindings/node/src/lib.rs"],
      [
        "quick-checks",
        "core-checks",
        "core-checks-linux",
        "core",
        ...DEVICE_SHARDS,
      ],
    ],
    [
      "the Node module's manifest, which its build reads",
      ["core/bindings/node/package.json"],
      ["quick-checks", "core", ...DEVICE_SHARDS, "version-fields"],
    ],
    [
      "the Node module's JavaScript",
      ["core/bindings/node/test/pin.test.mjs"],
      ["quick-checks", "core"],
    ],
    [
      "the API document",
      ["openapi.json"],
      [
        "quick-checks",
        "workspace",
        "core-checks-linux",
        ...CONTRACT,
        ...RELEASE,
        "mcp-conformance",
        "restore-drill",
        "image",
        "clients-freshness",
      ],
    ],
    [
      "a CLI scenario",
      ["conformance/src/suites/cli/folder.test.ts"],
      ["quick-checks", "workspace", ...OFFLINE, ...DEVICE_SHARDS],
    ],
    [
      "the CLI harness, which a device fixture imports",
      ["conformance/src/suites/cli/harness.ts"],
      ["quick-checks", "workspace", ...OFFLINE, ...DEVICE_SHARDS],
    ],
    [
      "the device harness shared by CLI scenarios",
      ["conformance/src/suites/device/harness.ts"],
      ["quick-checks", "workspace", ...OFFLINE, ...DEVICE_SHARDS],
    ],
    [
      "the device suites' adapters and scripted server, which a CLI scenario imports",
      [
        "conformance/src/device/cli-adapter.ts",
        "conformance/src/device/scripted-server.ts",
      ],
      ["quick-checks", "workspace", ...OFFLINE, ...DEVICE_SHARDS],
    ],
    [
      "a test beside the helpers, which only the offline lane runs",
      [
        "conformance/src/utils/shard-sequencer.test.ts",
        "conformance/src/utils/nested/helper.test.ts",
      ],
      ["quick-checks", "workspace", ...OFFLINE],
    ],
    [
      "a harness test, which boots servers from the release build",
      ["conformance/src/utils/target-interface.harness.test.ts"],
      ["quick-checks", "workspace", "mcp-conformance"],
    ],
    [
      "the nightly scale benchmark, which only the offline lane tests",
      [
        "conformance/src/utils/scale/report.ts",
        "conformance/scripts/scale/seed.ts",
      ],
      ["quick-checks", "workspace", ...OFFLINE],
    ],
    [
      "a helper no test file is, which every fixture may import",
      ["conformance/src/utils/shard-drift.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "a device fixture",
      ["conformance/src/suites/device/folders.test.ts"],
      ["quick-checks", "workspace", ...OFFLINE, ...DEVICE_SHARDS],
    ],
    [
      "the helpers the folder fixtures share",
      ["conformance/src/suites/device/folders.shared.ts"],
      ["quick-checks", "workspace", ...OFFLINE, ...DEVICE_SHARDS],
    ],
    [
      "the item names and previews the core is held to",
      ["conformance/fixtures/item-display.json"],
      ["quick-checks", "core-checks-linux", ...OFFLINE, ...CONTRACT_SHARDS],
    ],
    [
      "the filter expressions the core's crates and the Node binding share",
      ["conformance/fixtures/filter-expressions.json"],
      ["quick-checks", "core-checks-linux", "core"],
    ],
    [
      "the name fold the core and the contract's title fixture share",
      ["conformance/fixtures/name-fold.json"],
      ["quick-checks", "core-checks-linux", ...SERVER_SHARDS],
    ],
    [
      "a compliance fixture",
      ["conformance/src/suites/compliance/owner.test.ts"],
      ["quick-checks", "workspace", ...OFFLINE, ...SERVER_SHARDS],
    ],
    [
      "a correctness fixture",
      ["conformance/src/suites/correctness/items.test.ts"],
      ["quick-checks", "workspace", ...OFFLINE, ...SERVER_SHARDS],
    ],
    [
      "a sync fixture",
      ["conformance/src/suites/sync/streams.test.ts"],
      ["quick-checks", "workspace", ...OFFLINE, ...SERVER_SHARDS],
    ],
    [
      "a suite off the gate",
      [
        "conformance/src/suites/load/seed.ts",
        "conformance/src/suites/performance/items.test.ts",
        "conformance/src/suites/hydration/hydration.test.ts",
      ],
      ["quick-checks", "workspace", ...OFFLINE],
    ],
    [
      "a suite folder no rule names",
      ["conformance/src/suites/new/items.test.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "fixtures of several projects, which reach the same jobs as one",
      [
        "conformance/src/suites/compliance/owner.test.ts",
        "conformance/src/suites/device/folders.test.ts",
        "conformance/src/suites/sync/streams.test.ts",
      ],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "what every fixture uses",
      ["conformance/src/utils/setup.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "the sequencer and the weights that split a project over its shards",
      [
        "conformance/src/utils/shard-sequencer.ts",
        "conformance/src/utils/shard-weights.ts",
      ],
      [
        "quick-checks",
        "workspace",
        "lint",
        ...CONTRACT,
        ...RELEASE,
        "mcp-conformance",
      ],
    ],
    [
      "the configuration that decides which file lands in which project",
      ["conformance/vitest.config.ts"],
      [
        "quick-checks",
        "workspace",
        "lint",
        ...CONTRACT,
        ...RELEASE,
        "restore-drill",
        "mcp-conformance",
      ],
    ],
    [
      "the restore drill",
      ["conformance/scripts/restore-drill.ts"],
      ["quick-checks", "workspace", "restore-drill"],
    ],
    [
      "the script that runs the MCP conformance tool",
      ["conformance/scripts/mcp-conformance.ts"],
      ["quick-checks", "workspace", "lint", "mcp-conformance"],
    ],
    [
      "the image, which the test hooks' test also reads",
      ["deploy/Dockerfile"],
      ["quick-checks", "workspace", "image"],
    ],
    [
      "the script that builds the release's programs, which the image is made from",
      ["scripts/release/build-programs.sh"],
      ["quick-checks", "workspace", "image"],
    ],
    [
      "the native readers' scripts, which the image's programs and the Rust server are built with",
      ["core/marfa-enrichment/native/lib.sh"],
      ["quick-checks", "core-native", "image", ...RUST_SERVER],
    ],
    [
      "the server's list of unpublished routes, which an offline conformance test reads",
      ["core/marfa-server/src/http/document.rs"],
      [
        "quick-checks",
        "core-checks-linux",
        "conformance-offline",
        ...RUST_SERVER,
      ],
    ],
    [
      "the settings, whose names the Dockerfile sets",
      ["core/marfa-server/src/settings/start.rs"],
      ["quick-checks", "core-checks-linux", ...RUST_SERVER, "image"],
    ],
    [
      "the script that boots the image",
      ["scripts/check-image.sh"],
      ["quick-checks", "workspace", "image"],
    ],
    [
      "JavaScript that ESLint reads",
      ["deploy/healthcheck.js"],
      ["quick-checks", "workspace", "lint"],
    ],
    [
      "Markdown in a generated tree, which its freshness check refuses",
      ["packages/types/generated/NOTES.md"],
      [...PACKAGES, "types-freshness", "clients-freshness"],
    ],
    ["the attributes checkout applies", [".gitattributes"], [...JOBS]],
    [
      "a crate the binary could come to be built from",
      ["core/marfa-wire/src/lib.rs"],
      [...RUST_LINUX, "quick-checks"],
    ],
    [
      "a dependency",
      ["pnpm-lock.yaml"],
      [
        "quick-checks",
        "workspace",
        "lint",
        ...CONTRACT,
        ...RELEASE,
        "mcp-conformance",
        "restore-drill",
        "types-freshness",
        "version-fields",
        "clients-freshness",
      ],
    ],
    [
      "a crate manifest, which this test reads",
      ["core/marfa-core/Cargo.toml"],
      ["quick-checks", ...RUST, "core-deny", "version-fields"],
    ],
    [
      "ci.yml, which defines every job it runs, the call of core-live.yml among them",
      [".github/workflows/ci.yml"],
      [...JOBS],
    ],
    [
      "core-live.yml, which the ci/ tests read and ci.yml calls",
      [".github/workflows/core-live.yml"],
      ["quick-checks", "workspace", "core"],
    ],
    [
      "core.yml, which the ci/ tests read and no pull request runs",
      [".github/workflows/core.yml"],
      ["quick-checks", "workspace"],
    ],
    [
      "another workflow",
      [".github/workflows/release.yml"],
      ["quick-checks", "workspace"],
    ],
    ["the classifier itself", ["scripts/ci-required.ts"], [...JOBS]],
    [
      "a test of CI",
      ["ci/ci-required.test.ts"],
      ["quick-checks", "workspace", "lint"],
    ],
    [
      "a test of the API document",
      ["ci/openapi/style.test.ts"],
      ["quick-checks", "workspace", "lint"],
    ],
    [
      "Markdown a test reads as a fixture",
      ["packages/types/src/fixtures/note.md"],
      [...PACKAGES, "types-freshness", "clients-freshness"],
    ],
    ["a path no rule names", ["tools/new.ts"], [...JOBS]],
    [
      "documentation beside a package change",
      ["README.md", "conformance/spec/blobs.md", "packages/types/src/x.ts"],
      [...PACKAGES, "lint", "types-freshness", "clients-freshness"],
    ],
    [
      "Rust beside a client change",
      ["core/marfa-cli/src/main.rs", "packages/client/src/client.ts"],
      [
        "quick-checks",
        "workspace",
        "lint",
        "core-checks",
        "core-checks-linux",
        ...OFFLINE,
        "clients-freshness",
        "core",
        ...DEVICE_SHARDS,
      ],
    ],
    [
      "the Rust server alone",
      ["core/marfa-server/src/lib.rs", "core/marfa-server/tests/config.rs"],
      ["quick-checks", "core-checks-linux", ...RUST_SERVER],
    ],
    [
      "a test of the Rust server, which is not in the binary the shards boot",
      ["core/marfa-server/tests/config.rs"],
      ["quick-checks", "core-checks-linux"],
    ],
    [
      "the Rust server's start, which routes memory to jemalloc on a Mac",
      ["core/marfa-server/src/main.rs"],
      ["quick-checks", "core-checks", "core-checks-linux", ...RUST_SERVER],
    ],
    [
      "the Rust server's manifest",
      ["core/marfa-server/Cargo.toml"],
      [
        "quick-checks",
        "core-checks-linux",
        "core-deny",
        ...RUST_SERVER,
        "version-fields",
      ],
    ],
    [
      "an icon set the rules crate embeds",
      ["packages/types/generated/icon-set-lucide.json"],
      [...PACKAGES, "lint", "types-freshness", "clients-freshness", ...RUST],
    ],
    [
      "the score script",
      ["conformance/scripts/rust-score.ts"],
      [
        "quick-checks",
        "workspace",
        "conformance-offline",
        ...CONTRACT_SHARDS,
        ...RELEASE,
      ],
    ],
    [
      "an empty change, which cannot be told apart from an unread one",
      [],
      [...JOBS],
    ],
  ])("%s", (_, paths, expected) => {
    expect(runs(paths)).toEqual(JOBS.filter((job) => expected.includes(job)));
  });

  it("leaves the Rust contract jobs out of a change to a package but for the files the Rust server embeds", () => {
    const embedded = tracked().filter((path) =>
      /^packages\/types\/generated\/icon-set-[\w-]+\.json$/.test(path),
    );
    // The witness: there are icon sets, and a change to one reaches the jobs.
    expect(embedded.length).toBeGreaterThan(0);
    for (const path of embedded) {
      expect(runs([path]), path).toEqual(
        expect.arrayContaining(CONTRACT_SHARDS),
      );
    }
    const packages = tracked().filter(
      (path) => path.startsWith("packages/") && !embedded.includes(path),
    );
    expect(packages.length).toBeGreaterThan(0);
    for (const path of packages) {
      for (const shard of CONTRACT_SHARDS) {
        expect(runs([path]), path).not.toContain(shard);
      }
    }
  });

  it("reaches the Rust contract jobs from every file outside core/ that the Rust crates embed", () => {
    // `include_str!` and `include_bytes!` read a file at build time, so a
    // change to it changes the program the jobs judge.
    const outside = embeddedOutsideCore(
      (path) => !/^core\/(marfa-cli|bindings)\//.test(path),
    );
    // The witness: the scan finds the files, so an empty list is not blindness.
    expect(outside).toContain("openapi.json");
    for (const target of outside) {
      expect(runs([target]), target).toEqual(
        expect.arrayContaining(CONTRACT_SHARDS),
      );
    }
  });

  it("reads the contract's chapters from the server's test code only, so they stay out of the program the shards boot", () => {
    const readers = tracked().filter(
      (path) => path.startsWith("core/marfa-server/") && path.endsWith(".rs"),
    );
    const inTests: string[] = [];
    const inProgram: string[] = [];
    for (const path of readers) {
      const whole = readFileSync(join(ROOT, path), "utf8");
      const cut = whole.indexOf("#[cfg(test)]\nmod ");
      const program = cut === -1 ? whole : whole.slice(0, cut);
      const tests = cut === -1 ? "" : whole.slice(cut);
      const chapter = /include_str!\(\s*"[^"]*conformance\/spec\//;
      if (chapter.test(program)) inProgram.push(path);
      if (chapter.test(tests)) inTests.push(path);
    }
    // The witness: the scan finds the test code that reads a chapter.
    expect(inTests).toContain("core/marfa-server/src/app/refusal.rs");
    expect(inProgram).toEqual([]);
  });

  it("names every tracked path in a rule, so only a new one runs everything", () => {
    const unnamed = (path: string) =>
      !RULES.some(([pattern]) => pattern.test(path));
    // The witness: a path no rule names reaches every job.
    expect(unnamed("tools/new.ts")).toBe(true);
    expect([...affected("tools/new.ts")].sort()).toEqual([...JOBS].sort());
    expect(tracked().filter(unnamed)).toEqual([]);
  });

  it("treats Markdown as documentation but the contract, package READMEs, the command reference and the telemetry page", () => {
    const beyond = (path: string) =>
      [...affected(path)].filter((job) => job !== "quick-checks");
    // The rule fixtures and generated trees fall through on purpose.
    const docs = RULES.find(([pattern]) => pattern.test("README.md"))?.[0];
    expect(docs?.test("packages/types/src/fixtures/note.md")).toBe(false);
    // The witnesses: the contract and a package's README reach a job.
    expect(beyond("conformance/spec/items.md")).toEqual([
      "workspace",
      "conformance-offline",
    ]);
    expect(beyond("packages/client/README.md")).toEqual(["version-fields"]);
    const markdown = tracked().filter((path) => path.endsWith(".md"));
    expect(markdown.length).toBeGreaterThan(0);
    for (const path of markdown) {
      if (path.startsWith("conformance/spec/")) {
        const chapter = path.slice("conformance/spec/".length);
        expect([...beyond(path)].sort(), path).toEqual(
          [
            "workspace",
            "conformance-offline",
            ...(chapter === "errors.md" ||
            chapter === "instance.md" ||
            chapter === "housekeeping.md"
              ? ["core-checks-linux"]
              : []),
            ...(READ_AT_RUN_TIME[chapter] ?? []),
          ].sort(),
        );
      } else if (
        path === "core/marfa-cli/COMMANDS.md" ||
        path === "core/TELEMETRY.md"
      ) {
        expect(beyond(path), path).toEqual(["core-checks-linux"]);
      } else if (path === "GLOSSARY.md") {
        expect(beyond(path), path).toEqual(["workspace"]);
      } else if (docs?.test(path)) {
        expect(beyond(path), path).toEqual(
          /^(packages|core)\/.+\/README[^/]*$/.test(path)
            ? ["version-fields"]
            : [],
        );
      }
    }
  });

  it("calls an answer documentation only when nothing but the format check runs", () => {
    for (const paths of [
      ["AGENTS.md"],
      ["LICENSE"],
      ["README.md", ".agents/skills/release/helper.py", ".githooks/pre-push"],
    ]) {
      expect(documentationOnly(classify(paths)), paths.join(", ")).toBe(true);
    }
    for (const paths of [
      [],
      ["AGENTS.md", "packages/types/src/runtime.ts"],
      ["packages/client/README.md"],
      ["core/marfa-cli/COMMANDS.md"],
      ["core/TELEMETRY.md"],
      ["conformance/spec/items.md"],
      [".env.example"],
      [".github/workflows/release.yml"],
      ["scripts/ci-required.ts"],
      ["tools/new.ts"],
    ]) {
      expect(documentationOnly(classify(paths)), paths.join(", ")).toBe(false);
    }
  });

  it("holds Markdown in every generated tree to its freshness check", () => {
    const trees = readFileSync(join(ROOT, ".gitattributes"), "utf8")
      .split("\n")
      .map((line) => /^\/?(\S+)\/\*\* linguist-generated=true$/.exec(line)?.[1])
      .filter((tree) => tree !== undefined);
    expect(trees.length).toBeGreaterThan(0);
    for (const tree of trees) {
      const jobs = [...affected(`${tree}/NOTES.md`)];
      expect(
        jobs.some((job) => job.endsWith("-freshness")),
        `${tree}: ${jobs.join(", ")}`,
      ).toBe(true);
    }
  });
});

describe("the core's Apple-only code", () => {
  it("runs the macOS jobs for every file with an Apple-only cfg", () => {
    const found = execFileSync(
      "grep",
      [
        "-rlE",
        'target_os = "(macos|ios)"|target_vendor = "apple"',
        "core",
        "--exclude-dir=target",
        "--exclude-dir=node_modules",
      ],
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(found.length).toBeGreaterThan(0);
    for (const path of found) {
      expect([...affected(path)], path).toContain("core-checks");
    }
  });
});

/** Every tracked path. */
function tracked(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** The harness tests `MCP conformance` runs with `pnpm test:harness`. */
function harnessTests(): string[] {
  return tracked().filter((path) =>
    /^conformance\/src\/utils\/[^/]*\.harness\.test\.ts$/.test(path),
  );
}

/** Every file a TypeScript entry point reaches through relative imports. */
function closure(entries: string[]): string[] {
  const seen = new Set<string>();
  const stack = entries.map((entry) => resolve(ROOT, entry));
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      const spec = resolve(dirname(file), match[1] ?? "");
      const found = [
        spec,
        spec.replace(/\.js$/, ".ts"),
        spec.replace(/\.js$/, ".tsx"),
        `${spec}.ts`,
      ].find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      );
      expect(
        found,
        `${relative(ROOT, file)} imports ${match[1] ?? ""}`,
      ).toBeDefined();
      if (found !== undefined) stack.push(found);
    }
  }
  return [...seen].map((file) => relative(ROOT, file)).sort();
}

function walk(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap(
    (entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : [join(dir, entry.name)],
  );
}

/** Whether an `@actions/glob` pattern, as `hashFiles` reads it, matches a path. */
function globMatches(glob: string, path: string): boolean {
  const pattern = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${pattern}$`).test(path);
}

/**
 * The files outside `core/` that the program code of the scanned Rust files
 * embeds at build time. A test module, which sits at the end of its file, and
 * the tests of a crate are not the program.
 */
function embeddedOutsideCore(scan: (path: string) => boolean): string[] {
  const outside: string[] = [];
  for (const path of tracked().filter(
    (file) => file.startsWith("core/") && file.endsWith(".rs") && scan(file),
  )) {
    if (
      /(^|\/)(tests|benches)\//.test(path) ||
      /(^|\/|_)tests\.rs$/.test(path)
    ) {
      continue;
    }
    const whole = readFileSync(join(ROOT, path), "utf8");
    const cut = whole.indexOf("#[cfg(test)]\nmod ");
    const text = cut === -1 ? whole : whole.slice(0, cut);
    for (const match of text.matchAll(
      /include_(?:str|bytes)!\(\s*"([^"]+)"/g,
    )) {
      const target = relative(
        ROOT,
        resolve(ROOT, dirname(path), match[1] ?? ""),
      );
      if (!target.startsWith("core/")) outside.push(target);
    }
  }
  return outside;
}

type Dependencies = Record<string, { path?: string; workspace?: boolean }>;
interface Manifest {
  dependencies?: Dependencies;
  "build-dependencies"?: Dependencies;
  target?: Record<
    string,
    { dependencies?: Dependencies; "build-dependencies"?: Dependencies }
  >;
}

/** Every dependency table of a manifest: the plain, build and per-target ones. */
function dependencyTables(manifest: Manifest): Dependencies[] {
  return [
    manifest.dependencies ?? {},
    manifest["build-dependencies"] ?? {},
    ...Object.values(manifest.target ?? {}).flatMap((target) => [
      target.dependencies ?? {},
      target["build-dependencies"] ?? {},
    ]),
  ];
}

/** The crates a crate is built from: itself and the path dependencies of each, from the manifests. */
function crateClosure(root: string): string[] {
  const manifest = (crate: string) =>
    parseToml(
      readFileSync(join(ROOT, "core", crate, "Cargo.toml"), "utf8"),
    ) as Manifest;
  const workspace = (
    parseToml(readFileSync(join(ROOT, "core", "Cargo.toml"), "utf8")) as {
      workspace: { dependencies: Record<string, { path?: string }> };
    }
  ).workspace.dependencies;
  const crates = new Set<string>();
  const pending = [root];
  for (let crate = pending.pop(); crate !== undefined; crate = pending.pop()) {
    if (crates.has(crate)) continue;
    crates.add(crate);
    for (const [name, dep] of dependencyTables(manifest(crate)).flatMap(
      (table) => Object.entries(table),
    )) {
      // A workspace dependency's path is the workspace root's, not the crate's.
      const path =
        dep.workspace === true
          ? workspace[name]?.path
          : dep.path && join(crate, dep.path);
      if (path) {
        pending.push(relative(join(ROOT, "core"), resolve(ROOT, "core", path)));
      }
    }
  }
  return [...crates].sort();
}

/** The globs of a step's `hashFiles(...)`, with `!` kept on the ones that exclude. */
function hashedGlobs(step: { run?: string } | undefined): string[] {
  return [...(step?.run ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
}

/** Whether `hashFiles` over these globs reads the path. */
function hashes(globs: string[], path: string): boolean {
  const excluded = globs
    .filter((g) => g.startsWith("!"))
    .map((g) => g.slice(1));
  return (
    globs.some((g) => !g.startsWith("!") && globMatches(g, path)) &&
    !excluded.some((g) => globMatches(g, path))
  );
}

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  "working-directory"?: string;
}

interface Workflow {
  on: Record<string, { paths?: string[] } | null>;
  jobs: Record<
    string,
    {
      needs?: string | string[];
      if?: string;
      strategy?: { matrix?: { include?: string }; "fail-fast"?: boolean };
      name?: string;
      "timeout-minutes"?: number;
      "runs-on"?: string;
      permissions?: Record<string, string>;
      outputs?: Record<string, string>;
      env?: Record<string, string>;
      uses?: string;
      steps?: Step[];
    }
  >;
}

function workflow(file: string): Workflow {
  return parse(
    readFileSync(join(ROOT, ".github", "workflows", file), "utf8"),
  ) as Workflow;
}

const gate = (output: string) =>
  `\${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.${output} != 'false') }}`;

/**
 * The call of `core-live.yml` runs for a pull request alone: `core.yml` runs
 * it for a push to `main`, the nightly and a dispatch.
 */
const coreGate =
  "${{ !cancelled() && github.event_name == 'pull_request' && (needs.changes.result != 'success' || needs.changes.outputs.core != 'false') }}";

describe("the contract's chapters", () => {
  it("read every chapter a server fixture reads while it runs", () => {
    // The witness for the spec rule: a fixture that reads a chapter at run
    // time is red or green by what the chapter says. A new reader of the
    // contract among the server suites is named here and its chapter in
    // `READ_AT_RUN_TIME`, so that a change to the chapter runs the fixture.
    const reads = ["compliance", "correctness", "sync", "device"]
      .flatMap((suite) => walk(`conformance/src/suites/${suite}`))
      .filter(
        (file) =>
          file.endsWith(".test.ts") && !file.endsWith(".decision.test.ts"),
      )
      .filter((file) =>
        /spec-statements|spec-references|errors-table|coverage-table|schema-coverage|SPEC_DIR|\.\.\/spec/.test(
          readFileSync(join(ROOT, file), "utf8"),
        ),
      )
      .sort();
    expect(reads).toEqual([
      "conformance/src/suites/compliance/error-codes.test.ts",
      "conformance/src/suites/compliance/instance.test.ts",
      "conformance/src/suites/device/error-codes.test.ts",
    ]);
    for (const [chapter, shards] of Object.entries(READ_AT_RUN_TIME)) {
      expect([...affected(`conformance/spec/${chapter}`)], chapter).toEqual(
        expect.arrayContaining(shards),
      );
    }
  });
});

describe("what a draft runs", () => {
  it("runs the quick jobs the diff names, and nothing else", () => {
    expect(DRAFT_JOBS).toEqual([
      "quick-checks",
      "workspace",
      "lint",
      "types-freshness",
      "version-fields",
    ]);
    // A change only the core's tests read names no quick job but `Quick
    // checks`, which every change names; `Draft CI` keeps the draft from
    // merging.
    expect(runs(["core/marfa-core/tests/sync.rs"])).toEqual([
      "quick-checks",
      "core-checks",
      "core-checks-linux",
      "core",
    ]);
    expect(
      JOBS.filter(
        (job) => forDraft(classify(["core/marfa-core/tests/sync.rs"]))[job],
      ),
    ).toEqual(["quick-checks"]);
    const client = forDraft(classify(["packages/client/src/runtime.ts"]));
    expect(JOBS.filter((job) => client[job])).toEqual([
      "quick-checks",
      "workspace",
      "lint",
    ]);
    const types = forDraft(classify(["packages/types/src/runtime.ts"]));
    expect(JOBS.filter((job) => types[job])).toEqual([
      "quick-checks",
      "workspace",
      "lint",
      "types-freshness",
    ]);
    const swift = forDraft(classify(["core/bindings/swift/build.sh"]));
    expect(JOBS.filter((job) => swift[job])).toEqual(["quick-checks"]);
    const all = forDraft(classify([]));
    expect(JOBS.filter((job) => all[job])).toEqual([...DRAFT_JOBS]);
  });
});

/**
 * The jobs of `ci.yml` that are not one job of the classifier's:
 * `Conformance` collects the offline lane and MCP conformance into one
 * verdict, the workspace's tests are one job that reads the answers for
 * `workspace` and `full`, `Full CI` collects every job for the ruleset and
 * `report-failure` reports a failed night.
 * `ci/workspace-tests.test.ts`, `ci/full-ci-gate.test.ts` and
 * `ci/nightly-report.test.ts` pin the last three.
 */
const CONFORMANCE_GATE = "conformance";
const QUICK_JOBS = ["typecheck"];
const STOP_JOBS = [
  "stop-after-format",
  "stop-after-typecheck",
  "stop-after-lint",
];
const NOT_CLASSIFIED = [
  CONFORMANCE_GATE,
  "workspace-tests",
  "gate",
  "report-failure",
  // The jobs after each Rust server build wait for it, and
  // `ci/rust-contract.test.ts` pins them.
  "rust-contract-release-check",
  "rust-contract-shards",
  "rust-contract-score",
  "rust-contract-macos-shards",
  "rust-contract-macos-score",
  ...QUICK_JOBS,
  ...STOP_JOBS,
];

/** The jobs that boot the Rust server's release build wait for it to pass. */
const afterBuild = (output: string) =>
  `\${{ !cancelled() && needs.rust-contract.result == 'success' && (needs.changes.result != 'success' || needs.changes.outputs.${output} != 'false') }}`;

/** The build runs for any job that boots it. */
const buildGate =
  "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.rust-contract-server != 'false' || needs.changes.outputs.rust-contract-device != 'false' || needs.changes.outputs.mcp-conformance != 'false' || needs.changes.outputs.restore-drill != 'false') }}";

/** The macOS run of the device and CLI fixtures is for the nightly and a dispatch that asks. */
const macGate =
  "${{ !cancelled() && (github.event_name == 'schedule' || inputs.macos) && (needs.changes.result != 'success' || needs.changes.outputs.rust-contract-macos != 'false') }}";

describe("each job reads its own answer", () => {
  it("ci.yml runs a job only when the classifier says so, and every one when it cannot tell", () => {
    const { jobs } = workflow("ci.yml");
    const gated = Object.keys(jobs).filter(
      (name) => name !== "changes" && !NOT_CLASSIFIED.includes(name),
    );
    // The shards of the two groups share one build, so one job stands for both.
    expect(gated.sort()).toEqual(
      [
        ...JOBS.filter(
          (job) =>
            job !== "workspace" &&
            job !== "swift-package" &&
            !CONTRACT_SHARDS.includes(job),
        ),
        "rust-contract",
      ].sort(),
    );
    expect(jobs.changes?.outputs).toEqual(
      Object.fromEntries(
        [...JOBS, "full", "rust-shards", "rust-projects"].map((job) => [
          job,
          `\${{ steps.classify.outputs.${job} }}`,
        ]),
      ),
    );
    const booted = ["mcp-conformance", "restore-drill"];
    for (const name of gated) {
      expect(jobs[name]?.needs, name).toEqual(
        booted.includes(name) ? ["changes", "rust-contract"] : "changes",
      );
      expect(jobs[name]?.if, name).toBe(
        booted.includes(name)
          ? afterBuild(name)
          : name === "rust-contract"
            ? buildGate
            : name === "rust-contract-macos"
              ? macGate
              : name === "core"
                ? coreGate
                : gate(name),
      );
    }
    // A push asks whether this workflow passed on the commit before it.
    expect(jobs.changes?.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(
      jobs.changes?.steps?.find((step) => step.id === "classify")?.env,
    ).toEqual({ GH_TOKEN: "${{ github.token }}" });
  });

  it("Quick checks checks formatting, these rules and the contract's references for any change and the rest only for the workspace", () => {
    const steps = workflow("ci.yml").jobs["quick-checks"]?.steps ?? [];
    const format = steps.findIndex((step) => step.run === "pnpm format:check");
    expect(format).toBeGreaterThan(0);
    expect(steps[format]?.if).toBeUndefined();
    expect(steps[format + 1]).toEqual({
      run: "pnpm vitest run ci/ci-required.test.ts",
    });
    expect(steps[format + 2]).toEqual({
      "working-directory": "conformance",
      run: "pnpm exec vitest run --project generators src/utils/spec-citations.test.ts",
    });
    // The build, typecheck and lint are jobs of their own, so that each one
    // reports as soon as it can: see the next test.
    expect(steps.slice(format + 3)).toEqual([]);
    // The tests wait until the pull request is ready: they are the job
    // `Workspace tests`, which `ci/workspace-tests.test.ts` pins.
    // A draft passes here with the rest skipped; `Draft CI` keeps it from
    // merging, so no step of any job fails a draft for being one.
    const draftSteps = (all: Workflow["jobs"]) =>
      Object.entries(all).flatMap(([id, job]) =>
        (job.steps ?? [])
          .filter((step) => step.if?.includes("pull_request.draft") === true)
          .map(() => id),
      );
    expect(draftSteps(workflow("ci.yml").jobs)).toEqual([]);
    // The witness: the same check finds a step that fails a draft.
    expect(
      draftSteps({
        "quick-checks": {
          steps: [
            { if: "${{ github.event.pull_request.draft }}", run: "exit 1" },
          ],
        },
      }),
    ).toEqual(["quick-checks"]);
    // Nothing before the gated steps needs Rust, and nothing after does now
    // that the version check, the one test that runs cargo, is left out.
    expect(steps.some((step) => step.uses?.includes("rust"))).toBe(false);
  });

  it("Typecheck is a job of its own, for the workspace, and Lint one for what ESLint reads, so that a failure of either is known in minutes", () => {
    const { jobs } = workflow("ci.yml");
    // Only Typecheck builds: it is the one job before the release that shows
    // the published client still builds, and nothing reads the build.
    for (const [name, output, commands] of [
      ["typecheck", "workspace", ["pnpm build", "pnpm typecheck"]],
      ["lint", "lint", ["pnpm lint"]],
    ] as const) {
      const job = jobs[name];
      expect(job?.needs, name).toBe("changes");
      expect(job?.if, name).toBe(gate(output));
      expect(
        (job?.steps ?? []).map(
          (step) => step.run ?? step.uses?.replace(/@[0-9a-f]{40}$/, ""),
        ),
        name,
      ).toEqual([
        "actions/checkout",
        "pnpm/action-setup",
        "actions/setup-node",
        "pnpm install --frozen-lockfile",
        ...commands,
      ]);
    }
  });

  it("Core checks builds the Swift package with build.sh, as marfa-swift does, only when the classifier says so", () => {
    const { jobs } = workflow("ci.yml");
    const steps = jobs["core-checks"]?.steps ?? [];
    const build = steps.find((step) => step.run === "./build.sh");
    expect(build?.name).toBe("Build the Swift package");
    expect(build?.["working-directory"]).toBe("core/bindings/swift");
    expect(build?.if).toBe(
      "${{ needs.changes.outputs.swift-package != 'false' }}",
    );
    // The Apple targets and the Xcode are the ones `core-live.yml` builds with.
    expect(
      steps.some((step) => step.uses === "./.github/actions/rust-toolchain"),
    ).toBe(true);
    const toolchainFile = readFileSync(
      join(ROOT, "core", "rust-toolchain.toml"),
      "utf8",
    );
    for (const target of [
      "aarch64-apple-darwin",
      "aarch64-apple-ios",
      "aarch64-apple-ios-sim",
    ]) {
      expect(toolchainFile).toContain(`"${target}"`);
    }
    expect(build?.env?.DEVELOPER_DIR).toBe(
      workflow("core-live.yml").jobs.live?.env?.DEVELOPER_DIR,
    );
  });

  it("core.yml runs on a push to main for the core and the Rust server it boots, never for Markdown", () => {
    expect(workflow("core.yml").on.push?.paths).toEqual([
      "core/**",
      "openapi.json",
      "package.json",
      ".github/workflows/core.yml",
      ".github/workflows/core-live.yml",
      "!**/*.md",
    ]);
  });
});

/**
 * Whether a workflow's `paths` filter pattern matches a path, as Actions reads
 * it: `**` crosses folders, and `**` followed by a slash matches none too.
 */
function filterMatches(pattern: string, path: string): boolean {
  const source = pattern
    .split("**/")
    .map((part) =>
      part
        .split("**")
        .map((piece) =>
          piece
            .split("*")
            .map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*"),
        )
        .join(".*"),
    )
    .join("(?:.*/)?");
  return new RegExp(`^${source}$`).test(path);
}

describe("CodeQL", () => {
  const { on, jobs } = workflow("codeql.yml") as unknown as {
    on: {
      push?: { branches?: string[]; "paths-ignore"?: string[] };
      pull_request?: {
        branches?: string[];
        types?: string[];
        "paths-ignore"?: string[];
      };
      schedule?: { cron: string }[];
    };
    jobs: Record<string, { if?: string }>;
  };
  const ignored = on.pull_request?.["paths-ignore"] ?? [];
  const skips = (path: string) =>
    ignored.some((pattern) => filterMatches(pattern, path));

  it("analyzes once a week, and a push to main or a pull request unless it changes only documentation, agent instructions, the README's images or the deploy folder", () => {
    const documentation = [
      "**/*.md",
      "LICENSE",
      ".claude/**",
      ".codex/**",
      ".github/ISSUE_TEMPLATE/**",
      "assets/**",
      "deploy/**",
    ];
    expect(on.push).toEqual({
      branches: ["main"],
      "paths-ignore": documentation,
    });
    expect(on.pull_request).toEqual({
      branches: ["main"],
      types: ["opened", "synchronize", "reopened", "ready_for_review"],
      "paths-ignore": documentation,
    });
    expect(on.schedule).toHaveLength(1);
    expect(on.schedule?.[0]?.cron).toMatch(/^\d{1,2} \d{1,2} \* \* [0-6]$/);
  });

  it("analyzes a draft only once it is marked ready for review", () => {
    expect(jobs.analyze?.if).toBe("${{ !github.event.pull_request.draft }}");
  });

  it("skips the README's images and the deploy folder, which hold nothing it analyzes", () => {
    // A JavaScript, TypeScript or Rust file added to either folder fails the
    // test below that no skipped file is in a language it analyzes.
    const files = tracked().filter(
      (path) => path.startsWith("assets/") || path.startsWith("deploy/"),
    );
    // The witness: both folders hold tracked files, so the filter has
    // something to skip.
    expect(files).toContain("deploy/Dockerfile");
    expect(files.some((path) => path.startsWith("assets/"))).toBe(true);
    for (const path of files) {
      expect(skips(path), path).toBe(true);
    }
  });

  it("skips what the classifier also reads as documentation, and no code in a language it analyzes", () => {
    for (const path of [
      "README.md",
      "LICENSE",
      ".agents/skills/release/SKILL.md",
      ".claude/settings.json",
      ".codex/config.toml",
      ".github/ISSUE_TEMPLATE/bug.yml",
    ]) {
      expect(skips(path), path).toBe(true);
      expect(
        [...affected(path)].filter((job) => job !== "quick-checks"),
      ).toEqual([]);
    }
    expect(skips("conformance/spec/items.md")).toBe(true);
    // No tracked file it skips is in a language it analyzes.
    expect(
      tracked().filter(
        (path) => skips(path) && /\.([cm]?[jt]sx?|rs)$/.test(path),
      ),
    ).toEqual([]);
    for (const path of [
      ".github/workflows/ci.yml",
      ".agents/skills/release/helper.ts",
      ".githooks/check.mjs",
      "packages/types/src/runtime.ts",
      "core/marfa-core/src/lib.rs",
      "core/Cargo.toml",
      "openapi.json",
    ]) {
      expect(skips(path), path).toBe(false);
    }
  });
});

describe("what a job reads reaches it", () => {
  it("every file the CLI fixtures load runs the device shards", async () => {
    const { default: config } =
      (await import("../conformance/vitest.config.js")) as {
        default: {
          test: {
            projects: { test: { name: string; globalSetup?: string[] } }[];
          };
        };
      };
    const cli = config.test.projects.find((p) => p.test.name === "cli");
    expect(cli?.test.globalSetup?.length).toBeGreaterThan(0);
    const files = closure([
      ...walk("conformance/src/suites/cli").filter((f) => f.endsWith(".ts")),
      ...(cli?.test.globalSetup ?? []).map((f) => join("conformance", f)),
      "conformance/vitest.config.ts",
      "conformance/scripts/marfa-server.ts",
    ]);
    expect(files).toContain("conformance/src/utils/setup.ts");
    expect(
      files.filter((f) => !DEVICE_SHARDS.every((job) => affected(f).has(job))),
    ).toEqual([]);
  });

  it("every file the restore drill loads runs it", () => {
    const files = closure([
      "conformance/scripts/restore-drill.ts",
      "conformance/scripts/garage.ts",
      "conformance/scripts/marfa-server.ts",
    ]);
    expect(files).toContain("conformance/src/utils/drill.ts");
    expect(files.filter((f) => !affected(f).has("restore-drill"))).toEqual([]);
  });

  it("the MCP conformance job runs the harness project, and the offline lane leaves it out", () => {
    const steps = workflow("ci.yml").jobs["mcp-conformance"]?.steps ?? [];
    expect(steps.map((step) => step.run)).toContain("pnpm test:harness");
    const config = readFileSync(
      join(ROOT, "conformance", "vitest.config.ts"),
      "utf8",
    );
    expect(config).toContain('include: ["src/utils/**/*.harness.test.ts"]');
    expect(config).toContain('exclude("src/utils/**/*.harness.test.ts")');
  });

  it("every file the MCP conformance job loads runs it", () => {
    const files = closure([
      "conformance/scripts/mcp-conformance.ts",
      "conformance/scripts/marfa-server.ts",
      ...harnessTests(),
      "conformance/vitest.config.ts",
    ]);
    expect(files).toContain("conformance/src/utils/target.ts");
    // The harness tests reach the typed client through a helper.
    expect(files).toContain("conformance/src/client/api.ts");
    const read = [...files, "conformance/package.json", "pnpm-lock.yaml"];
    expect(read.filter((f) => !affected(f).has("mcp-conformance"))).toEqual([]);
  });

  it("the crates a crate is built from include those named in its build and target dependency tables", () => {
    const tables = dependencyTables({
      dependencies: { a: { path: "../a" } },
      "build-dependencies": { b: { path: "../b" } },
      target: {
        'cfg(target_os = "macos")': { dependencies: { c: { path: "../c" } } },
        "x86_64-unknown-linux-musl": {
          "build-dependencies": { d: { path: "../d" } },
        },
      },
    });
    expect(tables.flatMap((table) => Object.keys(table)).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("the cached device binary is keyed on every crate it is built from", () => {
    const crates = crateClosure("marfa-cli");
    expect(crates).toEqual([
      "marfa-acl",
      "marfa-allocator",
      "marfa-cli",
      "marfa-core",
      "marfa-rules",
      "marfa-telemetry",
    ]);

    const { jobs } = workflow("ci.yml");
    for (const job of ["rust-contract-shards"]) {
      const steps = jobs[job]?.steps ?? [];
      const run = steps.find((s) => s.id === "device-key")?.run ?? "";
      const globs = [...run.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
      expect(globs, job).toContain("core/**");
      expect(globs, job).toContain(".github/workflows/ci.yml");
      const excluded = globs
        .filter((glob) => glob.startsWith("!"))
        .map((glob) => glob.slice(1));
      expect(excluded.length).toBeGreaterThan(0);
      for (const crate of crates) {
        const source = `core/${crate}/src/lib.rs`;
        expect(
          excluded.filter((glob) => globMatches(glob, source)),
          `${job} keys its binary on ${source}`,
        ).toEqual([]);
      }
      // Restored only for a pull request, and made newer than the checkout,
      // which the device suite refuses a binary for not being. The shards
      // that leave the device alone neither restore nor build it.
      const restore = steps.find((s) => s.id === "device");
      expect(restore?.if).toBe(
        "${{ matrix.binary && github.event_name == 'pull_request' }}",
      );
      expect(restore?.with?.key).toBe("${{ steps.device-key.outputs.key }}");
      expect(
        steps.find((s) => s.run === "touch core/target/debug/marfa")?.if,
      ).toBe(
        "${{ matrix.binary && steps.device.outputs.cache-hit == 'true' }}",
      );
      for (const crate of crates) {
        expect(
          DEVICE_SHARDS.every((job) =>
            affected(`core/${crate}/src/lib.rs`).has(job),
          ),
          crate,
        ).toBe(true);
      }
    }
  });
  it("the cached servers are keyed on every file they are built from, and on nothing a change to the device alone touches", () => {
    const crates = crateClosure("marfa-server");
    expect(crates).toEqual([
      "marfa-acl",
      "marfa-allocator",
      "marfa-enrichment",
      "marfa-rules",
      "marfa-server",
      "marfa-telemetry",
    ]);
    const { jobs } = workflow("ci.yml");
    const hooked = jobs["rust-contract"]?.steps ?? [];
    const released = jobs["rust-contract-release"]?.steps ?? [];
    const globs = hashedGlobs(hooked.find((s) => s.id === "key"));
    // The two builds are keyed on the same files, and by a name of their own.
    expect(hashedGlobs(released.find((s) => s.id === "key"))).toEqual(globs);
    expect(hooked.find((s) => s.id === "key")?.run).toContain(
      "marfa-rust-server-hooks-",
    );
    expect(released.find((s) => s.id === "key")?.run).toContain(
      "marfa-rust-server-release-",
    );
    // The witness: the helpers read a list, and tell a file in it from one out.
    expect(globs.length).toBeGreaterThan(0);
    expect(hashes(globs, "core/marfa-server/src/lib.rs")).toBe(true);
    expect(hashes(globs, "core/marfa-core/src/lib.rs")).toBe(false);
    expect(globs.some((glob) => glob.startsWith("!"))).toBe(false);

    // Every file of every crate the server is built from, and what ties
    // their versions and flags together.
    const read = tracked().filter(
      (path) =>
        crates.some((crate) => path.startsWith(`core/${crate}/`)) ||
        ["core/Cargo.toml", "core/Cargo.lock"].includes(path) ||
        path.startsWith("core/.cargo/") ||
        path.startsWith(".github/actions/native-build-image/") ||
        path === ".github/workflows/ci.yml" ||
        path === "openapi.json" ||
        /^packages\/types\/generated\/icon-set-[\w-]+\.json$/.test(path),
    );
    expect(read.length).toBeGreaterThan(0);
    expect(read.filter((path) => !hashes(globs, path))).toEqual([]);
    // Every file the program embeds from outside `core/`.
    const embedded = embeddedOutsideCore((path) =>
      crates.some((crate) => path.startsWith(`core/${crate}/`)),
    );
    expect(embedded).toContain("openapi.json");
    expect(embedded.filter((path) => !hashes(globs, path))).toEqual([]);
    // The crates the server is not built from are not in the key, or a change
    // to the core would build the server again.
    for (const path of tracked().filter(
      (file) =>
        file.startsWith("core/") &&
        !crates.some((crate) => file.startsWith(`core/${crate}/`)) &&
        !["core/Cargo.toml", "core/Cargo.lock"].includes(file) &&
        !file.startsWith("core/.cargo/"),
    )) {
      expect(hashes(globs, path), path).toBe(false);
    }
    // Everything the key reads that the program is built from runs the
    // server's shards, so that a changed input is never judged on the cache.
    for (const path of read.filter(
      (file) => !/(^|\/)tests\//.test(file) && !file.endsWith(".md"),
    )) {
      expect(
        SERVER_SHARDS.every((job) => affected(path).has(job)),
        `${path} does not run the server's shards`,
      ).toBe(true);
    }

    // Restored only for a pull request, by the exact key; saved by `main`
    // only, once the server is built.
    for (const steps of [hooked, released]) {
      const restore = steps.find((s) => s.id === "server");
      expect(restore?.if).toBe("${{ github.event_name == 'pull_request' }}");
      expect(restore?.uses).toMatch(/^actions\/cache\/restore@/);
      expect(restore?.with?.key).toBe("${{ steps.key.outputs.key }}");
      const save = steps.find((s) => s.uses?.startsWith("actions/cache/save@"));
      expect(save?.if).toBe(
        "${{ steps.aside.outcome == 'success' && github.ref == 'refs/heads/main' }}",
      );
      expect(save?.with?.key).toBe("${{ steps.key.outputs.key }}");
      expect(save?.with?.path).toBe(restore?.with?.path);
      // What is restored is what is built where it misses: nothing builds on a hit.
      expect(steps.filter((s) => s.run?.includes("release.sh")).length).toBe(1);
      for (const name of [
        "Show the free disk space",
        "Make the build image",
        "Set the server aside",
      ]) {
        expect(steps.find((s) => s.name === name)?.if, name).toContain(
          "steps.server.outputs.cache-hit != 'true'",
        );
      }
      expect(steps.find((s) => s.id === "build")?.if, "the build").toContain(
        "steps.server.outputs.cache-hit != 'true'",
      );
    }
  });

  it("the cached device binary and module are keyed on every file they embed from outside core", () => {
    const steps = workflow("ci.yml").jobs["rust-contract-shards"]?.steps ?? [];
    for (const [id, root] of [
      ["device-key", "marfa-cli"],
      ["module-key", "bindings/node"],
    ] as const) {
      const globs = hashedGlobs(steps.find((s) => s.id === id));
      const crates = crateClosure(root);
      const embedded = embeddedOutsideCore((path) =>
        crates.some((crate) => path.startsWith(`core/${crate}/`)),
      );
      // The witness: the rules crate embeds the icon sets, which the
      // program is not built without, and the key has no way to see them in
      // `core/`.
      expect(embedded, id).toContain(
        "packages/types/generated/icon-set-lucide.json",
      );
      expect(
        embedded.filter((path) => !hashes(globs, path)),
        `${id} leaves out a file the program embeds`,
      ).toEqual([]);
      expect(hashes(globs, "core/marfa-core/src/lib.rs"), id).toBe(true);
    }
  });

  it("the cached device module is keyed on every source it is built from, and the shards that drive it run when they change", () => {
    const steps = workflow("ci.yml").jobs["rust-contract-shards"]?.steps ?? [];
    const run = steps.find((s) => s.id === "module-key")?.run ?? "";
    const globs = [...run.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
    expect(globs).toContain("core/**");
    expect(globs).toContain(".github/workflows/ci.yml");
    const excluded = globs
      .filter((glob) => glob.startsWith("!"))
      .map((glob) => glob.slice(1));
    const built = [
      "core/marfa-core/src/lib.rs",
      "core/bindings/node/src/lib.rs",
      "core/bindings/node/build.rs",
      "core/bindings/node/Cargo.toml",
      "core/bindings/node/package.json",
      "core/bindings/node/pnpm-lock.yaml",
      "core/Cargo.lock",
    ];
    for (const source of built) {
      expect(
        excluded.filter((glob) => globMatches(glob, source)),
        `the module is keyed without ${source}`,
      ).toEqual([]);
      expect(
        DEVICE_SHARDS.every((job) => affected(source).has(job)),
        `${source} does not run the shards that drive the module`,
      ).toBe(true);
    }
    // What the build writes, and what only tests it, is not what it is built
    // from: keying on it would key the module on itself.
    for (const written of [
      "core/bindings/node/marfa-core.linux-x64-gnu.node",
      "core/bindings/node/index.js",
      "core/bindings/node/index.d.ts",
      "core/bindings/node/test/follow.test.mjs",
    ]) {
      expect(
        excluded.filter((glob) => globMatches(glob, written)),
        `the module is keyed on ${written}`,
      ).not.toEqual([]);
    }
    // Restored only for a pull request, and made newer than the checkout,
    // which the device suite refuses a module for not being.
    const restore = steps.find((s) => s.id === "module");
    expect(restore?.if).toBe(
      "${{ matrix.module && github.event_name == 'pull_request' }}",
    );
    expect(restore?.with?.key).toBe("${{ steps.module-key.outputs.key }}");
    expect(restore?.with?.path).toBe("core/bindings/node/*.node");
    expect(
      steps.find((s) => s.run === "touch core/bindings/node/*.node")?.if,
    ).toBe("${{ matrix.module && steps.module.outputs.cache-hit == 'true' }}");
    // Built where it is not restored, and told to the suite.
    expect(
      steps.find((s) => s.name === "Build the Node module under test")?.run,
    ).toContain("run build:debug");
    expect(
      steps.some((s) => s.run?.includes("MARFA_DEVICE_MODULE=")),
      "no step names the module to the suite",
    ).toBe(true);
  });
});

/** The conformance helpers: the modules beside the tests that are neither a test nor the benchmark's. */
function helpers(): string[] {
  return tracked().filter(
    (path) =>
      /^conformance\/src\/(utils|client)\/[^/]+\.ts$/.test(path) &&
      !path.endsWith(".test.ts"),
  );
}

interface ConformanceConfig {
  default: {
    test: { projects: { test: { name: string; setupFiles?: string[] } }[] };
  };
}

describe("what the jobs that run a script or a harness load from the helpers", () => {
  /**
   * What each job loads: the scripts it runs, the tests it runs and, for a
   * Vitest run, the config and the setup files of the project it picks, and
   * everything those import. Each job boots the server with
   * `scripts/marfa-server.ts`, which spawns `run-server.mjs`.
   */
  async function loaded(): Promise<Record<string, string[]>> {
    const { default: config } =
      (await import("../conformance/vitest.config.js")) as ConformanceConfig;
    const setup = (
      config.test.projects.find((p) => p.test.name === "compliance")?.test
        .setupFiles ?? []
    ).map((file) => join("conformance", file));
    expect(setup.length).toBeGreaterThan(0);
    const boot = [
      "conformance/scripts/marfa-server.ts",
      "conformance/scripts/run-server.mjs",
    ];
    return {
      "mcp-conformance": closure([
        "conformance/scripts/mcp-conformance.ts",
        ...boot.slice(0, 1),
        ...harnessTests(),
        "conformance/vitest.config.ts",
      ]),
      "restore-drill": closure([
        "conformance/scripts/restore-drill.ts",
        "conformance/scripts/garage.ts",
        ...boot.slice(0, 1),
      ]),
      // The score judges its report, and it is run by Vitest from the config.
      "rust-contract-release": closure([
        "conformance/src/suites/compliance/hook-free-server.test.ts",
        "conformance/vitest.config.ts",
        ...setup,
        ...boot.slice(0, 1),
        "conformance/scripts/rust-score.ts",
      ]),
    };
  }

  it("reach MCP conformance, the restore drill and the build without test hooks only through the modules each one imports", async () => {
    const reads = await loaded();
    const all = helpers();
    for (const [job, files] of Object.entries(reads)) {
      // Every file the job loads, through any number of imports, runs it.
      expect(
        [...files, "conformance/scripts/run-server.mjs"].filter(
          (file) => !affected(file).has(job as Job),
        ),
        `${job} loads a file that does not run it`,
      ).toEqual([]);
      // A helper it does not load leaves it out, and one it does load runs it.
      expect(
        all.filter(
          (file) => !files.includes(file) && affected(file).has(job as Job),
        ),
        `${job} runs for a helper it does not load`,
      ).toEqual([]);
      const own = all.filter((file) => files.includes(file));
      expect(own.length, `${job} loads no helper`).toBeGreaterThan(0);
      expect(
        own.filter((file) => !affected(file).has(job as Job)),
        `${job} skips a helper it loads`,
      ).toEqual([]);
    }
    // The witnesses: each job loads helpers the others do not, so each set
    // was producible, and a stream helper no script or harness loads runs
    // none of them but still runs every fixture.
    expect(reads["restore-drill"]).toContain("conformance/src/utils/drill.ts");
    expect(reads["mcp-conformance"]).not.toContain(
      "conformance/src/utils/drill.ts",
    );
    expect(reads["mcp-conformance"]).toContain(
      "conformance/src/utils/moved-clock.ts",
    );
    expect(reads["restore-drill"]).not.toContain(
      "conformance/src/utils/moved-clock.ts",
    );
    expect(reads["rust-contract-release"]).toContain(
      "conformance/src/utils/platform.ts",
    );
    expect(reads["mcp-conformance"]).not.toContain(
      "conformance/src/utils/platform.ts",
    );
    expect(all).toContain("conformance/src/utils/stream.ts");
    const stream = affected("conformance/src/utils/stream.ts");
    for (const job of Object.keys(reads))
      expect(stream.has(job as Job)).toBe(false);
    for (const job of CONTRACT) expect(stream.has(job)).toBe(true);
  });
});

describe("the build without test hooks and its fixture", () => {
  const release = (path: string) => affected(path).has("rust-contract-release");

  it("run for what the server is built from, never for a fixture that runs against the build with the hooks", () => {
    const key = hashedGlobs(
      workflow("ci.yml").jobs["rust-contract-release"]?.steps?.find(
        (step) => step.id === "key",
      ),
    );
    expect(key.length).toBeGreaterThan(0);
    // Every file the build is made from, apart from the Rust tests and the
    // Markdown, which the program does not embed.
    const built = tracked().filter(
      (path) =>
        hashes(key, path) &&
        !/(^|\/)tests\//.test(path) &&
        !path.endsWith(".md"),
    );
    expect(built).toContain("openapi.json");
    expect(built).toContain("core/marfa-server/src/lib.rs");
    expect(built.filter((path) => !release(path))).toEqual([]);
    // The witness: a fixture is none of those, and the shards still run it.
    const fixtures = tracked().filter(
      (path) =>
        /^conformance\/src\/suites\/(compliance|correctness|sync)\/.*\.ts$/.test(
          path,
        ) && !path.endsWith("/hook-free-server.test.ts"),
    );
    expect(fixtures.length).toBeGreaterThan(50);
    expect(fixtures.filter((path) => hashes(key, path))).toEqual([]);
    expect(fixtures.filter(release)).toEqual([]);
    expect(
      fixtures.filter(
        (path) => !SERVER_SHARDS.every((job) => affected(path).has(job)),
      ),
    ).toEqual([]);
  });

  it("run for the fixture they boot, and for everything it loads", () => {
    const fixture =
      "conformance/src/suites/compliance/hook-free-server.test.ts";
    expect(tracked()).toContain(fixture);
    expect(release(fixture)).toBe(true);
    for (const path of closure([fixture]))
      expect(release(path), path).toBe(true);
    // Two compliance fixtures, as in a change that touches only fixtures.
    expect(
      runs([
        "conformance/src/suites/compliance/edge-events.test.ts",
        "conformance/src/suites/compliance/stream-credential.test.ts",
      ]),
    ).toEqual(["quick-checks", "workspace", ...OFFLINE, ...SERVER_SHARDS]);
    // The same change with the fixture they boot.
    expect(runs([fixture])).toContain("rust-contract-release");
  });

  it("run only with the server's own group, which the jobs that boot their build wait for", () => {
    for (const path of tracked()) {
      if (release(path)) {
        expect(
          [...affected(path)],
          `${path} runs the build without test hooks and not the server's shards`,
        ).toContain("rust-contract-server");
      }
    }
    // The device's group alone does not owe the build or the fixture.
    const device = classify(["core/marfa-core/src/store/mod.rs"]);
    expect(device["rust-contract-device"]).toBe(true);
    expect(device["rust-contract-release"]).toBe(false);
  });
});

describe("what Lint reads", () => {
  const code = () => tracked().filter((path) => /\.[cm]?[jt]sx?$/.test(path));

  it("skips what the config of ESLint ignores, which this test reads from it", async () => {
    const { default: config } = (await import(
      pathToFileURL(join(ROOT, "eslint.config.js")).href
    )) as { default: { ignores?: string[]; files?: string[] }[] };
    const ignores = config.flatMap((entry) =>
      Object.keys(entry).length === 1 ? (entry.ignores ?? []) : [],
    );
    expect(ignores).toContain("conformance/");
    expect(ignores).toContain("core/");
    expect(ignores).toContain("packages/client/src/generated/");
    // A folder pattern, which the classifier's pattern must ignore a file in.
    for (const pattern of ignores) {
      expect(pattern, "an ignore this test cannot read").toMatch(
        /^(\*\*\/)?[\w.-]+(\/[\w.-]+)*\/(\*\*)?$/,
      );
      const folder = pattern
        .replace(/^\*\*\//, "packages/example/")
        .replace(/\/\*\*$/, "/")
        .replace(/\/$/, "");
      expect(
        ESLINT_IGNORED.test(`${folder}/probe.ts`),
        `${pattern} is not ignored by the classifier`,
      ).toBe(true);
    }
    // ESLint's own answer, for every file it could read, agrees with the classifier's.
    const eslint = new ESLint({ cwd: ROOT });
    const disagree: string[] = [];
    for (const path of code()) {
      if (
        (await eslint.isPathIgnored(resolve(ROOT, path))) !==
        ESLINT_IGNORED.test(path)
      ) {
        disagree.push(path);
      }
    }
    expect(disagree).toEqual([]);
  }, 60_000);

  it("runs for the files ESLint lints, the files it types them from and the settings that decide how, and for nothing else", () => {
    const linted = code().filter((path) => !ESLINT_IGNORED.test(path));
    expect(linted.length).toBeGreaterThan(50);
    expect(linted.filter((path) => !affected(path).has("lint"))).toEqual([]);
    // A rule that reads types reads what a linted file imports, in a folder
    // ESLint ignores too.
    const reached = closure(linted);
    const typed = reached.filter((path) => ESLINT_IGNORED.test(path));
    expect(typed).toContain("conformance/src/utils/rust-score.ts");
    expect(typed).toContain("packages/client/src/generated/schema.ts");
    expect(typed.filter((path) => !affected(path).has("lint"))).toEqual([]);
    // Nothing else runs it but a setting, or a path whose change runs every job.
    const settings =
      /(^|\/)(package\.json|tsconfig[^/]*\.json)$|^(pnpm-lock|pnpm-workspace)\.yaml$/;
    expect(
      tracked().filter(
        (path) =>
          affected(path).has("lint") &&
          affected(path).size < JOBS.length &&
          !linted.includes(path) &&
          !reached.includes(path) &&
          !settings.test(path),
      ),
    ).toEqual([]);
    // The witnesses: the files it skips were producible, and the same kinds
    // of file in a place it reads run it.
    for (const path of [
      "conformance/src/suites/compliance/owner.test.ts",
      "conformance/src/utils/stream.ts",
      "conformance/src/utils/shard-drift.ts",
      "conformance/spec/items.md",
      "core/bindings/node/test/pin.test.mjs",
      "core/bindings/node/package.json",
      "openapi.json",
    ]) {
      expect(affected(path).has("lint"), path).toBe(false);
    }
    expect(affected("ci/ci-required.test.ts").has("lint")).toBe(true);
    expect(affected("packages/client/package.json").has("lint")).toBe(true);
    expect(affected("conformance/package.json").has("lint")).toBe(true);
    // The tracked paths are the evidence: each skipped one exists.
    for (const path of ["conformance/src/utils/stream.ts", "openapi.json"]) {
      expect(tracked()).toContain(path);
    }
  });

  it("runs the pull requests of a fixture or of the API document without it, and a draft with it only for what it reads", () => {
    expect(runs(["openapi.json"])).not.toContain("lint");
    expect(
      runs(["conformance/src/suites/compliance/edge-events.test.ts"]),
    ).not.toContain("lint");
    const draft = forDraft(
      classify(["conformance/src/suites/compliance/edge-events.test.ts"]),
    );
    expect(draft.lint).toBe(false);
    expect(draft.workspace).toBe(true);
    expect(forDraft(classify(["ci/ci-required.test.ts"])).lint).toBe(true);
  });
});

describe("the command line on a Mac", () => {
  it("stays whole in the rule, because its server manager is launchd only on a Mac and no Apple-only cfg names the files that drive it", () => {
    const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
    // The manager is chosen by the platform, in one place.
    expect(read("core/marfa-cli/src/server/service.rs")).toMatch(
      /if cfg!\(target_os = "macos"\) \{[\s\S]*?Ok\(Manager::Launchd\)/,
    );
    // The upgrade and install flows reach it through the manager and
    // `launchd`, and name no platform: the search for an Apple-only cfg does
    // not find them, and a Linux run drives them through systemd.
    for (const path of [
      "core/marfa-cli/src/server/lifecycle.rs",
      "core/marfa-cli/src/server/docker.rs",
    ]) {
      expect(read(path), path).toMatch(/launchd/);
    }
    expect(read("core/marfa-cli/src/server/lifecycle.rs")).not.toMatch(
      /target_os|target_vendor/,
    );
    // The tests that run it on a Mac hold launchd's side, which only a Mac runs.
    expect(read("core/marfa-cli/tests/server.rs")).toMatch(
      /cfg!\(target_os = "macos"\)/,
    );
    for (const path of [
      "core/marfa-cli/src/server/lifecycle.rs",
      "core/marfa-cli/src/commands/housekeeping.rs",
      "core/marfa-cli/src/main.rs",
    ]) {
      expect([...affected(path)], path).toEqual(
        expect.arrayContaining(["core-checks", "core"]),
      );
    }
    // The witness: what no job reads on a Mac stays off it.
    expect([...affected("core/marfa-cli/COMMANDS.md")]).not.toContain(
      "core-checks",
    );
  });
});

describe("the classifier as CI runs it", () => {
  const script = resolve(ROOT, "scripts/ci-required.ts");
  const directory = mkdtempSync(join(tmpdir(), "marfa-ci-paths-"));
  // Stands in for `gh` on PATH: it records each call and prints `response`,
  // or fails when there is none.
  const fake = mkdtempSync(join(tmpdir(), "marfa-ci-gh-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const commits: Record<string, string> = {};

  /** The commit each one follows, for a diff of one change. */
  const parents: Record<string, string> = {};

  function commit(name: string, files: Record<string, string>) {
    try {
      parents[name] = git("rev-parse", "--quiet", "--verify", "HEAD");
    } catch {
      // The first commit follows nothing.
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
    }
    git("add", "-A");
    git("commit", "-qm", name);
    commits[name] = git("rev-parse", "HEAD");
  }

  beforeAll(() => {
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "CI Fixture");
    git("config", "commit.gpgsign", "false");
    commit("base", {
      "packages/types/src/runtime.ts": "export const v = 1;\n",
    });
    commit("docs", { "deploy/README.md": "Words\n" });
    commit("server", {
      "packages/types/src/runtime.ts": "export const v = 2;\n",
    });
    git("mv", "packages/types/src/runtime.ts", "packages/types/README.md");
    git("commit", "-qm", "rename");
    commits.rename = git("rev-parse", "HEAD");
    commit("instructions", {
      "AGENTS.md": "Words\n",
      ".agents/skills/release/helper.py": "print()\n",
      ".claude/settings.json": "{}\n",
      ".codex/config.toml": "\n",
      ".githooks/pre-push": "#!/bin/sh\n",
    });
    commit("workflow", { ".github/workflows/new.yml": "on: push\n" });
    commit("unknown", { "tools/new.ts": "export {};\n" });
    commit("helper", { ".agents/helper.py": "print('helper')\n" });
    mkdirSync(join(directory, "scripts"));
    git("mv", ".agents/helper.py", "scripts/helper.py");
    git("commit", "-qm", "moved");
    commits.moved = git("rev-parse", "HEAD");
    git("mv", "scripts/helper.py", "NOTES.md");
    git("commit", "-qm", "noted");
    commits.noted = git("rev-parse", "HEAD");
    commit("fixture", {
      "conformance/src/suites/compliance/owner.test.ts": "export {};\n",
    });
    // One commit for each kind of change the shards are chosen by.
    commit("core", { "core/marfa-core/src/store/mod.rs": "// store\n" });
    commit("cli", { "core/marfa-cli/src/main.rs": "// main\n" });
    commit("serverRs", { "core/marfa-server/src/lib.rs": "// lib\n" });
    commit("rules", { "core/marfa-rules/src/lib.rs": "// lib\n" });
    commit("lock", { "core/Cargo.lock": "# lock\n" });
    commit("cliFixture", {
      "conformance/src/suites/cli/folder.test.ts": "export {};\n",
    });
    commit("deviceFixture", {
      "conformance/src/suites/device/folders.test.ts": "export {};\n",
    });
    commit("correctnessFixture", {
      "conformance/src/suites/correctness/items.test.ts": "export {};\n",
    });
    commit("syncFixture", {
      "conformance/src/suites/sync/streams.test.ts": "export {};\n",
    });
    commit("classifier", { "scripts/ci-required.ts": "// classifier\n" });
    writeFileSync(
      join(fake, "gh"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$(dirname "$0")/calls"\ncat "$(dirname "$0")/response"\n',
      { mode: 0o755 },
    );
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(fake, { recursive: true, force: true });
  });

  function run(
    event: string,
    payload: unknown,
    env: Record<string, string | undefined> = {},
  ): Record<string, string> {
    const eventPath = join(directory, "event.json");
    const output = join(directory, "output");
    writeFileSync(eventPath, JSON.stringify(payload));
    writeFileSync(output, "");
    execFileSync(process.execPath, [script], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${fake}:${process.env.PATH ?? ""}`,
        GITHUB_EVENT_NAME: event,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "example/marfa",
        GITHUB_WORKFLOW_REF:
          "example/marfa/.github/workflows/ci.yml@refs/heads/main",
        ...env,
      },
    });
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)] as [string, string];
        }),
    );
  }

  function outputs(
    event: string,
    from: string,
    to: string,
    draft?: boolean,
  ): Record<string, string> {
    return run(event, {
      pull_request: { base: { sha: from }, head: { sha: to }, draft },
    });
  }

  /** The matrix and the projects of the shards a run owes. */
  const owed = (shards: typeof SHARDS) => ({
    "rust-shards": JSON.stringify({ include: shards }),
    "rust-projects": projectsOf(shards).join(","),
  });

  const every = (value: string) => ({
    ...Object.fromEntries(JOBS.map((job) => [job, value])),
    ...owed(value === "true" ? SHARDS : []),
    full: "true",
  });

  it("writes one answer per job for a pull request's diff", () => {
    expect(
      outputs("pull_request", commits.base ?? "", commits.docs ?? ""),
    ).toEqual({
      ...every("false"),
      "quick-checks": "true",
      full: "true",
    });
    const server = outputs(
      "pull_request",
      commits.docs ?? "",
      commits.server ?? "",
    );
    expect(JOBS.filter((job) => server[job] === "true")).toEqual(
      JOBS.filter((job) =>
        [...PACKAGES, "lint", "types-freshness", "clients-freshness"].includes(
          job,
        ),
      ),
    );
    const fixture = outputs(
      "pull_request",
      commits.noted ?? "",
      commits.fixture ?? "",
    );
    expect(JOBS.filter((job) => fixture[job] === "true")).toEqual(
      JOBS.filter((job) =>
        ["quick-checks", "workspace", ...OFFLINE, ...SERVER_SHARDS].includes(
          job,
        ),
      ),
    );
  });

  describe("the shards a pull request runs", () => {
    const names = (shards: typeof SHARDS) => shards.map((shard) => shard.slug);
    const device = names(
      SHARDS.filter((s) => s.lane === "rust-contract-device"),
    );
    const server = names(
      SHARDS.filter((s) => s.lane === "rust-contract-server"),
    );

    it("lists the shards, and a lane's shards belong to its projects", () => {
      // The witness: both lanes hold shards, and every project is in one.
      expect(device.length).toBeGreaterThan(0);
      expect(server.length).toBeGreaterThan(0);
      expect(projectsOf(SHARDS)).toEqual([
        "correctness",
        "sync",
        "compliance",
        "cli",
        "device",
      ]);
      expect(
        projectsOf(SHARDS.filter((s) => s.lane === "rust-contract-device")),
      ).toEqual(["cli", "device"]);
      expect(
        projectsOf(SHARDS.filter((s) => s.lane === "rust-contract-server")),
      ).toEqual(["correctness", "sync", "compliance"]);
      expect(new Set(names(SHARDS)).size).toBe(SHARDS.length);
      // An answer names the shards of the groups it runs, in list order.
      expect(
        names(shardsFor(classify(["core/marfa-core/src/store/mod.rs"]))),
      ).toEqual(device);
      expect(names(shardsFor(classify([])))).toEqual(names(SHARDS));
    });

    it("keeps a project's shards whole, so that a project is judged by every shard of it", () => {
      for (const project of projectsOf(SHARDS)) {
        const of = SHARDS.filter((s) =>
          s.args.includes(`--project ${project}`),
        );
        expect(of.length, project).toBeGreaterThan(0);
        // One lane holds all of a project.
        expect(new Set(of.map((s) => s.lane)).size, project).toBe(1);
        // A project split in shards names every one of them.
        const total = of
          .map((s) => /--shard=\d+\/(\d+)/.exec(s.args)?.[1])
          .filter((n) => n !== undefined);
        if (total.length > 0) {
          expect(total.length, project).toBe(Number(total[0]));
        }
      }
    });

    it.each<[string, string, string[], string[]]>([
      ["a core-only change", "core", device, ["cli", "device"]],
      ["a CLI-only change", "cli", device, ["cli", "device"]],
      [
        "a server change",
        "serverRs",
        names(SHARDS),
        ["correctness", "sync", "compliance", "cli", "device"],
      ],
      [
        "a change to the rules crate",
        "rules",
        names(SHARDS),
        ["correctness", "sync", "compliance", "cli", "device"],
      ],
      [
        "a lockfile change",
        "lock",
        names(SHARDS),
        ["correctness", "sync", "compliance", "cli", "device"],
      ],
      ["a CLI fixture", "cliFixture", device, ["cli", "device"]],
      ["a device fixture", "deviceFixture", device, ["cli", "device"]],
      [
        "a compliance fixture",
        "fixture",
        server,
        ["correctness", "sync", "compliance"],
      ],
      [
        "a correctness fixture",
        "correctnessFixture",
        server,
        ["correctness", "sync", "compliance"],
      ],
      [
        "a sync fixture",
        "syncFixture",
        server,
        ["correctness", "sync", "compliance"],
      ],
      [
        "the classifier itself",
        "classifier",
        names(SHARDS),
        ["correctness", "sync", "compliance", "cli", "device"],
      ],
      [
        "a path no rule names",
        "unknown",
        names(SHARDS),
        ["correctness", "sync", "compliance", "cli", "device"],
      ],
    ])(
      "%s runs the matrix and the projects of its lane",
      (_, name, slugs, projects) => {
        const answer = outputs(
          "pull_request",
          parents[name] ?? "",
          commits[name] ?? "",
        );
        const matrix = JSON.parse(answer["rust-shards"] ?? "") as {
          include: typeof SHARDS;
        };
        expect(names(matrix.include)).toEqual(
          names(SHARDS).filter((slug) => slugs.includes(slug)),
        );
        // The score judges the projects of the shards that run, no fewer.
        expect(answer["rust-projects"]).toBe(
          projectsOf(matrix.include).join(","),
        );
        expect(projectsOf(matrix.include)).toEqual(
          projectsOf(SHARDS).filter((project) => projects.includes(project)),
        );
      },
    );

    it("a core-only change leaves the server's shards, MCP conformance and the restore drill out", () => {
      const answer = outputs(
        "pull_request",
        parents.core ?? "",
        commits.core ?? "",
      );
      expect(JOBS.filter((job) => answer[job] === "true")).toEqual(
        JOBS.filter((job) =>
          ["quick-checks", ...DEVICE_LINUX, "core"].includes(job),
        ),
      );
      for (const job of [
        ...SERVER_SHARDS,
        "mcp-conformance",
        "restore-drill",
      ]) {
        expect(answer[job], job).toBe("false");
      }
    });

    it("runs no shard, and judges no project, for a change they cannot read", () => {
      const answer = outputs(
        "pull_request",
        commits.base ?? "",
        commits.docs ?? "",
      );
      expect(answer["rust-shards"]).toBe('{"include":[]}');
      expect(answer["rust-projects"]).toBe("");
    });

    it("runs no shard for a draft, which runs the quick jobs only", () => {
      const answer = outputs(
        "pull_request",
        parents.core ?? "",
        commits.core ?? "",
        true,
      );
      expect(answer["rust-shards"]).toBe('{"include":[]}');
      expect(answer["rust-projects"]).toBe("");
    });

    it("runs every shard on a push to main", () => {
      const eventPush = run(
        "push",
        { before: parents.core, after: commits.core, forced: false },
        { GITHUB_REF: "refs/heads/main" },
      );
      const matrix = JSON.parse(eventPush["rust-shards"] ?? "") as {
        include: typeof SHARDS;
      };
      expect(names(matrix.include)).toEqual(names(SHARDS));
      expect(eventPush["rust-projects"]).toBe(projectsOf(SHARDS).join(","));
    });
  });

  it("runs only the quick jobs for a draft and every one once it is ready", () => {
    const quick = (output: Record<string, string>) =>
      JOBS.filter((job) => output[job] === "true");
    const server = outputs(
      "pull_request",
      commits.docs ?? "",
      commits.server ?? "",
      true,
    );
    expect(quick(server)).toEqual([
      "quick-checks",
      "workspace",
      "lint",
      "types-freshness",
    ]);
    expect(server.full).toBe("false");
    // Documentation names no quick job but the format check, which `Quick checks`
    // runs for every change.
    const docs = outputs(
      "pull_request",
      commits.base ?? "",
      commits.docs ?? "",
      true,
    );
    expect(quick(docs)).toEqual(["quick-checks"]);
    expect(docs.full).toBe("false");
    const ready = outputs(
      "pull_request",
      commits.docs ?? "",
      commits.server ?? "",
      false,
    );
    expect(quick(ready)).toEqual(
      JOBS.filter((job) =>
        [...PACKAGES, "lint", "types-freshness", "clients-freshness"].includes(
          job,
        ),
      ),
    );
    expect(ready.full).toBe("true");
    expect(
      outputs("pull_request", "invalid", commits.docs ?? "", true),
    ).toMatchObject({
      "quick-checks": "true",
      "rust-contract-server": "false",
      "rust-contract-device": "false",
      full: "false",
    });
  });

  it("does not hide code deleted by a rename into documentation", () => {
    const renamed = outputs(
      "pull_request",
      commits.server ?? "",
      commits.rename ?? "",
    );
    expect(renamed.workspace).toBe("true");
    expect(renamed["conformance-offline"]).toBe("true");
  });

  it("runs every job when the diff cannot be read or is empty", () => {
    expect(outputs("pull_request", "invalid", commits.docs ?? "")).toEqual(
      every("true"),
    );
    expect(
      outputs("pull_request", commits.docs ?? "", commits.docs ?? ""),
    ).toEqual(every("true"));
  });

  it("runs every job on a dispatch", () => {
    expect(
      outputs("workflow_dispatch", commits.base ?? "", commits.docs ?? ""),
    ).toEqual(every("true"));
  });

  it("runs on the nightly only what needs a Mac", () => {
    const night = outputs("schedule", commits.base ?? "", commits.docs ?? "");
    expect(JOBS.filter((job) => night[job] === "true")).toEqual(
      JOBS.filter((job) => NIGHTLY_JOBS.includes(job)),
    );
    expect(NIGHTLY_JOBS).toEqual([
      "rust-contract-macos",
      "core-checks",
      "swift-package",
    ]);
    // The pull request's lanes are untouched by the nightly's answer.
    expect(forNightly()).toEqual(
      Object.fromEntries(JOBS.map((job) => [job, NIGHTLY_JOBS.includes(job)])),
    );
  });

  describe("on a push to main", () => {
    interface Run {
      event: string;
      head_branch: string | null;
      head_sha: string;
      conclusion: string | null;
    }
    const green = (
      sha: string,
      event = "push",
      branch: string | null = "main",
    ): Run => ({
      event,
      head_branch: branch,
      head_sha: sha,
      conclusion: "success",
    });

    /**
     * The push's outputs, with `gh` answering `runs` for the commit before
     * it, or failing for `undefined`, or printing a string as it is.
     */
    function pushed(
      before: string,
      after: string,
      runs: Run[] | string | undefined,
      options: {
        forced?: boolean;
        env?: Record<string, string | undefined>;
      } = {},
    ): { output: Record<string, string>; calls: string[] } {
      rmSync(join(fake, "calls"), { force: true });
      rmSync(join(fake, "response"), { force: true });
      if (runs !== undefined) {
        writeFileSync(
          join(fake, "response"),
          typeof runs === "string"
            ? runs
            : JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
        );
      }
      const output = run(
        "push",
        { before, after, forced: options.forced ?? false },
        options.env,
      );
      const calls = existsSync(join(fake, "calls"))
        ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n")
        : [];
      return { output, calls };
    }

    const skipped = {
      ...every("false"),
      "quick-checks": "true",
      full: "true",
    };

    it("skips what documentation skips once ci.yml passed on the commit before", () => {
      const before = commits.rename ?? "";
      const { output, calls } = pushed(before, commits.instructions ?? "", [
        green(before),
      ]);
      expect(output).toEqual(skipped);
      expect(calls).toEqual([
        `api repos/example/marfa/actions/workflows/ci.yml/runs?head_sha=${before}&status=success&per_page=100`,
      ]);
      // A dispatch on that commit is a run the release gate accepts too.
      expect(
        pushed(before, commits.instructions ?? "", [
          green(before, "workflow_dispatch", "some-branch"),
        ]).output,
      ).toEqual(skipped);
    });

    it.each<[string, (before: string) => Run[] | string | undefined]>([
      ["failed, is still running or never ran", () => []],
      [
        "only failed, whatever the query asked for",
        (before) => [{ ...green(before), conclusion: "failure" }],
      ],
      [
        "passed only as a pull request's head",
        (before) => [green(before, "pull_request")],
      ],
      [
        "passed only on a push to another branch",
        (before) => [green(before, "push", "next")],
      ],
      ["passed only on another commit", () => [green("f".repeat(40))]],
      ["passed only on a nightly run", (before) => [green(before, "schedule")]],
      ["cannot be asked about", () => undefined],
      ["answers something that is not JSON", () => "not json"],
      ["answers JSON without runs", () => "{}"],
    ])("runs every job when ci.yml on the commit before %s", (_, runs) => {
      const before = commits.rename ?? "";
      expect(
        pushed(before, commits.instructions ?? "", runs(before)).output,
      ).toEqual(every("true"));
    });

    it("runs every job when it cannot tell which workflow or repository it is", () => {
      const before = commits.rename ?? "";
      for (const env of [
        { GITHUB_WORKFLOW_REF: undefined },
        { GITHUB_REPOSITORY: undefined },
      ]) {
        expect(
          pushed(before, commits.instructions ?? "", [green(before)], { env })
            .output,
        ).toEqual(every("true"));
      }
    });

    it.each<[string, string, string]>([
      ["code", "docs", "server"],
      ["a workflow", "instructions", "workflow"],
      ["a path no rule names", "workflow", "unknown"],
      ["code renamed into documentation only Prettier reads", "moved", "noted"],
      ["a file renamed out of an agent folder into code", "helper", "moved"],
      ["nothing", "docs", "docs"],
    ])(
      "runs every job, and never asks, when the push changes %s",
      (_, from, to) => {
        const before = commits[from] ?? "";
        const { output, calls } = pushed(before, commits[to] ?? "", [
          green(before),
        ]);
        expect(output).toEqual(every("true"));
        expect(calls).toEqual([]);
      },
    );

    it("runs every job on a first or forced push, or a malformed one", () => {
      const before = commits.rename ?? "";
      const after = commits.instructions ?? "";
      const runs = [green(before)];
      expect(pushed("0".repeat(40), after, runs).output).toEqual(every("true"));
      expect(pushed(before, after, runs, { forced: true }).output).toEqual(
        every("true"),
      );
      expect(pushed("invalid", after, runs).output).toEqual(every("true"));
      expect(pushed("a".repeat(40), after, runs).output).toEqual(every("true"));
    });
  });
});
