/**
 * A scheduled run that fails opens one issue, and each failure after it
 * comments on that issue instead of opening another. The job that does it,
 * `report-failure`, is the last job of every scheduled workflow but CodeQL's
 * (whose findings are code scanning alerts), runs only for a schedule, and
 * calls `scripts/report-nightly-failure.sh`. The script is run here against a
 * stand-in for `gh`; nothing in these tests reaches GitHub.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const SCRIPT = join(ROOT, "scripts", "report-nightly-failure.sh");

const REPORT = "report-failure";
/** Reported through code scanning alerts, not an issue. */
const NOT_REPORTED = new Set(["codeql.yml"]);

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflows = readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({
    file,
    workflow: parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow,
  }));

const scheduled = workflows.filter(
  ({ file, workflow }) => "schedule" in workflow.on && !NOT_REPORTED.has(file),
);

describe("the job that reports a failed scheduled run", () => {
  it("covers every scheduled workflow but CodeQL's, and finds them rather than passing over none", () => {
    expect(scheduled.map(({ file }) => file).sort()).toEqual([
      "benchmarks.yml",
      "ci.yml",
      "core.yml",
    ]);
    // The witness: CodeQL is scheduled too, and is left out on purpose.
    expect(
      workflows.find(({ file }) => file === "codeql.yml")?.workflow.on,
    ).toHaveProperty("schedule");
  });

  describe.each(scheduled)("$file", ({ workflow }) => {
    const { jobs } = workflow;
    const report = jobs[REPORT];

    it("has it, last, waiting for every other job but the Full CI gate", () => {
      expect(report).toBeDefined();
      expect(Object.keys(jobs).at(-1)).toBe(REPORT);
      expect([report?.needs ?? []].flat().sort()).toEqual(
        Object.keys(jobs)
          .filter((id) => id !== REPORT && id !== "gate")
          .sort(),
      );
      // Nothing waits for it, so a report that fails cannot fail a run.
      for (const [id, job] of Object.entries(jobs)) {
        expect([job.needs ?? []].flat(), id).not.toContain(REPORT);
      }
    });

    it("runs only after a failed job, and only for a schedule, so no pull request run can open an issue", () => {
      expect(report?.if).toBe(
        "${{ failure() && github.event_name == 'schedule' }}",
      );
    });

    it("may write issues and read the run, and nothing else", () => {
      expect(report?.permissions).toEqual({
        contents: "read",
        actions: "read",
        issues: "write",
      });
      expect(report?.["runs-on"]).toBe("ubuntu-latest");
    });

    it("runs the script with the workflow's own token", () => {
      const steps = report?.steps ?? [];
      const call = steps.at(-1);
      expect(call?.run).toBe("scripts/report-nightly-failure.sh");
      expect(call?.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
      // Only the script is fetched.
      const checkout = steps.find((step) =>
        step.uses?.startsWith("actions/checkout"),
      );
      expect(checkout?.with).toMatchObject({
        "persist-credentials": false,
        "sparse-checkout": "scripts/report-nightly-failure.sh",
      });
      expect(steps).toHaveLength(2);
    });
  });

  it("is the only place any workflow can write an issue, and no workflow grants it for the whole run", () => {
    const holders = workflows.flatMap(({ file, workflow }) => [
      ...(workflow.permissions?.issues === undefined
        ? []
        : [`${file}: workflow`]),
      ...Object.entries(workflow.jobs)
        .filter(([, job]) => job.permissions?.issues !== undefined)
        .map(([id]) => `${file}: ${id}`),
    ]);
    expect(holders.sort()).toEqual(
      scheduled.map(({ file }) => `${file}: ${REPORT}`).sort(),
    );
  });
});

describe("scripts/report-nightly-failure.sh", () => {
  const scratch = mkdtempSync(join(tmpdir(), "nightly-report-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * A stand-in for `gh` that records each call on a line of its own, keeps
   * the body file `issue create` is given, and answers what the test sets.
   */
  function fakeGh(name: string): { bin: string; dir: string } {
    const dir = join(scratch, name);
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      [
        "#!/bin/bash",
        'echo "$*" >> "$FAKE_DIR/calls"',
        'if [ "${FAKE_FAIL:-}" = "$1 $2" ]; then echo "gh: HTTP 500" >&2; exit 1; fi',
        'case "$1 $2" in',
        '  "issue list") printf "%s" "$FAKE_ISSUES" ;;',
        '  "run view") printf "%s" "$FAKE_JOBS" ;;',
        '  "issue create")',
        "    while [ $# -gt 0 ]; do",
        '      if [ "$1" = --body-file ]; then cp "$2" "$FAKE_DIR/body"; fi',
        "      shift",
        "    done",
        '    echo "https://github.com/withmarfa/marfa/issues/9999" ;;',
        '  "issue comment") ;;',
        '  *) echo "unexpected: $*" >&2; exit 97 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(gh, 0o755);
    return { bin, dir };
  }

  const JOBS = JSON.stringify({
    jobs: [
      { name: "Classify changes", conclusion: "success" },
      { name: "Conformance shard (device 2/4)", conclusion: "failure" },
      { name: "CLI scenarios", conclusion: "failure" },
      { name: "Conformance statuses", conclusion: "skipped" },
      { name: "Report a failed night", conclusion: null },
    ],
  });

  function run(
    name: string,
    fake: Record<string, string> = {},
    env: Record<string, string> = {},
  ): { status: number; calls: string[]; body: string; output: string } {
    const { bin, dir } = fakeGh(name);
    let status = 0;
    let output: string;
    try {
      output = execFileSync("bash", [SCRIPT], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          FAKE_DIR: dir,
          FAKE_JOBS: JOBS,
          FAKE_ISSUES: "[]",
          GH_TOKEN: "test-token",
          GITHUB_REPOSITORY: "withmarfa/marfa",
          GITHUB_WORKFLOW: "CI",
          GITHUB_RUN_ID: "424242",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
          ...fake,
          ...env,
        },
        stdio: "pipe",
        encoding: "utf8",
      });
    } catch (error) {
      const failed = error as {
        status: number;
        stdout: string;
        stderr: string;
      };
      status = failed.status;
      output = failed.stdout + failed.stderr;
    }
    const read = (file: string): string => {
      try {
        return readFileSync(join(dir, file), "utf8");
      } catch {
        return "";
      }
    };
    return {
      status,
      calls: read("calls").split("\n").filter(Boolean),
      body: read("body"),
      output,
    };
  }

  const isCall = (verb: string) => (call: string) => call.startsWith(verb);

  it("opens one issue when none is open, with the labels, the run, the commit and the jobs that failed", () => {
    const result = run("none-open");
    expect(result.status).toBe(0);
    const creates = result.calls.filter(isCall("issue create"));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("--repo withmarfa/marfa");
    expect(creates[0]).toContain("--title Nightly failed: CI");
    expect(creates[0]).toContain("--label needs-triage");
    expect(creates[0]).toContain("--label ci");
    expect(result.calls.filter(isCall("issue comment"))).toEqual([]);
    // The sections of an issue, in order, for an engineer who knows nothing else.
    const headings = [...result.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Summary",
      "Context",
      "Acceptance criteria",
      "Out of scope",
      "Notes",
    ]);
    expect(result.body).toContain(
      "https://github.com/withmarfa/marfa/actions/runs/424242",
    );
    expect(result.body).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(result.body).toContain("- Conformance shard (device 2/4)");
    expect(result.body).toContain("- CLI scenarios");
    // Only a job that failed is named.
    expect(result.body).not.toContain("Classify changes");
    expect(result.body).not.toContain("Conformance statuses");
    expect(result.body).toContain("The nightly run passes.");
  });

  it("says so when no job ended as failed, rather than leaving the list empty", () => {
    const result = run("no-failed-job", {
      FAKE_JOBS: JSON.stringify({
        jobs: [{ name: "Image", conclusion: "cancelled" }],
      }),
    });
    expect(result.status).toBe(0);
    expect(result.body).toContain("None ended as failed");
  });

  it("names the workflow whose run failed", () => {
    const result = run("core", {}, { GITHUB_WORKFLOW: "Core" });
    expect(result.status).toBe(0);
    expect(result.calls.find(isCall("issue create"))).toContain(
      "--title Nightly failed: Core",
    );
  });

  it("comments on the open issue instead of opening another", () => {
    const result = run("one-open", {
      FAKE_ISSUES: JSON.stringify([
        { number: 77, title: "Nightly failed: CI" },
      ]),
    });
    expect(result.status).toBe(0);
    expect(result.calls.filter(isCall("issue create"))).toEqual([]);
    const comments = result.calls.filter(isCall("issue comment"));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("issue comment 77");
    expect(comments[0]).toContain("--repo withmarfa/marfa");
    expect(comments[0]).toContain(
      "https://github.com/withmarfa/marfa/actions/runs/424242",
    );
  });

  it("asks only for an open issue with that exact title, and opens one when the search finds only others", () => {
    const result = run("similar", {
      FAKE_ISSUES: JSON.stringify([
        { number: 5, title: "Nightly failed: CI (macOS)" },
        { number: 6, title: "Why Nightly failed: CI is slow" },
        { number: 7, title: "Nightly failed: Core" },
      ]),
    });
    expect(result.status).toBe(0);
    const lists = result.calls.filter(isCall("issue list"));
    expect(lists).toHaveLength(1);
    expect(lists[0]).toContain("--state open");
    expect(lists[0]).toContain('"Nightly failed: CI" in:title');
    expect(result.calls.filter(isCall("issue create"))).toHaveLength(1);
    expect(result.calls.filter(isCall("issue comment"))).toEqual([]);
  });

  it.each([
    ["the search fails", "issue list"],
    ["the failed jobs cannot be read", "run view"],
  ])("fails loudly when %s, and opens nothing", (_, fail) => {
    const result = run(`fail-${fail.replace(" ", "-")}`, { FAKE_FAIL: fail });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("HTTP 500");
    expect(result.calls.filter(isCall("issue create"))).toEqual([]);
  });

  it("fails loudly when the issue cannot be opened", () => {
    const result = run("create-fails", { FAKE_FAIL: "issue create" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("HTTP 500");
  });

  it("fails loudly when the comment cannot be posted", () => {
    const result = run("comment-fails", {
      FAKE_FAIL: "issue comment",
      FAKE_ISSUES: JSON.stringify([
        { number: 77, title: "Nightly failed: CI" },
      ]),
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("HTTP 500");
  });

  it("fails loudly when the search answers something that is not a list of issues", () => {
    const result = run("garbled", { FAKE_ISSUES: "<html>rate limited</html>" });
    expect(result.status).not.toBe(0);
    expect(result.calls.filter(isCall("issue create"))).toEqual([]);
  });

  it.each([
    "GH_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_WORKFLOW",
    "GITHUB_RUN_ID",
  ])(
    "fails without %s rather than reporting against the wrong place",
    (name) => {
      const result = run(`missing-${name}`, {}, { [name]: "" });
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
    },
  );
});
