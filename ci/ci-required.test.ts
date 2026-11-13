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
import { parse as parseToml } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  affected,
  classify,
  documentationOnly,
  DRAFT_JOBS,
  forDraft,
  forNightly,
  NIGHTLY_JOBS,
  JOBS,
  RULES,
  type Job,
} from "../scripts/ci-required.js";

const ROOT = resolve(import.meta.dirname, "..");

function runs(paths: string[]): Job[] {
  const answer = classify(paths);
  return JOBS.filter((job) => answer[job]);
}

/** The lane that needs no server. */
const OFFLINE: Job[] = ["conformance-offline"];
/** The fixtures: the offline lane holds the citations, and the Rust contract jobs run them. */
const CONTRACT: Job[] = [...OFFLINE, "rust-contract"];
/** A workspace package's code reaches the workspace's build and tests, and the offline lane. */
const PACKAGES: Job[] = ["quick-checks", "workspace", ...OFFLINE];
/** Every job that boots the Rust server. */
const RUST_SERVER: Job[] = [
  "rust-contract",
  "mcp-conformance",
  "restore-drill",
];
/** The Rust contract jobs build the binary for the device and CLI fixtures. */
const RUST_LINUX: Job[] = ["core-checks-linux", ...OFFLINE, ...RUST_SERVER];
/** The two jobs that run on a Mac, which a pull request runs only for what a Mac alone can break. */
const MACOS: Job[] = ["core-checks", "core"];
const RUST: Job[] = [...RUST_LINUX, ...MACOS];
/** The two jobs that read `marfa-enrichment`: its fault-injection tests and its native build. */
const ENRICHMENT: Job[] = ["core-native", "core-fault-injection"];
/** The chapters of the contract a server fixture reads while it runs. */
const READ_AT_RUN_TIME = ["errors.md", "coverage.md"];

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
      "a published package's README, which the version check reads",
      ["packages/client/README.md"],
      ["quick-checks", "version-fields"],
    ],
    [
      "top-level documentation, the README's images and the licence",
      ["GLOSSARY.md", "LICENSE", "assets/architecture-light.svg"],
      ["quick-checks"],
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
      ["quick-checks", "workspace"],
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
      "the action that makes the native build image",
      [".github/actions/native-build-image/action.yml"],
      ["quick-checks", "core-native", "image", "rust-contract"],
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
        "rust-contract",
      ],
    ],
    [
      "the coverage table, which a compliance fixture reads at run time",
      ["conformance/spec/coverage.md"],
      ["quick-checks", "workspace", ...OFFLINE, "rust-contract"],
    ],
    [
      "a type definition, which the core's catalog is written from",
      ["packages/types/core/note.json"],
      [...PACKAGES, "types-freshness", "clients-freshness"],
    ],
    [
      "the registry that lists the types",
      ["packages/shared/src/type-registry.ts"],
      [...PACKAGES, "clients-freshness"],
    ],
    [
      "the catalog the core carries",
      ["core/marfa-rules/src/builtin_catalog.json"],
      [...RUST_LINUX, "core", "clients-freshness", "workspace", "quick-checks"],
    ],
    [
      "a client-only change, which no contract job reads",
      ["packages/client/src/client.ts"],
      ["quick-checks", "workspace", "clients-freshness"],
    ],
    [
      "a Rust-only change",
      ["core/marfa-core/src/store.rs"],
      [...RUST_LINUX, "core", "quick-checks"],
    ],
    [
      "the core's folder watching, which FSEvents, name case and Finder packages change",
      ["core/marfa-core/src/folder/scan.rs", "core/marfa-core/src/watch.rs"],
      [...RUST, "quick-checks"],
    ],
    [
      "the command line, with its login keychain and launchd autostart",
      ["core/marfa-cli/src/main.rs"],
      [...RUST, "quick-checks"],
    ],
    [
      "the core's lockfile, since a dependency bump can break an Apple build",
      ["core/Cargo.lock"],
      [...RUST, ...ENRICHMENT, "image", "quick-checks", "version-fields"],
    ],
    [
      "the native readers' scripts, pins and patches, which the native build, the image's programs and the Rust server's build run",
      [
        "core/marfa-enrichment/native/release.sh",
        "core/marfa-enrichment/native/manifest.txt",
        "core/marfa-enrichment/native/patches/pdfium-steps.patch",
        "core/marfa-enrichment/native/shim.cc",
        "core/marfa-enrichment/native/linux/Dockerfile",
      ],
      ["quick-checks", "core-native", "image", "rust-contract"],
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
      ["quick-checks", "version-fields", ...RUST, ...ENRICHMENT],
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
      "the Swift crate's lockfile, which pins the uniffi the glue is made with",
      ["core/bindings/swift/Cargo.lock"],
      [
        "quick-checks",
        "core-checks",
        "core",
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
        "rust-contract",
      ],
    ],
    [
      "the Node module's manifest, which its build reads",
      ["core/bindings/node/package.json"],
      ["quick-checks", "core", "rust-contract", "version-fields"],
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
        "clients-freshness",
      ],
    ],
    [
      "a CLI scenario",
      ["conformance/src/suites/cli/folder.test.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "the CLI harness, which a device fixture imports",
      ["conformance/src/suites/cli/harness.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "the device harness shared by CLI scenarios",
      ["conformance/src/suites/device/harness.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "the device suites' adapters and scripted server, which a CLI scenario imports",
      [
        "conformance/src/device/cli-adapter.ts",
        "conformance/src/device/scripted-server.ts",
      ],
      ["quick-checks", "workspace", ...CONTRACT],
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
      [
        "quick-checks",
        "workspace",
        ...CONTRACT,
        "restore-drill",
        "mcp-conformance",
      ],
    ],
    [
      "a device fixture",
      ["conformance/src/suites/device/folders.test.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "the helpers the folder fixtures share",
      ["conformance/src/suites/device/folders.shared.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "the item names and previews the shared package and the core share",
      ["conformance/fixtures/item-display.json"],
      [
        "quick-checks",
        "workspace",
        "core-checks-linux",
        ...OFFLINE,
        "rust-contract",
      ],
    ],
    [
      "the filter expressions the core's crates and the Node binding share",
      ["conformance/fixtures/filter-expressions.json"],
      ["quick-checks", "core-checks-linux", "core"],
    ],
    [
      "the name fold the core and the contract's title fixture share",
      ["conformance/fixtures/name-fold.json"],
      ["quick-checks", "core-checks-linux", "rust-contract"],
    ],
    [
      "a compliance fixture",
      ["conformance/src/suites/compliance/owner.test.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "a correctness fixture",
      ["conformance/src/suites/correctness/items.test.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
    ],
    [
      "a sync fixture",
      ["conformance/src/suites/sync/streams.test.ts"],
      ["quick-checks", "workspace", ...CONTRACT],
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
      [
        "quick-checks",
        "workspace",
        ...CONTRACT,
        "restore-drill",
        "mcp-conformance",
      ],
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
        ...CONTRACT,
        "restore-drill",
        "mcp-conformance",
      ],
    ],
    [
      "the configuration that decides which file lands in which project",
      ["conformance/vitest.config.ts"],
      [
        "quick-checks",
        "workspace",
        ...CONTRACT,
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
      ["quick-checks", "workspace", "mcp-conformance"],
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
      ["quick-checks", "core-native", "image", "rust-contract"],
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
      ["quick-checks", "workspace"],
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
        ...CONTRACT,
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
      ["quick-checks", ...RUST, "version-fields"],
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
    ["a test of CI", ["ci/ci-required.test.ts"], ["quick-checks", "workspace"]],
    [
      "a test of the API document",
      ["ci/openapi/style.test.ts"],
      ["quick-checks", "workspace"],
    ],
    [
      "Markdown a test reads as a fixture",
      ["packages/shared/src/fixtures/note.md"],
      [...PACKAGES, "clients-freshness"],
    ],
    ["a path no rule names", ["tools/new.ts"], [...JOBS]],
    [
      "documentation beside a package change",
      ["README.md", "conformance/spec/blobs.md", "packages/shared/src/x.ts"],
      [...PACKAGES, "clients-freshness"],
    ],
    [
      "Rust beside a client change",
      ["core/marfa-cli/src/main.rs", "packages/client/src/client.ts"],
      [
        "quick-checks",
        "workspace",
        "core-checks",
        "core-checks-linux",
        ...OFFLINE,
        "clients-freshness",
        "core",
        ...RUST_SERVER,
      ],
    ],
    [
      "the Rust server alone",
      ["core/marfa-server/src/lib.rs", "core/marfa-server/tests/config.rs"],
      ["quick-checks", "core-checks-linux", ...RUST_SERVER],
    ],
    [
      "the Rust server's start, which routes memory to jemalloc on a Mac",
      ["core/marfa-server/src/main.rs"],
      ["quick-checks", "core-checks", "core-checks-linux", ...RUST_SERVER],
    ],
    [
      "the Rust server's manifest",
      ["core/marfa-server/Cargo.toml"],
      ["quick-checks", "core-checks-linux", ...RUST_SERVER, "version-fields"],
    ],
    [
      "an icon set the rules crate embeds",
      ["packages/types/generated/icon-set-lucide.json"],
      [...PACKAGES, "types-freshness", "clients-freshness", ...RUST],
    ],
    [
      "the score script",
      ["conformance/scripts/rust-score.ts"],
      ["quick-checks", "workspace", "conformance-offline", "rust-contract"],
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
      expect(runs([path]), path).toContain("rust-contract");
    }
    const packages = tracked().filter(
      (path) => path.startsWith("packages/") && !embedded.includes(path),
    );
    expect(packages.length).toBeGreaterThan(0);
    for (const path of packages) {
      expect(runs([path]), path).not.toContain("rust-contract");
    }
  });

  it("reaches the Rust contract jobs from every file outside core/ that the Rust crates embed", () => {
    // `include_str!` and `include_bytes!` read a file at build time, so a
    // change to it changes the program the jobs judge.
    const outside: string[] = [];
    for (const path of tracked().filter(
      (file) => file.startsWith("core/") && file.endsWith(".rs"),
    )) {
      // Test code is not in the program the jobs judge.
      if (
        /^core\/(marfa-cli|bindings)\//.test(path) ||
        /(^|\/)(tests|benches)\//.test(path) ||
        /(^|\/|_)tests\.rs$/.test(path)
      ) {
        continue;
      }
      const text = readFileSync(join(ROOT, path), "utf8");
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
    // The witness: the scan finds the files, so an empty list is not blindness.
    expect(outside).toContain("openapi.json");
    for (const target of outside) {
      expect(runs([target]), target).toContain("rust-contract");
    }
  });

  it("names every tracked path in a rule, so only a new one runs everything", () => {
    const unnamed = (path: string) =>
      !RULES.some(([pattern]) => pattern.test(path));
    // The witness: a path no rule names reaches every job.
    expect(unnamed("tools/new.ts")).toBe(true);
    expect([...affected("tools/new.ts")].sort()).toEqual([...JOBS].sort());
    expect(tracked().filter(unnamed)).toEqual([]);
  });

  it("treats Markdown as documentation but the contract, package READMEs and the command reference", () => {
    const beyond = (path: string) =>
      [...affected(path)].filter((job) => job !== "quick-checks");
    // The rule fixtures and generated trees fall through on purpose.
    const docs = RULES.find(([pattern]) => pattern.test("README.md"))?.[0];
    expect(docs?.test("packages/shared/src/fixtures/note.md")).toBe(false);
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
        expect(beyond(path), path).toEqual(
          chapter === "errors.md"
            ? [
                "workspace",
                "conformance-offline",
                "core-checks-linux",
                "rust-contract",
              ]
            : chapter === "instance.md" || chapter === "housekeeping.md"
              ? [
                  "workspace",
                  "conformance-offline",
                  "core-checks-linux",
                  "rust-contract",
                ]
              : READ_AT_RUN_TIME.includes(chapter)
                ? ["workspace", "conformance-offline", "rust-contract"]
                : ["workspace", "conformance-offline"],
        );
      } else if (path === "core/marfa-cli/COMMANDS.md") {
        expect(beyond(path), path).toEqual(["core-checks-linux"]);
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
      ["AGENTS.md", "packages/shared/src/runtime.ts"],
      ["packages/client/README.md"],
      ["core/marfa-cli/COMMANDS.md"],
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
    ]);
    for (const chapter of READ_AT_RUN_TIME) {
      expect([...affected(`conformance/spec/${chapter}`)], chapter).toContain(
        "rust-contract",
      );
    }
  });
});

describe("what a draft runs", () => {
  it("runs the quick jobs the diff names, and nothing else", () => {
    expect(DRAFT_JOBS).toEqual([
      "quick-checks",
      "workspace",
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
    const shared = forDraft(classify(["packages/shared/src/runtime.ts"]));
    expect(JOBS.filter((job) => shared[job])).toEqual([
      "quick-checks",
      "workspace",
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
const QUICK_JOBS = ["typecheck", "lint"];
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
  "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.rust-contract != 'false' || needs.changes.outputs.mcp-conformance != 'false' || needs.changes.outputs.restore-drill != 'false') }}";

/** The macOS run of the device and CLI fixtures is for the nightly and a dispatch that asks. */
const macGate =
  "${{ !cancelled() && (github.event_name == 'schedule' || inputs.macos) && (needs.changes.result != 'success' || needs.changes.outputs.rust-contract-macos != 'false') }}";

describe("each job reads its own answer", () => {
  it("ci.yml runs a job only when the classifier says so, and every one when it cannot tell", () => {
    const { jobs } = workflow("ci.yml");
    const gated = Object.keys(jobs).filter(
      (name) => name !== "changes" && !NOT_CLASSIFIED.includes(name),
    );
    expect(gated.sort()).toEqual(
      JOBS.filter(
        (job) => job !== "workspace" && job !== "swift-package",
      ).sort(),
    );
    expect(jobs.changes?.outputs).toEqual(
      Object.fromEntries(
        [...JOBS, "full"].map((job) => [
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

  it("Typecheck and Lint are jobs of their own, for the workspace, so that a failure of either is known in minutes", () => {
    const { jobs } = workflow("ci.yml");
    for (const [name, command] of [
      ["typecheck", "pnpm typecheck"],
      ["lint", "pnpm lint"],
    ] as const) {
      const job = jobs[name];
      expect(job?.needs, name).toBe("changes");
      expect(job?.if, name).toBe(gate("workspace"));
      expect(
        (job?.steps ?? []).map((step) => step.run ?? step.uses),
        name,
      ).toEqual([
        "actions/checkout@v7",
        "pnpm/action-setup@v6",
        "actions/setup-node@v7",
        "pnpm install --frozen-lockfile",
        "pnpm build",
        command,
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
    const toolchain = steps.find((step) =>
      step.uses?.startsWith("dtolnay/rust-toolchain"),
    );
    for (const target of [
      "aarch64-apple-darwin",
      "aarch64-apple-ios",
      "aarch64-apple-ios-sim",
    ]) {
      expect(String(toolchain?.with?.targets)).toContain(target);
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
      "packages/shared/src/runtime.ts",
      "core/marfa-core/src/lib.rs",
      "core/Cargo.toml",
      "openapi.json",
    ]) {
      expect(skips(path), path).toBe(false);
    }
  });
});

describe("what a job reads reaches it", () => {
  it("every file the CLI fixtures load runs the Rust contract", async () => {
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
    expect(files.filter((f) => !affected(f).has("rust-contract"))).toEqual([]);
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
    ]);
    expect(files).toContain("conformance/src/utils/target.ts");
    const read = [...files, "conformance/package.json", "pnpm-lock.yaml"];
    expect(read.filter((f) => !affected(f).has("mcp-conformance"))).toEqual([]);
  });

  it("the cached device binary is keyed on every crate it is built from", () => {
    const manifest = (crate: string) =>
      parseToml(
        readFileSync(join(ROOT, "core", crate, "Cargo.toml"), "utf8"),
      ) as {
        dependencies?: Record<string, { path?: string; workspace?: boolean }>;
      };
    const workspace = (
      parseToml(readFileSync(join(ROOT, "core", "Cargo.toml"), "utf8")) as {
        workspace: { dependencies: Record<string, { path?: string }> };
      }
    ).workspace.dependencies;
    const crates = new Set<string>();
    const pending = ["marfa-cli"];
    for (
      let crate = pending.pop();
      crate !== undefined;
      crate = pending.pop()
    ) {
      if (crates.has(crate)) continue;
      crates.add(crate);
      for (const [name, dep] of Object.entries(
        manifest(crate).dependencies ?? {},
      )) {
        // A workspace dependency's path is the workspace root's, not the crate's.
        const path =
          dep.workspace === true
            ? workspace[name]?.path
            : dep.path && join(crate, dep.path);
        if (path) {
          pending.push(
            relative(join(ROOT, "core"), resolve(ROOT, "core", path)),
          );
        }
      }
    }
    expect([...crates].sort()).toEqual([
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
          affected(`core/${crate}/src/lib.rs`).has("rust-contract"),
          crate,
        ).toBe(true);
      }
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
        affected(source).has("rust-contract"),
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

describe("the classifier as CI runs it", () => {
  const script = resolve(ROOT, "scripts/ci-required.ts");
  const directory = mkdtempSync(join(tmpdir(), "marfa-ci-paths-"));
  // Stands in for `gh` on PATH: it records each call and prints `response`,
  // or fails when there is none.
  const fake = mkdtempSync(join(tmpdir(), "marfa-ci-gh-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const commits: Record<string, string> = {};

  function commit(name: string, files: Record<string, string>) {
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
      "packages/shared/src/runtime.ts": "export const v = 1;\n",
    });
    commit("docs", { "deploy/README.md": "Words\n" });
    commit("server", {
      "packages/shared/src/runtime.ts": "export const v = 2;\n",
    });
    git("mv", "packages/shared/src/runtime.ts", "packages/shared/README.md");
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

  const every = (value: string) => ({
    ...Object.fromEntries(JOBS.map((job) => [job, value])),
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
      JOBS.filter((job) => [...PACKAGES, "clients-freshness"].includes(job)),
    );
    const fixture = outputs(
      "pull_request",
      commits.noted ?? "",
      commits.fixture ?? "",
    );
    expect(JOBS.filter((job) => fixture[job] === "true")).toEqual(
      JOBS.filter((job) =>
        ["quick-checks", "workspace", ...CONTRACT].includes(job),
      ),
    );
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
    expect(quick(server)).toEqual(["quick-checks", "workspace"]);
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
      JOBS.filter((job) => [...PACKAGES, "clients-freshness"].includes(job)),
    );
    expect(ready.full).toBe("true");
    expect(
      outputs("pull_request", "invalid", commits.docs ?? "", true),
    ).toMatchObject({
      "quick-checks": "true",
      "rust-contract": "false",
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
