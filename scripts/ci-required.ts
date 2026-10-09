/**
 * Which CI jobs a change can affect.
 *
 * Each job in `ci.yml` and `core.yml` runs when this answers `true` for it
 * and is skipped otherwise, and a skipped job satisfies a required check
 * where a workflow filtered out by `paths` would leave it pending. `Full CI`,
 * the last job of `ci.yml`, waits for the rest and is what a ruleset
 * requires. The nightly and a dispatch answer `true` for every job, and so
 * does a change that could not be read, so a skip only ever comes from a diff
 * that was read and classified.
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
 * A path is matched against `RULES` in order and the first match names the
 * jobs it can affect. A path no rule matches affects every job, so a new
 * folder runs everything until someone states what reads it.
 * `ci/ci-required.test.ts` pins the rules.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/** Each output, named for the job that reads it. */
export const JOBS = [
  // `CI (SQLite)`. It runs the format check, this classifier's test and the
  // contract's reference check for any change, and its build, typecheck,
  // lint and tests only for `workspace`.
  "ci-sqlite",
  "workspace",
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
  // The contract's suites, run against a server booted from this checkout,
  // and the offline lane that needs none. `ci.yml` runs the three groups of
  // server fixtures as shards, each on a runner of its own, and `Conformance`
  // collects them into one verdict. See `CONFORMANCE_GROUPS`.
  "conformance-offline",
  "conformance-correctness-sync",
  "conformance-compliance",
  "conformance-device",
  // The server's log of each shard, merged, held to what the document
  // declares. A declared status no request drew can be told only from the
  // whole selection, so this runs only when every group does.
  "conformance-statuses",
  "cli-scenarios",
  "restore-drill",
  // The shipped image, built and booted through its entrypoint.
  "image",
  "types-freshness",
  "openapi-freshness",
  "version-fields",
  "clients-freshness",
  // `core.yml`'s live job, on macOS. It boots the server too, but a pull
  // request that changes only the server leaves it to the push to `main`.
  "core",
] as const;

export type Job = (typeof JOBS)[number];

const ALL: readonly Job[] = JOBS;
const CI_YML: readonly Job[] = JOBS.filter((job) => job !== "core");

/**
 * A group of the contract's server fixtures, run over `shards` runners of
 * their own. The fixtures isolate themselves by credential and share no
 * state between files, so a runner takes any part of a group and boots its
 * own server and object store.
 */
export interface ConformanceGroup {
  readonly job: Job;
  /** The vitest projects the group runs. */
  readonly projects: readonly string[];
  /** How many runners the group is split over; 1 runs it whole. */
  readonly shards: number;
  /** Whether the fixtures drive the `marfa` binary, which a runner then builds or restores. */
  readonly device: boolean;
}

export const CONFORMANCE_GROUPS: readonly ConformanceGroup[] = [
  {
    job: "conformance-correctness-sync",
    projects: ["correctness", "sync"],
    shards: 1,
    device: false,
  },
  {
    job: "conformance-compliance",
    projects: ["compliance"],
    shards: 4,
    device: false,
  },
  {
    job: "conformance-device",
    projects: ["device"],
    shards: 4,
    device: true,
  },
];

const CONFORMANCE_SHARDS: readonly Job[] = CONFORMANCE_GROUPS.map(
  (group) => group.job,
);

/**
 * Every conformance job a change to the server, or to what every fixture
 * shares, can change the result of. `conformance-statuses` is not named: it
 * is added by `classify` when all the groups are.
 */
const CONFORMANCE: readonly Job[] = [
  "conformance-offline",
  ...CONFORMANCE_SHARDS,
];

/** Every job the server's code can change the result of, but `core`. */
const SERVER: readonly Job[] = [
  "workspace",
  ...CONFORMANCE,
  "cli-scenarios",
  "restore-drill",
  "image",
  "openapi-freshness",
];

/**
 * Every job that builds the `marfa` binary, and the core's own checks. Of
 * the conformance jobs only the device fixtures drive the binary.
 */
const RUST: readonly Job[] = [
  "core-checks",
  "core-checks-linux",
  "conformance-offline",
  "conformance-device",
  "cli-scenarios",
  "core",
];

/** Every job that installs or builds the pnpm workspace, but `core`. */
const WORKSPACE: readonly Job[] = [
  "workspace",
  ...CONFORMANCE,
  "cli-scenarios",
  "restore-drill",
  "image",
  "types-freshness",
  "openapi-freshness",
  "version-fields",
  "clients-freshness",
];

/**
 * First match wins. The format check, the version check and lint are added
 * on top by `affected`, since they read files whatever else reads them.
 */
export const RULES: readonly (readonly [RegExp, readonly Job[]])[] = [
  // What decides what runs is proven on everything it decides.
  [/^scripts\/ci-required\.ts$/, ALL],
  [/^\.github\/workflows\/ci\.yml$/, CI_YML],
  // `ci/` tests read every workflow.
  [/^\.github\/workflows\/core\.yml$/, ["workspace", "core"]],
  [/^\.github\/workflows\//, ["workspace"]],
  // Read by GitHub alone. Anything else under `.github/`, such as an action
  // a workflow uses, runs everything until a rule names it.
  [/^\.github\/(ISSUE_TEMPLATE\/|dependabot\.yml$)/, []],
  // Checkout applies it to every file every job reads.
  [/^\.gitattributes$/, ALL],

  // The contract's statements are cited by ID and checked by the offline
  // lane, and the error code census test holds `errors.md` to the codes the
  // server sends. Two chapters are also read by a fixture while it runs:
  // `compliance/error-codes.test.ts` holds every refusal's code to the error
  // table, and `compliance/instance.test.ts` holds the published operations
  // to the coverage table. No other server fixture reads the contract, and
  // `ci/ci-required.test.ts` fails when one starts to.
  [
    /^conformance\/spec\/(errors|coverage)\.md$/,
    ["workspace", "conformance-offline", "conformance-compliance"],
  ],
  [/^conformance\/spec\//, ["workspace", "conformance-offline"]],
  // The binary's command reference is generated from its command tree, and
  // a unit test in `marfa-cli` holds the committed file to it. Only the core
  // checks run the Rust tests.
  [/^core\/marfa-cli\/COMMANDS\.md$/, ["core-checks", "core-checks-linux"]],
  // Markdown anywhere else is read only by Prettier and the contract's
  // reference check, which `CI (SQLite)` runs for every change, and a
  // package's README by the version check. A fixture is test input and a
  // generated tree is checked file by file, so those fall through to their
  // folder's rule.
  [
    /^(?!(.*\/)?(fixtures|__fixtures__|testdata)\/)(?!packages\/types\/generated\/|packages\/client\/src\/generated\/).*\.md$/i,
    [],
  ],
  // The settings census test holds it to the settings schema.
  [/^\.env\.example$/, ["workspace"]],
  [/^LICENSE$/, []],
  // Agent instructions, settings and Git hooks. No job runs or reads them.
  [/^\.(agents|claude|codex|githooks)\//, []],

  // The drill installs the image's Litestream and runs its configuration,
  // which the offline lane's own test reads too.
  [/^deploy\/Dockerfile$/, ["restore-drill", "image"]],
  [/^deploy\/litestream\.yml$/, ["restore-drill", ...CONFORMANCE, "image"]],
  // The image copies the entrypoint and the ignore file into its build, and
  // `ci/entrypoint.test.ts` runs the entrypoint.
  [
    /^deploy\/(entrypoint\.sh|Dockerfile\.dockerignore)$/,
    ["workspace", "image"],
  ],
  [/^deploy\//, []],

  // The core's catalog is written from the shipped types, the registry that
  // lists them and the server's role resolution.
  [/^packages\/types\//, [...SERVER, "types-freshness", "clients-freshness"]],
  [/^packages\/shared\//, [...SERVER, "clients-freshness"]],
  [
    /^packages\/server\/src\/storage\/policy\.ts$/,
    [...SERVER, "clients-freshness"],
  ],
  [/^packages\/server\//, SERVER],
  [/^packages\/client\//, ["workspace", "clients-freshness"]],

  [/^conformance\/scripts\/restore-drill\.ts$/, ["workspace", "restore-drill"]],
  // Spec citations name fixture files anywhere under `src/`, so every
  // change there reaches the offline lane. A device fixture imports the CLI
  // harness, and a fixture reaches only the group its folder runs in.
  [
    /^conformance\/src\/suites\/cli\/harness\.ts$/,
    ["workspace", "conformance-offline", "conformance-device", "cli-scenarios"],
  ],
  [
    /^conformance\/src\/suites\/cli\//,
    ["workspace", "conformance-offline", "cli-scenarios"],
  ],
  [
    /^conformance\/src\/suites\/device\/harness\.ts$/,
    ["workspace", "conformance-offline", "conformance-device", "cli-scenarios"],
  ],
  [
    /^conformance\/src\/suites\/device\//,
    ["workspace", "conformance-offline", "conformance-device"],
  ],
  [
    /^conformance\/src\/suites\/compliance\//,
    ["workspace", "conformance-offline", "conformance-compliance"],
  ],
  [
    /^conformance\/src\/suites\/(correctness|sync)\//,
    ["workspace", "conformance-offline", "conformance-correctness-sync"],
  ],
  // Off the gate: `benchmarks.yml` runs them.
  [
    /^conformance\/src\/suites\/(load|performance)\//,
    ["workspace", "conformance-offline"],
  ],
  [/^conformance\/src\/suites\//, ["workspace", ...CONFORMANCE]],
  [
    /^conformance\/src\/utils\//,
    ["workspace", ...CONFORMANCE, "cli-scenarios", "restore-drill"],
  ],
  [
    /^conformance\/src\/client\/owner-session\.ts$/,
    ["workspace", ...CONFORMANCE, "cli-scenarios", "restore-drill"],
  ],
  [/^conformance\/src\//, ["workspace", ...CONFORMANCE, "cli-scenarios"]],
  [
    /^conformance\//,
    ["workspace", ...CONFORMANCE, "cli-scenarios", "restore-drill"],
  ],

  // `ci/` tests read the contract version the core is generated with, the
  // workspace manifest, the runner and test budgets, and the Swift crate's
  // budget.
  [
    /^core\/marfa-core\/src\/contract\.rs$/,
    [...RUST, "clients-freshness", "workspace"],
  ],
  [
    /^core\/marfa-core\/src\/builtin_catalog\.json$/,
    [...RUST, "clients-freshness", "workspace"],
  ],
  [/^core\/Cargo\.toml$/, [...RUST, "workspace"]],
  [/^core\/Cargo\.lock$/, RUST],
  [/^core\/\.cargo\//, [...RUST, "workspace"]],
  [
    /^core\/\.config\//,
    ["core-checks", "core-checks-linux", "core", "workspace"],
  ],
  // It can hide a file the client generator writes from the freshness
  // check's `git status`.
  [/^core\/\.gitignore$/, ["clients-freshness"]],
  [
    /^core\/scripts\/test-limits\.sh$/,
    ["core-checks", "core-checks-linux", "core", "workspace"],
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
  [
    /^core\/bindings\/node\/(index\.js|index\.d\.ts|package\.json|pnpm-lock\.yaml|tsconfig\.json)$/,
    ["core"],
  ],
  [/^core\/bindings\//, ["core-checks", "core-checks-linux", "core"]],
  // A crate's tests are not in the binary.
  [/^core\/[^/]+\/tests\//, ["core-checks", "core-checks-linux", "core"]],
  // Any other crate can be one the binary is built from.
  [/^core\//, RUST],

  // The server's tests, the clients, the core's tests and the offline lane
  // all read the committed document.
  [
    /^openapi\.json$/,
    [
      "workspace",
      "core-checks",
      "core-checks-linux",
      ...CONFORMANCE,
      "cli-scenarios",
      "openapi-freshness",
      "clients-freshness",
      "core",
    ],
  ],

  [/^scripts\/check-image\.sh$/, ["workspace", "image"]],
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
  [/^vitest\.(config|shared)\.ts$/, ["workspace", "version-fields"]],
  // Prettier skips what Git ignores, and a freshness check that asks
  // `git status` cannot see an ignored file.
  [/^\.gitignore$/, ["workspace", "types-freshness", "clients-freshness"]],
  [/^\.prettierignore$/, []],
];

/** What `eslint .` reads: JavaScript and TypeScript outside its ignores. */
function linted(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path) && !/^(core|conformance)\//.test(path);
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
    path === "packages/server/src/contract.ts" ||
    path === "ci/version-fields.test.ts"
  );
}

/**
 * What a draft pull request runs, of what its diff names: the format check,
 * the build, typecheck and lint, the type registry and the version check.
 * The tests, the server and the core, the contract and the clients wait
 * until it is ready for review.
 */
export const DRAFT_JOBS: readonly Job[] = [
  "ci-sqlite",
  "workspace",
  "types-freshness",
  "version-fields",
];

/** The jobs one changed path can affect. */
export function affected(path: string): Set<Job> {
  const rule = RULES.find(([pattern]) => pattern.test(path));
  const jobs = new Set<Job>(rule ? rule[1] : ALL);
  if (versioned(path)) jobs.add("version-fields");
  if (linted(path)) jobs.add("workspace");
  // Its format check, this classifier's test and the contract's reference
  // check read every path.
  jobs.add("ci-sqlite");
  return jobs;
}

/** Each job's answer for a set of changed paths. An empty set runs everything. */
export function classify(paths: readonly string[]): Record<Job, boolean> {
  const jobs = new Set<Job>(paths.length === 0 ? ALL : []);
  for (const path of paths) {
    for (const job of affected(path)) jobs.add(job);
  }
  // A status no request drew shows only in the log of the whole selection.
  if (CONFORMANCE_SHARDS.every((job) => jobs.has(job))) {
    jobs.add("conformance-statuses");
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
 * Whether an answer runs nothing but `CI (SQLite)`'s format check, this
 * classifier's test and the contract's reference check, as a change to
 * documentation or agent instructions does.
 */
export function documentationOnly(answer: Record<Job, boolean>): boolean {
  return JOBS.every((job) => job === "ci-sqlite" || !answer[job]);
}

/** One runner of the conformance matrix in `ci.yml`. */
export interface ConformanceShard {
  /** Names the job and, with the slug, the artifact that keeps its server log. */
  name: string;
  slug: string;
  /** What `vitest run` is given. */
  args: string;
  /** Whether the runner builds or restores the `marfa` binary. */
  device: boolean;
}

/**
 * The matrix of runners an answer starts: every shard of each group it runs,
 * and none for a group it skips. `ci.yml` repeats the whole layout for a
 * classifier that did not answer, and `ci/conformance-gate.test.ts` holds the
 * two together. A group with more than one shard splits its files with
 * `conformance/src/utils/shard-sequencer.ts`.
 */
export function conformanceShards(
  answer: Record<Job, boolean>,
): ConformanceShard[] {
  return CONFORMANCE_GROUPS.filter((group) => answer[group.job]).flatMap(
    (group) => {
      const projects = group.projects
        .map((project) => `--project ${project}`)
        .join(" ");
      const label = group.job.replace("conformance-", "");
      if (group.shards === 1) {
        return [
          {
            name: label.replaceAll("-", " and "),
            slug: label,
            args: projects,
            device: group.device,
          },
        ];
      }
      return Array.from({ length: group.shards }, (_, i) => ({
        name: `${label} ${String(i + 1)}/${String(group.shards)}`,
        slug: `${label}-${String(i + 1)}`,
        args: `${projects} --shard=${String(i + 1)}/${String(group.shards)}`,
        device: group.device,
      }));
    },
  );
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
    }
  } catch {
    // An unreadable diff must never turn a code change into a skipped job.
    console.log("Could not classify the change; running every job.");
  }
  if (draft) answer = forDraft(answer);
  appendFileSync(
    process.env.GITHUB_OUTPUT ?? "",
    JOBS.map((job) => `${job}=${String(answer[job])}\n`).join("") +
      `conformance-shards=${JSON.stringify(conformanceShards(answer))}\n` +
      `full=${String(!draft)}\n`,
  );
  for (const job of JOBS) {
    console.log(`${answer[job] ? "runs " : "skips"} ${job}`);
  }
}
