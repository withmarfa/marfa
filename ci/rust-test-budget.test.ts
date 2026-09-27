/**
 * Every Rust test runs on a budget, and a stuck one is stopped.
 *
 * A query that never finishes spills into an unlinked SQLite temporary file,
 * which no listing of the disk shows and which grows until the disk is full.
 * Two bounds stop it, and each covers what the other cannot:
 *
 *   - nextest's budget (`.config/nextest.toml`) kills a test still running
 *     past it, and reports it by name. It holds only while nextest is alive.
 *   - The runner `core/.cargo/config.toml` names caps the size of any file a
 *     test binary writes and the processor time it takes. The kernel enforces
 *     it, so it holds for a binary whose runner is gone, and under
 *     `cargo test` as well as nextest.
 *
 * **A green suite cannot catch a recurrence.** A workflow step that goes back
 * to `cargo test`, a Rust workspace with no nextest config, or a config with
 * a `slow-timeout` and no `terminate-after` all pass every test on a day when
 * nothing hangs, and stay green until the day something does.
 *
 * The configs are parsed, not grepped: a file that mentions
 * `terminate-after` in a comment has no budget, and only the parsed value
 * tells the two apart.
 */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const CORE = "core";
const WORKFLOWS = join(".github", "workflows");

type Table = Record<string, unknown>;

function toml(path: string): Table {
  return parseToml(readFileSync(path, "utf8"));
}

/**
 * The Rust workspaces: the one at `core/`, and each directory it excludes
 * that holds a manifest of its own, which Cargo then treats as a workspace
 * root in its own right.
 */
function workspaceRoots(): string[] {
  const workspace = toml(join(CORE, "Cargo.toml")).workspace as Table;
  const excluded = (workspace.exclude as string[] | undefined) ?? [];
  return [
    CORE,
    ...excluded
      .map((dir) => join(CORE, dir))
      .filter((dir) => existsSync(join(dir, "Cargo.toml"))),
  ];
}

describe("every Rust workspace kills a test that outlives its budget", () => {
  it("finds the workspaces it is meant to be checking", () => {
    const roots = workspaceRoots();
    // A rename that hides the Swift crate from the list should redden here
    // rather than quietly shrink the check.
    expect(roots).toContain("core");
    expect(roots).toContain(join("core", "bindings", "swift"));
  });

  it.each(workspaceRoots())(
    "%s sets a slow-timeout that terminates",
    (root) => {
      const path = join(root, ".config", "nextest.toml");
      expect(
        existsSync(path),
        `${root} has no .config/nextest.toml, so nextest runs it with no budget`,
      ).toBe(true);
      const profile = (toml(path).profile as Table | undefined)?.default as
        Table | undefined;
      const timeout = profile?.["slow-timeout"] as Table | undefined;
      expect(
        typeof timeout?.period,
        `${path}: slow-timeout needs a period`,
      ).toBe("string");
      expect(
        timeout?.["terminate-after"],
        `${path}: without terminate-after nextest reports a stuck test and leaves it running`,
      ).toBeGreaterThan(0);
    },
  );
});

describe("every Rust test binary runs under the kernel's caps", () => {
  const runner = "scripts/test-limits.sh";
  const scratch = mkdtempSync(join(tmpdir(), "marfa-test-limits-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A stand-in binary that prints the two caps it was started under. */
  function probe(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "probe");
    writeFileSync(path, "#!/usr/bin/env bash\nulimit -f\nulimit -t\n", {
      mode: 0o755,
    });
    return path;
  }

  function run(command: string, ...args: string[]): string {
    const result = spawnSync(command, args, { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  it("names the runner for macOS and Linux targets", () => {
    const targets = toml(join(CORE, ".cargo", "config.toml")).target as Table;
    const entry = Object.entries(targets).find(
      ([cfg]) =>
        cfg.includes('target_os = "macos"') &&
        cfg.includes('target_os = "linux"'),
    );
    expect(entry, "a target entry covering macOS and Linux").toBeDefined();
    expect((entry?.[1] as Table).runner).toBe(runner);
    // Cargo takes a runner named for an exact target over one matched by
    // `cfg`, so a second entry with a runner of its own would win on the
    // machines it names and run their tests uncapped.
    for (const [key, config] of Object.entries(targets)) {
      if (key === entry?.[0]) continue;
      expect(
        (config as Table).runner,
        `target.${key} names a runner that takes over from ${runner}`,
      ).toBeUndefined();
    }
    expect(() => {
      accessSync(join(CORE, runner), constants.X_OK);
    }).not.toThrow();
  });

  it("caps a test binary and leaves any other binary as it is", () => {
    const script = resolve(CORE, runner);
    const test = probe(join(scratch, "target", "debug", "deps"));
    const program = probe(join(scratch, "target", "debug"));

    // The witness: started directly, the probe reports what this process
    // was given, so a capped answer below is the runner's doing.
    const uncapped = run(program);
    const capped = run(script, test);

    for (const line of capped.trim().split("\n")) {
      expect(line, "a cap, not unlimited").toMatch(/^\d+$/);
    }
    expect(capped).not.toBe(uncapped);
    expect(run(script, program)).toBe(uncapped);
  });
});

/** Where a `cargo test` would run tests without nextest's budget. */
const BYPASS = /\bcargo\s+(?:\+\S+\s+)?test\b/;

/**
 * A command as the shell reads it: a backslash before a line break joins the
 * two lines, so `cargo \` with `test` on the next line is `cargo test`.
 */
function joined(command: string): string {
  return command.replace(/\\\r?\n\s*/g, " ");
}

function workflowCommands(): { where: string; command: string }[] {
  const commands: { where: string; command: string }[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const workflow = parseYaml(readFileSync(join(WORKFLOWS, file), "utf8")) as {
      jobs: Record<string, { steps?: { run?: string }[] }>;
    };
    for (const [job, config] of Object.entries(workflow.jobs)) {
      for (const step of config.steps ?? []) {
        if (typeof step.run === "string") {
          commands.push({ where: `${file}: ${job}`, command: step.run });
        }
      }
    }
  }
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const [name, command] of Object.entries(pkg.scripts)) {
    commands.push({ where: `package.json: ${name}`, command });
  }
  return commands;
}

describe("no Rust test run bypasses nextest", () => {
  it("recognizes a bypass when it sees one", () => {
    // The witness: the pattern matches the forms a bypass takes and not
    // the command that replaces it, so the absence below is the tree's.
    expect("cargo test --locked").toMatch(BYPASS);
    expect("x && cargo +nightly test").toMatch(BYPASS);
    expect(joined("cargo \\\n  test --locked")).toMatch(BYPASS);
    expect("cargo nextest run --locked").not.toMatch(BYPASS);
  });

  it("runs the Rust tests through nextest somewhere", () => {
    expect(
      workflowCommands().some(({ command }) =>
        command.includes("cargo nextest run"),
      ),
    ).toBe(true);
  });

  it("has no workflow step or package script that runs cargo test", () => {
    for (const { where, command } of workflowCommands()) {
      expect(joined(command), `${where} runs cargo test`).not.toMatch(BYPASS);
    }
  });
});

describe("every workflow job has a timeout", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it.each(files)("%s sets timeout-minutes on each job", (file) => {
    const jobs = (
      parseYaml(readFileSync(join(WORKFLOWS, file), "utf8")) as {
        jobs: Record<string, Table>;
      }
    ).jobs;
    expect(Object.keys(jobs).length).toBeGreaterThan(0);
    for (const [job, config] of Object.entries(jobs)) {
      expect(
        typeof config["timeout-minutes"],
        `${file}: ${job} runs until GitHub's six-hour default`,
      ).toBe("number");
    }
  });
});
