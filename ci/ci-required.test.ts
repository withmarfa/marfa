import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const script = resolve("scripts/ci-required.ts");
const directory = mkdtempSync(join(tmpdir(), "marfa-ci-paths-"));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
let base: string;
let docs: string;
let code: string;
let renamed: string;

beforeAll(() => {
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "CI Fixture");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(directory, "runtime.ts"), "export const value = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  base = git("rev-parse", "HEAD");
  writeFileSync(join(directory, "GLOSSARY.md"), "Words\n");
  git("add", ".");
  git("commit", "-qm", "docs");
  docs = git("rev-parse", "HEAD");
  writeFileSync(join(directory, "runtime.ts"), "export const value = 2;\n");
  git("add", ".");
  git("commit", "-qm", "code");
  code = git("rev-parse", "HEAD");
  git("mv", "runtime.ts", "ARCHITECTURE.md");
  git("commit", "-qm", "rename");
  renamed = git("rev-parse", "HEAD");
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function classify(event: string, from: string, to: string) {
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
  return readFileSync(output, "utf8");
}

describe("CI path selection", () => {
  it("skips a documentation-only PR", () => {
    expect(classify("pull_request", base, docs)).toBe("required=false\n");
  });
  it("runs a mixed documentation and code PR", () => {
    expect(classify("pull_request", base, code)).toBe("required=true\n");
  });
  it("does not hide code deleted by a rename into documentation", () => {
    expect(classify("pull_request", code, renamed)).toBe("required=true\n");
  });
  it("runs when a diff is unavailable or empty", () => {
    expect(classify("pull_request", "invalid", docs)).toBe("required=true\n");
    expect(classify("pull_request", docs, docs)).toBe("required=true\n");
  });
  it.each(["push", "workflow_dispatch"])(
    "keeps %s fully validated",
    (event) => {
      expect(classify(event, base, docs)).toBe("required=true\n");
    },
  );
  it("only skips existing checks after successful explicit classification", () => {
    const workflow = parse(
      readFileSync(".github/workflows/ci.yml", "utf8"),
    ) as { jobs: Record<string, { needs: string; if: string }> };
    const jobs = Object.entries(workflow.jobs).filter(
      ([name]) => name !== "changes",
    );
    expect(jobs).toHaveLength(9);
    for (const [, value] of jobs) {
      const job = value;
      expect(job.needs).toBe("changes");
      expect(job.if).toBe(
        "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.required != 'false') }}",
      );
    }
  });
});
