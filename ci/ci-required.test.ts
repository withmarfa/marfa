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
  JOBS,
  RULES,
  type Job,
} from "../scripts/ci-required.js";

const ROOT = resolve(import.meta.dirname, "..");

function runs(paths: string[]): Job[] {
  const answer = classify(paths);
  return JOBS.filter((job) => answer[job]);
}

const SERVER: Job[] = [
  "ci-sqlite",
  "workspace",
  "conformance",
  "cli-scenarios",
  "restore-drill",
  "image",
  "openapi-freshness",
];
const RUST: Job[] = [
  "core-checks",
  "core-checks-linux",
  "conformance",
  "cli-scenarios",
  "core",
];
const CI_YML: Job[] = JOBS.filter((job) => job !== "core");

describe("what a change runs", () => {
  it.each<[string, string[], Job[]]>([
    [
      "a README in a subfolder",
      [
        "conformance/README.md",
        "conformance/src/suites/sync/README.md",
        "deploy/README.md",
      ],
      ["ci-sqlite"],
    ],
    ["a README Prettier does not read", ["core/README.md"], []],
    [
      "a published package's README, which the version check reads",
      ["packages/client/README.md"],
      ["ci-sqlite", "version-fields"],
    ],
    [
      "top-level documentation and the licence",
      ["GLOSSARY.md", "LICENSE"],
      ["ci-sqlite"],
    ],
    ["the licence alone", ["LICENSE"], []],
    [
      "agent instructions, settings and Git hooks, in any language ESLint does not read",
      [
        "AGENTS.md",
        "CLAUDE.md",
        "packages/server/AGENTS.md",
        ".agents/skills/release/SKILL.md",
        ".agents/skills/release/helper.py",
        ".claude/settings.json",
        ".codex/config.toml",
        ".githooks/pre-push",
        ".github/ISSUE_TEMPLATE/bug.yml",
      ],
      ["ci-sqlite"],
    ],
    [
      "JavaScript or TypeScript in an agent folder, which ESLint reads",
      [".agents/skills/release/helper.ts", ".githooks/check.mjs"],
      ["ci-sqlite", "workspace"],
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
      ["ci-sqlite"],
    ],
    [
      "an action a workflow could use",
      [".github/actions/setup/action.yml"],
      [...JOBS],
    ],
    [
      "the core's ignore file, which can hide a generated client file",
      ["core/.gitignore"],
      ["clients-freshness"],
    ],
    [
      "the settings example, which the settings census test reads",
      [".env.example"],
      ["ci-sqlite", "workspace"],
    ],
    [
      "the contract's specification",
      ["conformance/spec/items.md"],
      ["ci-sqlite", "workspace", "conformance"],
    ],
    ["a server-only change", ["packages/server/src/routes/items.ts"], SERVER],
    [
      "a type definition, which the core's catalog is written from",
      ["packages/types/core/note.json"],
      [...SERVER, "types-freshness", "clients-freshness"],
    ],
    [
      "the registry that lists the types",
      ["packages/shared/src/type-registry.ts"],
      [...SERVER, "clients-freshness"],
    ],
    [
      "the catalog the core carries",
      ["core/marfa-core/src/builtin_catalog.json"],
      [...RUST, "clients-freshness", "workspace", "ci-sqlite"],
    ],
    [
      "a client-only change",
      ["packages/client/src/client.ts"],
      ["ci-sqlite", "workspace", "clients-freshness"],
    ],
    ["a Rust-only change", ["core/marfa-core/src/store.rs"], RUST],
    [
      "a Rust test, which is not in the binary",
      ["core/marfa-cli/tests/folder.rs"],
      ["core-checks", "core-checks-linux", "core"],
    ],
    [
      "a Swift-only change, which the Linux job does not check",
      ["core/bindings/swift/src/lib.rs"],
      ["core-checks", "core", "swift-package"],
    ],
    [
      "the Swift crate's lockfile, which pins the uniffi the glue is made with",
      ["core/bindings/swift/Cargo.lock"],
      ["core-checks", "core", "swift-package", "version-fields"],
    ],
    [
      "the Swift crate's manifest, which declares it",
      ["core/bindings/swift/Cargo.toml"],
      [
        "ci-sqlite",
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
      ["core-checks", "core", "swift-package"],
    ],
    [
      "the Node module's Rust, a member of the core workspace",
      ["core/bindings/node/src/lib.rs"],
      ["core-checks", "core-checks-linux", "core"],
    ],
    [
      "the Node module's JavaScript",
      ["core/bindings/node/test/pin.test.mjs"],
      ["core"],
    ],
    [
      "the API document",
      ["openapi.json"],
      [
        "ci-sqlite",
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
    [
      "a CLI scenario",
      ["conformance/src/suites/cli/folder.test.ts"],
      ["ci-sqlite", "workspace", "conformance", "cli-scenarios"],
    ],
    [
      "the device harness shared by CLI scenarios",
      ["conformance/src/suites/device/harness.ts"],
      ["ci-sqlite", "workspace", "conformance", "cli-scenarios"],
    ],
    [
      "a server fixture",
      ["conformance/src/suites/correctness/items.test.ts"],
      ["ci-sqlite", "workspace", "conformance"],
    ],
    [
      "the restore drill",
      ["conformance/scripts/restore-drill.ts"],
      ["ci-sqlite", "workspace", "restore-drill"],
    ],
    [
      "the image's Litestream, and the image itself",
      ["deploy/Dockerfile"],
      ["ci-sqlite", "restore-drill", "image"],
    ],
    [
      "the Litestream configuration, which the offline lane also reads",
      ["deploy/litestream.yml"],
      ["ci-sqlite", "conformance", "restore-drill", "image"],
    ],
    [
      "the entrypoint, which the image runs and a ci/ test runs",
      ["deploy/entrypoint.sh"],
      ["ci-sqlite", "workspace", "image"],
    ],
    [
      "the script that boots the image",
      ["scripts/check-image.sh"],
      ["ci-sqlite", "workspace", "image"],
    ],
    [
      "JavaScript that ESLint reads",
      ["deploy/healthcheck.js"],
      ["ci-sqlite", "workspace"],
    ],
    [
      "Markdown in a generated tree, which its freshness check refuses",
      ["packages/types/generated/NOTES.md"],
      [...SERVER, "types-freshness", "clients-freshness"],
    ],
    ["the attributes checkout applies", [".gitattributes"], [...JOBS]],
    [
      "a crate the binary could come to be built from",
      ["core/marfa-wire/src/lib.rs"],
      RUST,
    ],
    [
      "a dependency",
      ["pnpm-lock.yaml"],
      [
        "ci-sqlite",
        "workspace",
        "conformance",
        "cli-scenarios",
        "restore-drill",
        "image",
        "types-freshness",
        "openapi-freshness",
        "version-fields",
        "clients-freshness",
      ],
    ],
    [
      "a crate manifest, which this test reads",
      ["core/marfa-core/Cargo.toml"],
      ["ci-sqlite", ...RUST, "version-fields"],
    ],
    [
      "ci.yml, which defines every job it runs",
      [".github/workflows/ci.yml"],
      CI_YML,
    ],
    [
      "core.yml, which the ci/ tests read",
      [".github/workflows/core.yml"],
      ["ci-sqlite", "workspace", "core"],
    ],
    [
      "another workflow",
      [".github/workflows/release.yml"],
      ["ci-sqlite", "workspace"],
    ],
    ["the classifier itself", ["scripts/ci-required.ts"], [...JOBS]],
    ["a test of CI", ["ci/ci-required.test.ts"], ["ci-sqlite", "workspace"]],
    [
      "Markdown a test reads as a fixture",
      ["packages/server/src/enrichment/fixtures/note.md"],
      SERVER,
    ],
    ["a path no rule names", ["tools/new.ts"], [...JOBS]],
    [
      "documentation beside a server change",
      ["README.md", "conformance/spec/blobs.md", "packages/server/src/x.ts"],
      SERVER,
    ],
    [
      "Rust beside a client change",
      ["core/marfa-cli/src/main.rs", "packages/client/src/client.ts"],
      [
        "ci-sqlite",
        "workspace",
        "core-checks",
        "core-checks-linux",
        "conformance",
        "cli-scenarios",
        "clients-freshness",
        "core",
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

  it("names every tracked path in a rule, so only a new one runs everything", () => {
    const unnamed = (path: string) =>
      !RULES.some(([pattern]) => pattern.test(path));
    // The witness: a path no rule names reaches every job.
    expect(unnamed("tools/new.ts")).toBe(true);
    expect([...affected("tools/new.ts")].sort()).toEqual([...JOBS].sort());
    expect(tracked().filter(unnamed)).toEqual([]);
  });

  it("treats Markdown as documentation but the contract and package READMEs", () => {
    const beyond = (path: string) =>
      [...affected(path)].filter((job) => job !== "ci-sqlite");
    // The rule fixtures and generated trees fall through on purpose.
    const docs = RULES.find(([pattern]) => pattern.test("README.md"))?.[0];
    expect(docs?.test("packages/server/src/fixtures/note.md")).toBe(false);
    // The witnesses: the contract and a package's README reach a job.
    expect(beyond("conformance/spec/items.md")).toEqual([
      "workspace",
      "conformance",
    ]);
    expect(beyond("packages/client/README.md")).toEqual(["version-fields"]);
    const markdown = tracked().filter((path) => path.endsWith(".md"));
    expect(markdown.length).toBeGreaterThan(0);
    for (const path of markdown) {
      if (path.startsWith("conformance/spec/")) {
        expect(beyond(path), path).toEqual(["workspace", "conformance"]);
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
      ["AGENTS.md", "packages/server/src/runtime.ts"],
      ["packages/client/README.md"],
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
      const found = [spec, spec.replace(/\.js$/, ".ts"), `${spec}.ts`].find(
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
      needs?: string;
      if?: string;
      permissions?: Record<string, string>;
      outputs?: Record<string, string>;
      env?: Record<string, string>;
      steps: Step[];
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

describe("what a draft runs", () => {
  it("runs the quick jobs the diff names, CI (SQLite) whatever it names, and nothing else", () => {
    expect(DRAFT_JOBS).toEqual([
      "ci-sqlite",
      "workspace",
      "types-freshness",
      "version-fields",
    ]);
    // A change only the core's tests read names no quick job, and its draft
    // still fails the one required check that runs, so it cannot merge.
    expect(runs(["core/marfa-core/tests/sync.rs"])).toEqual([
      "core-checks",
      "core-checks-linux",
      "core",
    ]);
    expect(
      JOBS.filter(
        (job) => forDraft(classify(["core/marfa-core/tests/sync.rs"]))[job],
      ),
    ).toEqual(["ci-sqlite"]);
    const server = forDraft(classify(["packages/server/src/runtime.ts"]));
    expect(JOBS.filter((job) => server[job])).toEqual([
      "ci-sqlite",
      "workspace",
    ]);
    const swift = forDraft(classify(["core/bindings/swift/build.sh"]));
    expect(JOBS.filter((job) => swift[job])).toEqual(["ci-sqlite"]);
    const all = forDraft(classify([]));
    expect(JOBS.filter((job) => all[job])).toEqual([...DRAFT_JOBS]);
  });
});

describe("each job reads its own answer", () => {
  it("ci.yml runs a job only when the classifier says so, and every one when it cannot tell", () => {
    const { jobs } = workflow("ci.yml");
    const gated = Object.keys(jobs).filter((name) => name !== "changes");
    expect(gated.sort()).toEqual(
      JOBS.filter(
        (job) =>
          job !== "workspace" && job !== "swift-package" && job !== "core",
      ).sort(),
    );
    expect(jobs.changes?.outputs).toEqual(
      Object.fromEntries(
        [...CI_YML, "full"].map((job) => [
          job,
          `\${{ steps.classify.outputs.${job} }}`,
        ]),
      ),
    );
    for (const name of gated) {
      expect(jobs[name]?.needs, name).toBe("changes");
      expect(jobs[name]?.if, name).toBe(gate(name));
    }
    // A push asks whether this workflow passed on the commit before it.
    expect(jobs.changes?.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(
      jobs.changes?.steps.find((step) => step.id === "classify")?.env,
    ).toEqual({ GH_TOKEN: "${{ github.token }}" });
  });

  it("CI (SQLite) checks formatting and these rules for any change and the rest only for the workspace", () => {
    const steps = workflow("ci.yml").jobs["ci-sqlite"]?.steps ?? [];
    const format = steps.findIndex((step) => step.run === "pnpm format:check");
    expect(format).toBeGreaterThan(0);
    expect(steps[format]?.if).toBeUndefined();
    expect(steps[format + 1]).toEqual({
      run: "pnpm vitest run ci/ci-required.test.ts",
    });
    const guard = steps.at(-1);
    const after = steps.slice(format + 2, -1);
    expect(after.map((step) => step.run ?? step.uses)).toEqual([
      "pnpm build",
      "pnpm typecheck",
      "pnpm lint",
      "actions/cache@v6",
      'MARFA_TEST_OCR=1 MARFA_ENRICHMENT_TESSDATA_DIR="$HOME/.cache/marfa-tessdata" pnpm test --exclude ci/version-fields.test.ts --exclude ci/ci-required.test.ts',
    ]);
    // The tests and what only they use wait until the pull request is ready.
    for (const step of after.slice(0, 3)) {
      expect(step.if).toBe("${{ needs.changes.outputs.workspace != 'false' }}");
    }
    for (const step of after.slice(3)) {
      expect(step.if).toBe(
        "${{ needs.changes.outputs.workspace != 'false' && needs.changes.outputs.full != 'false' }}",
      );
    }
    // A draft skips every other required job, and a skipped job passes its
    // check, so this one fails for it until the run for ready for review.
    expect(guard?.if).toBe("${{ github.event.pull_request.draft }}");
    expect(guard?.run).toContain("exit 1");
    // Nothing before the gated steps needs Rust, and nothing after does now
    // that the version check, the one test that runs cargo, is left out.
    expect(steps.some((step) => step.uses?.includes("rust"))).toBe(false);
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
    // The Apple targets and the Xcode are the ones `core.yml` builds with.
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
      workflow("core.yml").jobs.core?.env?.DEVELOPER_DIR,
    );
  });

  it("core.yml runs its job on a pull request only when the classifier says so", () => {
    const { on, jobs } = workflow("core.yml");
    expect(on.pull_request).toEqual({
      branches: ["main"],
      types: ["opened", "synchronize", "reopened", "ready_for_review"],
    });
    expect(jobs.changes?.outputs).toEqual({
      core: "${{ steps.classify.outputs.core }}",
    });
    expect(jobs.core?.needs).toBe("changes");
    expect(jobs.core?.if).toBe(gate("core"));
  });

  it("core.yml runs on a push to main for the core and the server it boots, never for Markdown", () => {
    expect(workflow("core.yml").on.push?.paths).toEqual([
      "core/**",
      "openapi.json",
      "packages/server/**",
      "packages/shared/**",
      "packages/types/**",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      ".github/workflows/core.yml",
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

  it("analyzes once a week, and a push to main or a pull request unless it changes only documentation or agent instructions", () => {
    const documentation = [
      "**/*.md",
      "LICENSE",
      ".claude/**",
      ".codex/**",
      ".github/ISSUE_TEMPLATE/**",
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
      expect([...affected(path)].filter((job) => job !== "ci-sqlite")).toEqual(
        [],
      );
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
      "packages/server/src/runtime.ts",
      "deploy/healthcheck.js",
      "core/marfa-core/src/lib.rs",
      "core/Cargo.toml",
      "openapi.json",
    ]) {
      expect(skips(path), path).toBe(false);
    }
  });
});

describe("what a job reads reaches it", () => {
  it("every file the CLI scenarios load runs them", async () => {
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
      "conformance/scripts/check-statuses.ts",
    ]);
    expect(files).toContain("conformance/src/utils/setup.ts");
    expect(files.filter((f) => !affected(f).has("cli-scenarios"))).toEqual([]);
  });

  it("every file the restore drill loads runs it", () => {
    const files = closure([
      "conformance/scripts/restore-drill.ts",
      "conformance/scripts/garage.ts",
      "conformance/scripts/marfa-server.ts",
    ]);
    expect(files).toContain("conformance/src/utils/drill.ts");
    const read = [...files, "deploy/Dockerfile", "deploy/litestream.yml"];
    expect(read.filter((f) => !affected(f).has("restore-drill"))).toEqual([]);
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
    expect([...crates].sort()).toEqual(["marfa-cli", "marfa-core"]);

    const { jobs } = workflow("ci.yml");
    for (const job of ["conformance", "cli-scenarios"]) {
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
      // which the device suite refuses a binary for not being.
      const restore = steps.find((s) => s.id === "device");
      expect(restore?.if).toBe("${{ github.event_name == 'pull_request' }}");
      expect(restore?.with?.key).toBe("${{ steps.device-key.outputs.key }}");
      expect(
        steps.find((s) => s.run === "touch core/target/debug/marfa")?.if,
      ).toBe("${{ steps.device.outputs.cache-hit == 'true' }}");
      for (const crate of crates) {
        expect(
          affected(`core/${crate}/src/lib.rs`).has(job as Job),
          crate,
        ).toBe(true);
      }
    }
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
      "packages/server/src/runtime.ts": "export const v = 1;\n",
    });
    commit("docs", { "deploy/README.md": "Words\n" });
    commit("server", {
      "packages/server/src/runtime.ts": "export const v = 2;\n",
    });
    git("mv", "packages/server/src/runtime.ts", "packages/server/README.md");
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
        .map((line) => line.split("=") as [string, string]),
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
      "ci-sqlite": "true",
      full: "true",
    });
    const server = outputs(
      "pull_request",
      commits.docs ?? "",
      commits.server ?? "",
    );
    expect(JOBS.filter((job) => server[job] === "true")).toEqual(SERVER);
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
    expect(quick(server)).toEqual(["ci-sqlite", "workspace"]);
    expect(server.full).toBe("false");
    // Documentation names no quick job but the format check, which CI (SQLite)
    // runs before it fails the draft.
    const docs = outputs(
      "pull_request",
      commits.base ?? "",
      commits.docs ?? "",
      true,
    );
    expect(quick(docs)).toEqual(["ci-sqlite"]);
    expect(docs.full).toBe("false");
    const ready = outputs(
      "pull_request",
      commits.docs ?? "",
      commits.server ?? "",
      false,
    );
    expect(quick(ready)).toEqual(SERVER);
    expect(ready.full).toBe("true");
    expect(
      outputs("pull_request", "invalid", commits.docs ?? "", true),
    ).toMatchObject({
      "ci-sqlite": "true",
      conformance: "false",
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
    expect(renamed.conformance).toBe("true");
  });

  it("runs every job when the diff cannot be read or is empty", () => {
    expect(outputs("pull_request", "invalid", commits.docs ?? "")).toEqual(
      every("true"),
    );
    expect(
      outputs("pull_request", commits.docs ?? "", commits.docs ?? ""),
    ).toEqual(every("true"));
  });

  it.each(["schedule", "workflow_dispatch"])(
    "runs every job on %s",
    (event) => {
      expect(outputs(event, commits.base ?? "", commits.docs ?? "")).toEqual(
        every("true"),
      );
    },
  );

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
      "ci-sqlite": "true",
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
