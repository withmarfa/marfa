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
  "openapi-freshness",
];
const RUST: Job[] = ["core-checks", "conformance", "cli-scenarios", "core"];
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
      "the contract's specification",
      ["conformance/spec/items.md"],
      ["ci-sqlite", "conformance"],
    ],
    ["a server-only change", ["packages/server/src/routes/items.ts"], SERVER],
    [
      "a type definition",
      ["packages/types/core/note.json"],
      [...SERVER, "types-freshness"],
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
      ["core-checks", "core"],
    ],
    [
      "a Swift-only change",
      ["core/bindings/swift/src/lib.rs"],
      ["core-checks", "core"],
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
        "conformance",
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
      "the image's Litestream",
      ["deploy/Dockerfile"],
      ["ci-sqlite", "restore-drill"],
    ],
    [
      "the Litestream configuration, which the offline lane also reads",
      ["deploy/litestream.yml"],
      ["ci-sqlite", "conformance", "restore-drill"],
    ],
    [
      "JavaScript that ESLint reads",
      ["deploy/healthcheck.js"],
      ["ci-sqlite", "workspace"],
    ],
    [
      "Markdown in a generated tree, which its freshness check refuses",
      ["core/marfa-client/NOTES.md", "packages/types/generated/NOTES.md"],
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
    expect(beyond("conformance/spec/items.md")).toEqual(["conformance"]);
    expect(beyond("packages/client/README.md")).toEqual(["version-fields"]);
    const markdown = tracked().filter((path) => path.endsWith(".md"));
    expect(markdown.length).toBeGreaterThan(0);
    for (const path of markdown) {
      if (path.startsWith("conformance/spec/")) {
        expect(beyond(path), path).toEqual(["conformance"]);
      } else if (docs?.test(path)) {
        expect(beyond(path), path).toEqual(
          /^(packages|core)\/.+\/README[^/]*$/.test(path)
            ? ["version-fields"]
            : [],
        );
      }
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
}

interface Workflow {
  on: Record<string, { paths?: string[] } | null>;
  jobs: Record<
    string,
    {
      needs?: string;
      if?: string;
      outputs?: Record<string, string>;
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

describe("each job reads its own answer", () => {
  it("ci.yml runs a job only when the classifier says so, and every one when it cannot tell", () => {
    const { jobs } = workflow("ci.yml");
    const gated = Object.keys(jobs).filter((name) => name !== "changes");
    expect(gated.sort()).toEqual(
      JOBS.filter((job) => job !== "workspace" && job !== "core").sort(),
    );
    expect(jobs.changes?.outputs).toEqual(
      Object.fromEntries(
        CI_YML.map((job) => [job, `\${{ steps.classify.outputs.${job} }}`]),
      ),
    );
    for (const name of gated) {
      expect(jobs[name]?.needs, name).toBe("changes");
      expect(jobs[name]?.if, name).toBe(gate(name));
    }
  });

  it("CI (SQLite) checks formatting and these rules for any change and the rest only for the workspace", () => {
    const steps = workflow("ci.yml").jobs["ci-sqlite"]?.steps ?? [];
    const format = steps.findIndex((step) => step.run === "pnpm format:check");
    expect(format).toBeGreaterThan(0);
    expect(steps[format]?.if).toBeUndefined();
    expect(steps[format + 1]).toEqual({
      run: "pnpm vitest run ci/ci-required.test.ts",
    });
    const after = steps.slice(format + 2);
    expect(after.map((step) => step.run ?? step.uses)).toEqual([
      "pnpm build",
      "pnpm typecheck",
      "pnpm lint",
      "actions/cache@v6",
      'MARFA_TEST_OCR=1 MARFA_ENRICHMENT_TESSDATA_DIR="$HOME/.cache/marfa-tessdata" pnpm test --exclude ci/version-fields.test.ts --exclude ci/ci-required.test.ts',
    ]);
    for (const step of after) {
      expect(step.if).toBe("${{ needs.changes.outputs.workspace != 'false' }}");
    }
    // Nothing before the gated steps needs Rust, and nothing after does now
    // that the version check, the one test that runs cargo, is left out.
    expect(steps.some((step) => step.uses?.includes("rust"))).toBe(false);
  });

  it("core.yml runs its job on a pull request only when the classifier says so", () => {
    const { on, jobs } = workflow("core.yml");
    expect(on.pull_request).toEqual({ branches: ["main"] });
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
  const { on } = workflow("codeql.yml") as unknown as {
    on: {
      push?: unknown;
      pull_request?: { branches?: string[]; "paths-ignore"?: string[] };
      schedule?: { cron: string }[];
    };
  };
  const ignored = on.pull_request?.["paths-ignore"] ?? [];
  const skips = (path: string) =>
    ignored.some((pattern) => filterMatches(pattern, path));

  it("analyzes every push to main and once a week, and a pull request unless it changes only documentation or agent settings", () => {
    expect(on.push).toEqual({ branches: ["main"] });
    expect(on.pull_request).toEqual({
      branches: ["main"],
      "paths-ignore": ["**/*.md", "LICENSE", ".claude/**"],
    });
    expect(on.schedule).toHaveLength(1);
    expect(on.schedule?.[0]?.cron).toMatch(/^\d{1,2} \d{1,2} \* \* [0-6]$/);
  });

  it("skips what the classifier also reads as documentation, and no code in a language it analyzes", () => {
    for (const path of ["README.md", "LICENSE", ".claude/settings.json"]) {
      expect(skips(path), path).toBe(true);
      expect([...affected(path)].filter((job) => job !== "ci-sqlite")).toEqual(
        [],
      );
    }
    expect(skips("conformance/spec/items.md")).toBe(true);
    for (const path of [
      ".github/workflows/ci.yml",
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
    expect([...crates].sort()).toEqual([
      "marfa-cli",
      "marfa-client",
      "marfa-core",
    ]);

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
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function outputs(
    event: string,
    from: string,
    to: string,
  ): Record<string, string> {
    const eventPath = join(directory, "event.json");
    const output = join(directory, "output");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: { base: { sha: from }, head: { sha: to } },
      }),
    );
    writeFileSync(output, "");
    execFileSync(process.execPath, [script], {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: output,
      },
    });
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=") as [string, string]),
    );
  }

  const every = (value: string) =>
    Object.fromEntries(JOBS.map((job) => [job, value]));

  it("writes one answer per job for a pull request's diff", () => {
    expect(
      outputs("pull_request", commits.base ?? "", commits.docs ?? ""),
    ).toEqual({
      ...every("false"),
      "ci-sqlite": "true",
    });
    const server = outputs(
      "pull_request",
      commits.docs ?? "",
      commits.server ?? "",
    );
    expect(JOBS.filter((job) => server[job] === "true")).toEqual(SERVER);
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

  it.each(["push", "schedule", "workflow_dispatch"])(
    "runs every job on %s",
    (event) => {
      expect(outputs(event, commits.base ?? "", commits.docs ?? "")).toEqual(
        every("true"),
      );
    },
  );
});
