/**
 * Which CI jobs a change can affect.
 *
 * Each job in `ci.yml` runs when this answers `true` for it and is skipped
 * otherwise, and a skipped job satisfies a required check where a workflow
 * filtered out by `paths` would leave it pending. `core` is the job that
 * calls `core-live.yml`. `Full CI`, the gate job of `ci.yml`, waits for the
 * rest and is what a ruleset requires. A dispatch answers `true` for every
 * job, and so does a change that could not be read, so a skip only ever
 * comes from a diff that was read and classified. The nightly runs only
 * `NIGHTLY_JOBS`, the ones that need a Mac.
 *
 * A push to `main` runs every job too, unless `forPush` finds that it
 * changes only what no job but the format check reads and that this
 * workflow passed on the commit before it. `release.yml` releases a commit
 * only once `ci.yml` passed on it, so a skipped run may pass only when the
 * code it vouches for is code that passed.
 *
 * A draft pull request runs only the quick jobs, `DRAFT_JOBS`, and `full`
 * says whether the rest runs: it is `false` only for a draft. Marking the
 * pull request ready for review starts a run that does, and so does every
 * push after.
 *
 * The Rust contract's shards are the one job that is a list. `SHARDS` holds
 * them, `rust-contract-server` and `rust-contract-device` say which group
 * runs, and the answer also carries the matrix of the shards that run and
 * the projects they cover, which the score judges, so that a project is
 * judged if and only if its shards ran.
 *
 * A path is matched against `RULES` in order and the first match names the
 * jobs it can affect. `Lint` is not in `RULES`: `affected` adds it for the
 * files ESLint reads. A path no rule matches affects every job, so a new
 * folder runs everything until someone states what reads it.
 * `ci/ci-required.test.ts` pins the rules.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/** Each output, named for the job that reads it. */
export const JOBS = [
  // `Quick checks`. It runs the format check, this classifier's test and the
  // contract's reference check for any change. `workspace` is the build,
  // typecheck and `Workspace tests`, which run unless the pull request is a
  // draft.
  "quick-checks",
  "workspace",
  // `Lint`: ESLint over the files its config does not ignore, and over the
  // types they import from the files it does (`lintReads`).
  "lint",
  // `Core checks`, on macOS: the core's format, lint and tests, the login
  // keychain check and the Swift crate.
  "core-checks",
  // `Core checks`' last step: `core/bindings/swift/build.sh`, the script
  // marfa-swift runs at the commit it pins. It reads the Swift crate whole,
  // since a dependency bump or an edit to the crate can stop it generating
  // the glue, and nothing else in the core can.
  "swift-package",
  // `Core checks (Linux)`: the same for the core workspace on Ubuntu, where
  // the non-macOS credential store and the test keychain it uses are built.
  // It reads what `core-checks` reads but the Swift crate.
  "core-checks-linux",
  // `Rust dependencies`: `cargo deny check` over the core workspace and the
  // Swift crate. It reads the lockfiles, the manifests and `core/deny.toml`
  // (`readsDependencies`).
  "core-deny",
  // `Core native (x86_64 Linux)`: `marfa-enrichment`'s PDF and OCR readers,
  // built from pinned sources by `native/release.sh` and checked on real
  // x86_64 hardware, where a child that cannot confine itself reads nothing.
  "core-native",
  // `Core fault injection (Linux)`: the tests of `marfa-enrichment` built with
  // `fault-injection`, which make a child crash, hang and misbehave. `Core
  // checks` runs the same tests on macOS, where the sandbox is other code.
  "core-fault-injection",
  // The contract's offline lane, which needs no server. `Conformance`
  // collects it and MCP conformance into one verdict.
  "conformance-offline",
  // The contract run against the Rust server (`core/marfa-server/`), in two
  // groups of shards that share one build of the server and one score. The
  // server's own: the fixtures of the compliance, correctness and sync
  // projects. It reads what the server is built from, the fixtures it runs
  // and the meter.
  "rust-contract-server",
  // The device's: the `cli` and `device` fixtures, which boot that same server
  // and drive the `marfa` binary and the Node module against it. It reads what
  // those are built from (`core/marfa-core/`, `core/marfa-cli/` and the Node
  // binding) and everything the server group reads, since the server is under
  // it. The server does not depend on any of them, so a change to only them
  // leaves the server group out.
  "rust-contract-device",
  // The server a release ships, built without its test hooks
  // (`Rust server without test hooks`), and the one compliance fixture that
  // boots it (`Rust contract (server without test hooks)`). They read what the
  // server is built from, that fixture and what it loads, and the harness that
  // boots a server. Any other fixture of the server group runs against the
  // build with the hooks and never reads this one.
  "rust-contract-release",
  // The device and CLI fixtures against the Rust server on macOS, for file
  // watching, name case, Finder packages and a real keychain: one build, the
  // shards after it and their score. Only the nightly and a dispatch with
  // `macos` run it.
  "rust-contract-macos",
  // The MCP project's conformance tool, against `/mcp` on the Rust server's
  // build, and the restore drill, which throws a Rust server away and restores
  // it from its bucket. Both read what the server is built from and nothing
  // the device is.
  "mcp-conformance",
  "restore-drill",
  // The image job builds and boots the shipped image from the release programs.
  "image",
  "types-freshness",
  "version-fields",
  "clients-freshness",
  // `core-live.yml`, on macOS, which `ci.yml` calls for a pull request. It
  // boots the Rust server, but a pull request that changes only the server
  // leaves it to the push to `main`, where `core.yml` runs it.
  "core",
] as const;

export type Job = (typeof JOBS)[number];

const ALL: readonly Job[] = JOBS;

/** The shards of the server's own projects, and what builds the server they boot. */
const SERVER_SHARDS: readonly Job[] = ["rust-contract-server"];

/** The shards of the `cli` and `device` projects. */
const DEVICE_SHARDS: readonly Job[] = ["rust-contract-device"];

/** The build without test hooks and the fixture that boots it. */
const RELEASE: Job = "rust-contract-release";

/** Every shard of the Rust contract, which one score judges. */
const CONTRACT_SHARDS: readonly Job[] = [...SERVER_SHARDS, ...DEVICE_SHARDS];

/**
 * Every job a change to what the server is built from reaches: both groups
 * of shards, since the device's boot the server, the build without test hooks
 * and its fixture, MCP conformance and the restore drill. A change to the
 * `marfa` binary or the Node module reaches only `DEVICE_SHARDS`.
 */
const RUST_SERVER: readonly Job[] = [
  ...CONTRACT_SHARDS,
  "rust-contract-release",
  "mcp-conformance",
  "restore-drill",
];

/**
 * Every job that builds the Rust crates and runs on Linux, and the core's own
 * checks there. A path in the core that no rule names can be read by any of
 * them, so it reaches all.
 */
const RUST_LINUX: readonly Job[] = [
  "core-checks-linux",
  "conformance-offline",
  ...RUST_SERVER,
];

/**
 * What a change to the device alone, `marfa-core`, `marfa-cli` and the Node
 * module, reaches on Linux. `marfa-server` depends on none of the three, so
 * the server's shards, MCP conformance and the restore drill have nothing to
 * judge in it. The offline lane reads every file in `core/` for the contract
 * statements it cites.
 */
const DEVICE_LINUX: readonly Job[] = [
  "core-checks-linux",
  "conformance-offline",
  ...DEVICE_SHARDS,
];

/**
 * The jobs that read `marfa-enrichment`'s source: the fault-injection tests
 * and the native build, which links the crate with PDFium and Tesseract and
 * runs the checks of `native/verify.sh` on it.
 */
const ENRICHMENT: readonly Job[] = ["core-native", "core-fault-injection"];

/**
 * The jobs that run the fixtures: the offline lane, which holds the citations
 * to them, and the Rust contract jobs.
 */
const CONTRACT: readonly Job[] = ["conformance-offline", ...CONTRACT_SHARDS];

/** What a change to a helper the fixtures import reaches before any other job does. */
const FIXTURES: readonly Job[] = ["workspace", ...CONTRACT];

/**
 * The jobs that run on macOS for a pull request: the core's checks and its
 * live checks. Linux builds, lints and tests the same Rust, so a pull request
 * runs these only for a path that has a macOS-only part (`RULES` names them);
 * a push to `main`, the nightly and a dispatch run `core-checks` whatever
 * changed, and `core.yml`, not this workflow, runs the live checks for a push
 * to `main` and every night.
 */
const MACOS: readonly Job[] = ["core-checks", "core"];

/** Every job a change to the core's manifests or to a macOS-only part can reach. */
const RUST: readonly Job[] = [...RUST_LINUX, ...MACOS];

/** What a change to a macOS-only part of the device alone reaches. */
const DEVICE: readonly Job[] = [...DEVICE_LINUX, ...MACOS];

/** Every job that installs or builds the pnpm workspace, but `core`. */
const WORKSPACE: readonly Job[] = [
  "workspace",
  ...CONTRACT,
  "rust-contract-release",
  "mcp-conformance",
  "restore-drill",
  "types-freshness",
  "version-fields",
  "clients-freshness",
];

/**
 * First match wins. The format check, the version check and lint are added
 * on top by `affected`, since they read files whatever else reads them. The
 * jobs of the workspace (`workspace`) run for a path ESLint lints too.
 */
export const RULES: readonly (readonly [RegExp, readonly Job[]])[] = [
  // What decides what runs is proven on everything it decides.
  [/^scripts\/ci-required\.ts$/, ALL],
  // It defines every job it runs, the call of `core-live.yml` among them.
  [/^\.github\/workflows\/ci\.yml$/, ALL],
  [/^\.github\/workflows\/core-live\.yml$/, ["workspace", "core"]],
  // `ci/` tests read every workflow. `core.yml` only calls the one above,
  // for a push to `main`, and no pull request runs it.
  [/^\.github\/workflows\//, ["workspace"]],
  // The action the three Linux build jobs use to get the native build image
  // (`release.yml` uses it too, and no pull request runs that).
  [
    /^\.github\/actions\/native-build-image\//,
    ["core-native", "image", ...RUST_SERVER],
  ],
  // The action every Rust job uses to install the compiler, which runs for
  // the jobs that read the compiler version.
  [
    /^\.github\/actions\/rust-toolchain\//,
    [...RUST, ...ENRICHMENT, "image", "version-fields"],
  ],
  // Read by GitHub alone. Anything else under `.github/`, such as an action
  // a workflow uses, runs everything until a rule names it.
  [/^\.github\/(ISSUE_TEMPLATE\/|dependabot\.yml$)/, []],
  // Checkout applies it to every file every job reads.
  [/^\.gitattributes$/, ALL],

  // The contract's statements are cited by ID and checked by the offline
  // lane, and the error code census test holds `errors.md` to the codes the
  // server sends. Three chapters are also read by a fixture while it runs:
  // `compliance/error-codes.test.ts` holds every refusal's code to the error
  // table, `compliance/instance.test.ts` holds the published operations to
  // the coverage table, and `device/error-codes.test.ts` holds the device's
  // codes to the table in `device.md`, so each reaches the group of shards
  // that fixture is in. No other server fixture reads the contract, and
  // `ci/ci-required.test.ts` fails when one starts to. A unit test of the Rust
  // server holds its refusal codes to `errors.md`, three more hold its
  // settings to the tables of `instance.md`, and one holds its jobs to the
  // table of `housekeeping.md`, so those chapters reach the core's checks.
  // The program embeds none of them (`ci/ci-required.test.ts` holds what it
  // embeds to the shards).
  [
    /^conformance\/spec\/errors\.md$/,
    ["workspace", "conformance-offline", "core-checks-linux", ...SERVER_SHARDS],
  ],
  [
    /^conformance\/spec\/coverage\.md$/,
    ["workspace", "conformance-offline", ...SERVER_SHARDS],
  ],
  [
    /^conformance\/spec\/device\.md$/,
    ["workspace", "conformance-offline", ...DEVICE_SHARDS],
  ],
  [
    /^conformance\/spec\/(instance|housekeeping)\.md$/,
    ["workspace", "conformance-offline", "core-checks-linux"],
  ],
  [/^conformance\/spec\//, ["workspace", "conformance-offline"]],
  // The item names and previews the core is held to: its unit tests and the
  // compliance and device fixtures read it.
  [
    /^conformance\/fixtures\/item-display\.json$/,
    ["core-checks-linux", "conformance-offline", ...CONTRACT_SHARDS],
  ],
  // The filter expressions the core is held to: its unit tests and the Node
  // binding's tests read it.
  [
    /^conformance\/fixtures\/filter-expressions\.json$/,
    ["core-checks-linux", "core"],
  ],
  // The name fold the core is held to: its unit tests and the compliance
  // fixture for title lookups read it.
  [
    /^conformance\/fixtures\/name-fold\.json$/,
    ["core-checks-linux", ...SERVER_SHARDS],
  ],
  // The binary's command reference is generated from its command tree, and
  // a unit test in `marfa-cli` holds the committed file to it. Only the core
  // checks run the Rust tests.
  [/^core\/marfa-cli\/COMMANDS\.md$/, ["core-checks-linux"]],
  // A unit test in `marfa-cli` holds the telemetry page to the variables the
  // binary reads.
  [/^core\/TELEMETRY\.md$/, ["core-checks-linux"]],
  // `ci/access-words.test.ts` holds the glossary's access words to the CLI's
  // and the server's.
  [/^GLOSSARY\.md$/, ["workspace"]],
  // Markdown anywhere else is read only by Prettier and the contract's
  // reference check, which `Quick checks` runs for every change, and a
  // package's README by the version check. A fixture is test input and a
  // generated tree is checked file by file, so those fall through to their
  // folder's rule.
  [
    /^(?!(.*\/)?(fixtures|__fixtures__|testdata)\/)(?!packages\/types\/generated\/|packages\/client\/src\/generated\/).*\.md$/i,
    [],
  ],
  // `ci/env-example.test.ts` holds it to the contract's settings table.
  [/^\.env\.example$/, ["workspace"]],
  [/^LICENSE$/, []],
  // The README's images, which only GitHub reads.
  [/^assets\//, []],
  // Agent instructions, settings and Git hooks. No job runs or reads them.
  [/^\.(agents|claude|codex|githooks)\//, []],

  // The Dockerfile is the image; `ci/test-hooks-release.test.ts` reads it.
  [/^deploy\/Dockerfile$/, ["workspace", "image"]],
  [/^deploy\//, []],

  // The rules crate embeds the icon sets, so every build of the core, the
  // command line, the server and the image reads them.
  [
    /^packages\/types\/generated\/icon-set-[\w-]+\.json$/,
    [
      "workspace",
      "conformance-offline",
      "types-freshness",
      "clients-freshness",
      ...RUST,
    ],
  ],
  // The rules crate's tests read each shipped definition and hold it to the
  // rules for a registered type.
  [
    /^packages\/types\/core\/.*\.json$/,
    [
      "workspace",
      "conformance-offline",
      "types-freshness",
      "clients-freshness",
      "core-checks-linux",
    ],
  ],
  // The core's catalog is written from the shipped types.
  [
    /^packages\/types\//,
    [
      "workspace",
      "conformance-offline",
      "types-freshness",
      "clients-freshness",
    ],
  ],
  [/^packages\/client\//, ["workspace", "clients-freshness"]],

  [/^conformance\/scripts\/restore-drill\.ts$/, ["workspace", "restore-drill"]],
  [
    /^conformance\/scripts\/mcp-conformance\.ts$/,
    ["workspace", "mcp-conformance"],
  ],
  // The score of the Rust contract run, whose test the offline lane runs. It
  // judges the report of the build without test hooks too.
  [
    /^conformance\/scripts\/rust-score\.ts$/,
    ["workspace", "conformance-offline", ...CONTRACT_SHARDS, RELEASE],
  ],
  // Spec citations name fixture files anywhere under `src/`, so every
  // change there reaches the offline lane.
  // Off the gate: `benchmarks.yml` runs them.
  [
    /^conformance\/src\/suites\/(load|performance|hydration)\//,
    ["workspace", "conformance-offline"],
  ],
  // The fixtures of the server's own projects, which run in the server's
  // shards, and those of the device projects with the adapters and scripted
  // server they drive, which run in the device's. The offline lane tests
  // them all. A fixture of either that imports from the other, or a folder
  // no rule names, reaches both (`ci/ci-required.test.ts` follows the imports).
  // The one fixture that boots the build without test hooks, which no shard
  // runs (`RUN_APART`).
  [
    /^conformance\/src\/suites\/compliance\/hook-free-server\.test\.ts$/,
    ["workspace", "conformance-offline", ...SERVER_SHARDS, RELEASE],
  ],
  [
    /^conformance\/src\/suites\/(compliance|correctness|sync)\//,
    ["workspace", "conformance-offline", ...SERVER_SHARDS],
  ],
  [
    /^conformance\/src\/(suites\/(cli|device)|device)\//,
    ["workspace", "conformance-offline", ...DEVICE_SHARDS],
  ],
  [/^conformance\/src\/suites\//, ["workspace", ...CONTRACT]],
  // The nightly scale benchmark's figures, comparison and driver. Only
  // `benchmarks.yml` runs the driver; the offline lane tests the figures.
  [
    /^conformance\/(src\/utils|scripts)\/scale\//,
    ["workspace", "conformance-offline"],
  ],
  // A harness test boots servers from the release build: the `harness`
  // project, which `MCP conformance` runs.
  [
    /^conformance\/src\/utils\/(.*\/)?[^/]*\.harness\.test\.ts$/,
    ["workspace", "mcp-conformance"],
  ],
  // Any other test beside the helpers runs in the offline lane alone: the
  // `generators` project's `src/utils/**/*.test.ts`. No server fixture imports
  // a test.
  [
    /^conformance\/src\/utils\/(.*\/)?[^/]*\.test\.ts$/,
    ["workspace", "conformance-offline"],
  ],
  // A helper reaches the fixtures that import it and, of the jobs that run a
  // script or a harness test instead of a fixture, those whose files import it,
  // through any number of modules: the restore drill's scripts, the harness
  // tests and scripts of MCP conformance, and the build without test hooks'
  // fixture with what boots and scores it. `ci/ci-required.test.ts` derives
  // each set from the import graph and fails when a helper is in the wrong
  // rule, so a new import moves a helper here.
  [
    /^conformance\/src\/utils\/(approval-form|control-request|fresh-server|server-process|target|temp-folder)\.ts$/,
    [...FIXTURES, "restore-drill", "mcp-conformance", RELEASE],
  ],
  [
    /^conformance\/src\/utils\/archive\.ts$/,
    [...FIXTURES, "restore-drill", RELEASE],
  ],
  [/^conformance\/src\/utils\/drill\.ts$/, [...FIXTURES, "restore-drill"]],
  [
    /^conformance\/src\/utils\/shard-(sequencer|weights)\.ts$/,
    [...FIXTURES, "mcp-conformance", RELEASE],
  ],
  [
    /^conformance\/src\/utils\/(moved-clock|status-declarations|tuning)\.ts$/,
    [...FIXTURES, "mcp-conformance"],
  ],
  [
    /^conformance\/src\/utils\/(platform|fresh-server-teardown|temp-folder-teardown|rust-score)\.ts$/,
    [...FIXTURES, RELEASE],
  ],
  [/^conformance\/src\/utils\//, FIXTURES],
  // The typed client and the owner's sign-in, which every one of those jobs
  // loads.
  [
    /^conformance\/src\/client\//,
    [...FIXTURES, "restore-drill", "mcp-conformance", RELEASE],
  ],
  [/^conformance\/src\//, ["workspace", ...CONTRACT]],
  [
    /^conformance\//,
    ["workspace", ...CONTRACT, RELEASE, "restore-drill", "mcp-conformance"],
  ],

  // `ci/` tests read the contract version the core is generated with, the
  // workspace manifest, the runner and test budgets, and the Swift crate's
  // budget.
  [
    /^core\/marfa-rules\/src\/(builtin_catalog\.json|contract\.rs)$/,
    [...RUST_LINUX, "core", "clients-freshness", "workspace"],
  ],
  [/^core\/Cargo\.toml$/, [...RUST, ...ENRICHMENT, "image", "workspace"]],
  // The lockfile and the compiler version: a new dependency or a new compiler
  // can break an Apple build. `version-fields` installs the compiler too.
  [
    /^core\/(Cargo\.lock|rust-toolchain\.toml)$/,
    [...RUST, ...ENRICHMENT, "image", "version-fields"],
  ],
  [/^core\/\.cargo\//, [...RUST, ...ENRICHMENT, "image", "workspace"]],
  [
    /^core\/\.config\//,
    [
      "core-checks",
      "core-checks-linux",
      "core-fault-injection",
      "core",
      "workspace",
    ],
  ],
  // It can hide a file the client generator writes from the freshness
  // check's `git status`.
  [/^core\/\.gitignore$/, ["clients-freshness"]],
  [
    /^core\/scripts\/test-limits\.sh$/,
    [
      "core-checks",
      "core-checks-linux",
      "core-fault-injection",
      "core",
      "workspace",
    ],
  ],
  // Only the live tests boot a server.
  [/^core\/scripts\/(server-up|server-down|seed|binding-proof)\.sh$/, ["core"]],
  [/^core\/scripts\//, ["core-checks", "core-checks-linux", "core"]],
  [
    /^core\/bindings\/swift\/(Cargo\.toml|\.config\/)/,
    ["core-checks", "core", "workspace", "swift-package"],
  ],
  // The Linux job checks the core workspace and not the Swift crate, which
  // is a workspace of its own.
  [/^core\/bindings\/swift\//, ["core-checks", "core", "swift-package"]],
  // The Node module's JavaScript side is built and tested only by the live job.
  [/^core\/bindings\/node\/(test|scripts)\//, ["core"]],
  // The device fixtures drive a debug build of the module, which `napi build`
  // makes from the manifest and the lockfile that pins the command, and from
  // the crate.
  [
    /^core\/bindings\/node\/(package\.json|pnpm-lock\.yaml)$/,
    ["core", ...DEVICE_SHARDS],
  ],
  [/^core\/bindings\/node\/(index\.js|index\.d\.ts|tsconfig\.json)$/, ["core"]],
  [
    /^core\/bindings\/node\/(src\/|Cargo\.toml$|build\.rs$)/,
    ["core-checks", "core-checks-linux", "core", ...DEVICE_SHARDS],
  ],
  [/^core\/bindings\//, ["core-checks", "core-checks-linux", "core"]],
  // `marfa-enrichment`. The scripts, pins, patches and the C++ shim that build
  // its native readers are read by the native job, by the image, which builds
  // the release programs with them, and by the Rust contract build, which links
  // the server with them: nothing else compiles or runs them.
  [
    /^core\/marfa-enrichment\/native\//,
    ["core-native", "image", ...RUST_SERVER],
  ],
  // Its sandbox is Landlock and seccomp on Linux and `sandbox_init` on macOS,
  // and its memory watch reads each system's own counter, so the source of
  // the isolation, the tests and the build script run on a Mac as well. A
  // change to the manifest is covered too: a dependency can break an Apple
  // build.
  [
    /^core\/marfa-enrichment\/(src\/isolated\/|tests\/|build\.rs$|Cargo\.toml$)/,
    [...RUST, ...ENRICHMENT],
  ],
  // The rest of its source, its fixtures and its README are pure Rust, read
  // the same on every system, and so Linux vouches for them.
  [/^core\/marfa-enrichment\//, [...RUST_LINUX, ...ENRICHMENT]],
  // The ACL reading both the command line and the Rust server's private
  // socket use has macOS-only code, so a Mac builds and tests it too.
  [/^core\/marfa-acl\//, RUST],
  // The allocator is jemalloc only on macOS, where the command line and the
  // server use it.
  [/^core\/marfa-allocator\//, RUST],
  // The server's own use of it has a macOS-only test, its start routes memory
  // to jemalloc on a Mac only, and its process figures read the resident size,
  // and the open-file limit is raised, through macOS-only calls, as are the
  // folders on the way to the server's data.
  [
    /^core\/marfa-server\/src\/(main|control_socket|app\/metrics|open_files|private_files)\.rs$/,
    ["core-checks", "core-checks-linux", ...RUST_SERVER],
  ],
  // A background read lowers its thread's priority each system's own way.
  [
    /^core\/marfa-server\/src\/db\/reader\.rs$/,
    ["core-checks", "core-checks-linux", ...RUST_SERVER],
  ],
  // A backup folder file's stamp takes its birth time, which only a Mac's
  // test can set.
  [
    /^core\/marfa-server\/src\/app\/blobs\/folder\.rs$/,
    ["core-checks", "core-checks-linux", ...RUST_SERVER],
  ],
  // The settings are what the Dockerfile's environment names.
  [
    /^core\/marfa-server\/src\/settings\//,
    ["core-checks-linux", ...RUST_SERVER, "image"],
  ],
  // The approval pages' access words, which `ci/access-words.test.ts` holds
  // to the glossary.
  [
    /^core\/marfa-server\/src\/http\/pages\/words\.rs$/,
    ["workspace", "core-checks-linux", ...RUST_SERVER],
  ],
  // The list of routes the server serves and does not publish, which
  // `conformance/src/utils/coverage-unpublished.test.ts` reads.
  [
    /^core\/marfa-server\/src\/http\/document\.rs$/,
    ["core-checks-linux", "conformance-offline", ...RUST_SERVER],
  ],
  // The rest of the server is built and tested on Linux, and its contract is
  // run by the Rust contract jobs, with the real `marfa` binary, and by MCP
  // conformance and the restore drill; the live
  // job on macOS boots it too but waits for the push to `main`.
  // Its integration tests are the exception: `cargo build` makes the program
  // from `src/` and the manifest, so only the core's own checks run them.
  [/^core\/marfa-server\/tests\//, ["core-checks-linux"]],
  [/^core\/marfa-server\//, ["core-checks-linux", ...RUST_SERVER]],
  // A crate's tests are not in the binary, but they may exercise a macOS-only
  // side (a keychain, a watched folder) that nothing here names, so a Mac
  // runs them too.
  [/^core\/[^/]+\/tests\//, ["core-checks", "core-checks-linux", "core"]],
  // Every crate's manifest: a dependency bump or a macOS-only dependency
  // (`core-foundation`, `xattr`) can break an Apple build.
  [/^core\/[^/]+\/Cargo\.toml$/, RUST],
  // The CLI's access words, which `ci/access-words.test.ts` holds to the
  // glossary.
  [/^core\/marfa-cli\/src\/access\.rs$/, [...DEVICE, "workspace"]],
  // The parts of the device with a macOS-only side, which only a Mac runs: the
  // command line, with its login keychain, key files by path and launchd
  // autostart, and the core's folder watching and what it reads and writes,
  // which FSEvents, name case and Finder packages change, and the files with
  // an Apple-only `cfg` block. `ci/ci-required.test.ts` searches `core/` for
  // `target_os = "macos"`, `"ios"` and `target_vendor = "apple"` and requires
  // every file it finds here. `marfa-server` depends on neither crate, so the
  // server's shards, MCP conformance and the restore drill have nothing to
  // judge in them.
  [
    /^core\/(marfa-cli\/|marfa-core\/src\/(folder\/|watch\.rs$|file_cache\.rs$|lock\.rs$|priority\.rs$|blob\.rs$|lib\.rs$|stop_tests\.rs$|damage_tests\.rs$|directory[^/]*$))/,
    DEVICE,
  ],
  // The core's other source is what the live tests (`tests/live*.rs`) run
  // against, and only the `core` job runs them, so it stays on a pull
  // request.
  [/^core\/marfa-core\/src\//, [...DEVICE_LINUX, "core"]],
  // The core and the command line are built from the rules crate, so it
  // reaches what they do.
  [/^core\/marfa-rules\/src\//, [...RUST_LINUX, "core"]],
  // Any other crate can be one the binary is built from, and Linux builds,
  // lints and tests the rest of the core's Rust, but not the live tests.
  [/^core\//, RUST_LINUX],

  // The document's own tests (`ci/openapi/`), the Rust server's route test,
  // the server's contract fixtures, the clients and the offline lane all
  // read the committed document, and the server embeds it, so every job that
  // boots the server reads it too.
  [
    /^openapi\.json$/,
    [
      "workspace",
      "core-checks-linux",
      ...CONTRACT,
      RELEASE,
      "mcp-conformance",
      "restore-drill",
      "image",
      "clients-freshness",
    ],
  ],

  [/^scripts\/check-image\.sh$/, ["workspace", "image"]],
  // The release builds the programs with it, and the image job runs it.
  [/^scripts\/release\/build-programs\.sh$/, ["workspace", "image"]],
  [/^ci\//, ["workspace"]],
  [
    /^scripts\/generate-core-(contract|catalog)\.ts$/,
    ["workspace", "clients-freshness"],
  ],
  [/^scripts\//, ["workspace"]],

  [
    /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json)$/,
    WORKSPACE,
  ],
  [/^eslint\.config\.js$/, ["workspace"]],
  [/^vitest\.config\.ts$/, ["workspace", "version-fields"]],
  // The conformance config and its server script import it too.
  [
    /^vitest\.(shared|flaky-reporter)\.ts$/,
    [
      "workspace",
      "version-fields",
      ...CONTRACT,
      RELEASE,
      "restore-drill",
      "mcp-conformance",
    ],
  ],
  // Prettier skips what Git ignores, and a freshness check that asks
  // `git status` cannot see an ignored file.
  [/^\.gitignore$/, ["workspace", "types-freshness", "clients-freshness"]],
  [/^\.prettierignore$/, []],
];

/**
 * What `eslint.config.js` ignores, by path from the root. `ci/ci-required.test.ts`
 * holds it to the config's own `ignores`.
 */
export const ESLINT_IGNORED =
  /^(core|conformance)\/|^packages\/client\/src\/generated\/|(^|\/)(dist|coverage|node_modules|_local|_tmp|_ignore)\/|^\.claude\/worktrees\//;

/** What `eslint .` reads: JavaScript and TypeScript outside its ignores. */
function linted(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path) && !ESLINT_IGNORED.test(path);
}

/**
 * The manifests and compiler settings that decide how ESLint resolves and
 * types the files it reads, and the lockfile that fixes its version.
 */
const LINT_SETTINGS =
  /(^|\/)(package\.json|tsconfig[^/]*\.json)$|^(pnpm-lock|pnpm-workspace)\.yaml$/;

/**
 * The files that ESLint does not lint but reads, because a file it lints
 * imports them and its rules are typed. `ci/ci-required.test.ts` derives them
 * from the import graph and fails when this list is not exactly them.
 */
const LINT_IMPORTED =
  /^(conformance\/(vitest\.config\.ts|scripts\/(catalogue-sources|mcp-conformance)\.ts|src\/utils\/(catalogue-tables|rust-score|shard-sequencer|shard-weights|target|temp-folder)\.ts)|packages\/client\/src\/generated\/.+|packages\/types\/generated\/icon-set-[\w-]+\.json)$/;

/** Whether a change to the path can change what `Lint` reports. */
function lintReads(path: string): boolean {
  if (path.startsWith("core/")) return false;
  if (LINT_SETTINGS.test(path)) return true;
  return linted(path) || LINT_IMPORTED.test(path);
}

/**
 * What `ci/version-fields.test.ts` reads. Every README inside a package or
 * crate is counted, a superset of the published ones it reads, because
 * which are published is decided by their manifests.
 */
function versioned(path: string): boolean {
  return (
    ["package.json", "Cargo.toml", "Cargo.lock"].includes(basename(path)) ||
    /^(packages|core)\/.+\/README[^/]*$/i.test(path) ||
    path === "core/marfa-rules/src/contract.rs" ||
    path === "ci/version-fields.test.ts"
  );
}

/**
 * What `cargo deny check` reads: each lockfile and manifest, the policy and the
 * compiler version `cargo metadata` runs under.
 */
function readsDependencies(path: string): boolean {
  return /^core\/(deny\.toml|rust-toolchain\.toml|(bindings\/(node|swift)\/|[^/]+\/)?Cargo\.(toml|lock))$/.test(
    path,
  );
}

/**
 * What a draft pull request runs, of what its diff names: the format check,
 * the build and typecheck, lint, the type registry and the version check.
 * The tests, the server and the core, the contract and the clients wait
 * until it is ready for review.
 */
export const DRAFT_JOBS: readonly Job[] = [
  "quick-checks",
  "workspace",
  "lint",
  "types-freshness",
  "version-fields",
];

/**
 * The shards of the Rust contract. `Rust contract shard` runs the ones whose
 * group `classify` answered `true` for, as the matrix `changes` hands it,
 * and `Rust contract score` judges the projects of exactly those, so a group
 * that does not run is not judged and one that runs and writes no report
 * fails.
 */
export interface Shard {
  name: string;
  slug: string;
  /** The Vitest arguments that pick the shard's files. */
  args: string;
  /** The group of shards that runs it, and the `JOBS` answer that decides it. */
  lane: "rust-contract-server" | "rust-contract-device";
  /** Whether it drives the `marfa` binary, so builds or restores it. */
  binary: boolean;
  /** Whether it drives the Node module, so builds or restores it. */
  module: boolean;
  /** Whether it holds every status the server drew to its declaration. */
  statuses: boolean;
}

const split = (
  project: string,
  count: number,
  lane: Shard["lane"],
  rest: Pick<Shard, "binary" | "module"> & Partial<Pick<Shard, "statuses">>,
): Shard[] =>
  Array.from({ length: count }, (_, i) => ({
    name: `${project} ${String(i + 1)}/${String(count)}`,
    slug: `${project}-${String(i + 1)}`,
    args: `--project ${project} --shard=${String(i + 1)}/${String(count)}`,
    lane,
    statuses: false,
    ...rest,
  }));

export const SHARDS: readonly Shard[] = [
  {
    name: "correctness and sync",
    slug: "correctness-sync",
    args: "--project correctness --project sync",
    lane: "rust-contract-server",
    binary: false,
    module: false,
    statuses: true,
  },
  ...split("compliance", 10, "rust-contract-server", {
    binary: false,
    module: false,
    statuses: true,
  }),
  {
    name: "cli",
    slug: "cli",
    args: "--project cli",
    lane: "rust-contract-device",
    binary: true,
    module: false,
    statuses: true,
  },
  ...split("device", 8, "rust-contract-device", {
    binary: true,
    module: true,
  }),
];

/** The shards a `classify` answer runs. */
export function shardsFor(answer: Record<Job, boolean>): Shard[] {
  return SHARDS.filter((shard) => answer[shard.lane]);
}

/** The contract projects a set of shards runs, once each, in the order they are listed. */
export function projectsOf(shards: readonly Shard[]): string[] {
  return [
    ...new Set(
      shards.flatMap(({ args }) =>
        [...args.matchAll(/--project (\w+)/g)].map((match) => match[1] ?? ""),
      ),
    ),
  ];
}

/** The jobs one changed path can affect. */
export function affected(path: string): Set<Job> {
  const rule = RULES.find(([pattern]) => pattern.test(path));
  const jobs = new Set<Job>(rule ? rule[1] : ALL);
  if (versioned(path)) jobs.add("version-fields");
  if (readsDependencies(path)) jobs.add("core-deny");
  if (linted(path)) jobs.add("workspace");
  if (lintReads(path)) jobs.add("lint");
  // Its format check, this classifier's test and the contract's reference
  // check read every path.
  jobs.add("quick-checks");
  return jobs;
}

/** Each job's answer for a set of changed paths. An empty set runs everything. */
export function classify(paths: readonly string[]): Record<Job, boolean> {
  const jobs = new Set<Job>(paths.length === 0 ? ALL : []);
  for (const path of paths) {
    for (const job of affected(path)) jobs.add(job);
  }
  return Object.fromEntries(JOBS.map((job) => [job, jobs.has(job)])) as Record<
    Job,
    boolean
  >;
}

/**
 * A draft's answer: `DRAFT_JOBS` as the diff names them. A draft passes with
 * the rest skipped, and `Draft CI` keeps it from merging, so nothing here
 * has to fail it.
 */
export function forDraft(answer: Record<Job, boolean>): Record<Job, boolean> {
  return Object.fromEntries(
    JOBS.map((job) => [job, DRAFT_JOBS.includes(job) && answer[job]]),
  ) as Record<Job, boolean>;
}

/**
 * What the nightly run does: only what needs a Mac, because every push to
 * `main` already runs the rest on Linux. The device and CLI fixtures drive
 * the `marfa` binary against the Rust server on macOS's file watching, name
 * case, Finder packages and keychain, the core's checks run
 * its macOS-only code and the Swift package builds only on a Mac.
 * `core.yml` runs the core's live checks on the same night.
 */
export const NIGHTLY_JOBS: readonly Job[] = [
  "rust-contract-macos",
  "core-checks",
  "swift-package",
];

/** The nightly's answer: `NIGHTLY_JOBS` and nothing else. */
export function forNightly(): Record<Job, boolean> {
  return Object.fromEntries(
    JOBS.map((job) => [job, NIGHTLY_JOBS.includes(job)]),
  ) as Record<Job, boolean>;
}

/**
 * Whether an answer runs nothing but `Quick checks`' format check, this
 * classifier's test and the contract's reference check, as a change to
 * documentation or agent instructions does.
 */
export function documentationOnly(answer: Record<Job, boolean>): boolean {
  return JOBS.every((job) => job === "quick-checks" || !answer[job]);
}

interface PullRequestEvent {
  pull_request: {
    draft?: boolean;
    base: { sha: string };
    head: { sha: string };
  };
}

interface PushEvent {
  before: string;
  after: string;
  forced?: boolean;
}

interface WorkflowRun {
  event: string;
  head_branch: string | null;
  head_sha: string;
  conclusion: string | null;
}

const COMMIT = /^[a-f0-9]{40}$/;

function readEvent(): unknown {
  return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
}

/**
 * The paths that differ between two commits. No rename detection, so moving
 * code into a documentation path still counts the deletion of its original
 * path. NULs keep unusual names whole.
 */
function changedPaths(from: string, to: string, range: "..." | ".."): string[] {
  if (!COMMIT.test(from) || !COMMIT.test(to)) {
    throw new Error("Missing commit IDs");
  }
  return execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${from}${range}${to}`, "--"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
}

/**
 * Whether this workflow passed on a commit in a run `release.yml` accepts: a
 * push to `main` or a dispatch, never a pull request's head.
 */
function passed(commit: string): boolean {
  const workflow = /\.github\/workflows\/([^/@]+)@/.exec(
    process.env.GITHUB_WORKFLOW_REF ?? "",
  )?.[1];
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (workflow === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Missing workflow or repository");
  }
  const { workflow_runs: runs } = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        `repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${commit}&status=success&per_page=100`,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  ) as { workflow_runs: WorkflowRun[] };
  return runs.some(
    (run) =>
      run.head_sha === commit &&
      run.conclusion === "success" &&
      ((run.event === "push" && run.head_branch === "main") ||
        run.event === "workflow_dispatch"),
  );
}

/**
 * A push's answer. A run that skips is green only when the run before it
 * was, and that one either ran every job or skipped on these same terms, so
 * a chain of skipped runs always ends at a run of every job on code no
 * commit since has changed. Every job runs for a first or forced push, for
 * a change that reaches any job but the format check, and when this
 * workflow failed, is still running or never ran on the commit before.
 */
function forPush(event: PushEvent): Record<Job, boolean> {
  const all = classify([]);
  if (event.forced === true || /^0+$/.test(event.before)) {
    console.log("A first or forced push; running every job.");
    return all;
  }
  const answer = classify(changedPaths(event.before, event.after, ".."));
  if (!documentationOnly(answer)) return all;
  if (!passed(event.before)) {
    console.log(
      `This workflow has not passed on ${event.before}; running every job.`,
    );
    return all;
  }
  console.log(
    `Only documentation changed since ${event.before}, which passed.`,
  );
  return answer;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let answer = classify([]);
  let draft = false;
  try {
    if (process.env.GITHUB_EVENT_NAME === "pull_request") {
      const event = readEvent() as PullRequestEvent;
      draft = event.pull_request.draft === true;
      answer = classify(
        changedPaths(
          event.pull_request.base.sha,
          event.pull_request.head.sha,
          "...",
        ),
      );
    } else if (process.env.GITHUB_EVENT_NAME === "push") {
      answer = forPush(readEvent() as PushEvent);
    } else if (process.env.GITHUB_EVENT_NAME === "schedule") {
      answer = forNightly();
    }
  } catch {
    // An unreadable diff must never turn a code change into a skipped job.
    console.log("Could not classify the change; running every job.");
  }
  if (draft) answer = forDraft(answer);
  const shards = shardsFor(answer);
  appendFileSync(
    process.env.GITHUB_OUTPUT ?? "",
    JOBS.map((job) => `${job}=${String(answer[job])}\n`).join("") +
      `full=${String(!draft)}\n` +
      `rust-shards=${JSON.stringify({ include: shards })}\n` +
      `rust-projects=${projectsOf(shards).join(",")}\n`,
  );
  for (const job of JOBS) {
    console.log(`${answer[job] ? "runs " : "skips"} ${job}`);
  }
  console.log(
    `runs ${String(shards.length)} of ${String(SHARDS.length)} shards`,
  );
}
