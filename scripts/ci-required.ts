/**
 * Which CI jobs a change can affect.
 *
 * Each job in `ci.yml` and `core.yml` runs when this answers `true` for it
 * and is skipped otherwise, and a skipped job satisfies a required check
 * where a workflow filtered out by `paths` would leave it pending. The
 * nightly and a dispatch answer `true` for every job, and so does a change
 * that could not be read, so a skip only ever comes from a diff that was
 * read and classified.
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
  // `CI (SQLite)`. It runs the format check and this classifier's test for
  // any change outside `core/` but the licence, and for a crate manifest,
  // and its build, typecheck, lint and tests only for `workspace`.
  "ci-sqlite",
  "workspace",
  // `Core checks`, on macOS: the core's format, lint and tests, the login
  // keychain check and the Swift crate.
  "core-checks",
  // `Core checks (Linux)`: the same for the core workspace on Ubuntu, where
  // the non-macOS credential store and the test keychain it uses are built.
  // It reads what `core-checks` reads but the Swift crate.
  "core-checks-linux",
  "conformance",
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

/** Every job the server's code can change the result of, but `core`. */
const SERVER: readonly Job[] = [
  "workspace",
  "conformance",
  "cli-scenarios",
  "restore-drill",
  "image",
  "openapi-freshness",
];

/** Every job that builds the `marfa` binary, and the core's own checks. */
const RUST: readonly Job[] = [
  "core-checks",
  "core-checks-linux",
  "conformance",
  "cli-scenarios",
  "core",
];

/** Every job that installs or builds the pnpm workspace, but `core`. */
const WORKSPACE: readonly Job[] = [
  "workspace",
  "conformance",
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

  // The contract's statements are cited by number and checked by the suite,
  // and the error code census test holds `errors.md` to the codes the server
  // sends.
  [/^conformance\/spec\//, ["workspace", "conformance"]],
  // Markdown anywhere else is read only by Prettier, and a package's README
  // by the version check. A fixture is test input and a generated tree is
  // checked file by file, so those fall through to their folder's rule.
  [
    /^(?!(.*\/)?(fixtures|__fixtures__|testdata)\/)(?!packages\/types\/generated\/|packages\/client\/src\/generated\/).*\.md$/i,
    [],
  ],
  // The settings census test holds it to the settings schema.
  [/^\.env\.example$/, ["workspace"]],
  [/^(LICENSE|\.infisical\.json)$/, []],
  // Agent instructions, settings and Git hooks. No job runs or reads them.
  [/^\.(agents|claude|codex|githooks)\//, []],

  // The drill installs the image's Litestream and runs its configuration,
  // which the offline lane's own test reads too.
  [/^deploy\/Dockerfile$/, ["restore-drill", "image"]],
  [/^deploy\/litestream\.yml$/, ["restore-drill", "conformance", "image"]],
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
  // change there reaches the conformance job's offline lane.
  [
    /^conformance\/src\/suites\/cli\//,
    ["workspace", "conformance", "cli-scenarios"],
  ],
  [
    /^conformance\/src\/suites\/device\/harness\.ts$/,
    ["workspace", "conformance", "cli-scenarios"],
  ],
  [/^conformance\/src\/suites\//, ["workspace", "conformance"]],
  [
    /^conformance\/src\/utils\//,
    ["workspace", "conformance", "cli-scenarios", "restore-drill"],
  ],
  [/^conformance\/src\//, ["workspace", "conformance", "cli-scenarios"]],
  [
    /^conformance\//,
    ["workspace", "conformance", "cli-scenarios", "restore-drill"],
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
    ["core-checks", "core", "workspace"],
  ],
  // The Linux job checks the core workspace and not the Swift crate, which
  // is a workspace of its own.
  [/^core\/bindings\/swift\//, ["core-checks", "core"]],
  // The Node module's JavaScript side is built and tested only by the live job.
  [/^core\/bindings\/node\/(test|scripts)\//, ["core"]],
  [
    /^core\/bindings\/node\/(index\.js|index\.d\.ts|package\.json|pnpm-lock\.yaml|tsconfig\.json)$/,
    ["core"],
  ],
  [/^core\/bindings\//, ["core-checks", "core-checks-linux", "core"]],
  // A crate's tests are not in the binary, and spec citations are read only
  // from `src/`.
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
      "conformance",
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

/**
 * Whether `CI (SQLite)` runs its format check and this classifier's test
 * for a path: anything outside `core/`, which Prettier ignores, but the
 * licence, and every crate manifest, which the test reads.
 */
function checked(path: string): boolean {
  return (
    (!path.startsWith("core/") && path !== "LICENSE") ||
    basename(path) === "Cargo.toml"
  );
}

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
  if (checked(path) || jobs.has("workspace")) jobs.add("ci-sqlite");
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
 * A draft's answer: `DRAFT_JOBS` as the diff names them, and `CI (SQLite)`
 * whatever it names, because that required check fails for a draft. A skipped
 * job passes its required check, so a draft that skipped every one would
 * merge before its first full run.
 */
export function forDraft(answer: Record<Job, boolean>): Record<Job, boolean> {
  return Object.fromEntries(
    JOBS.map((job) => [
      job,
      DRAFT_JOBS.includes(job) && (job === "ci-sqlite" || answer[job]),
    ]),
  ) as Record<Job, boolean>;
}

/**
 * Whether an answer runs nothing but `CI (SQLite)`'s format check and this
 * classifier's test, as a change to documentation or agent instructions does.
 */
export function documentationOnly(answer: Record<Job, boolean>): boolean {
  return JOBS.every((job) => job === "ci-sqlite" || !answer[job]);
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
      `full=${String(!draft)}\n`,
  );
  for (const job of JOBS) {
    console.log(`${answer[job] ? "runs " : "skips"} ${job}`);
  }
}
