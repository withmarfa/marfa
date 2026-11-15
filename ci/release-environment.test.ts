// The credentials that sign, publish and push to the tap belong to the `release` environment, which only tags can use.
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

interface Step {
  name?: string;
  run?: string;
  if?: string;
}
interface Job {
  if?: string;
  environment?: unknown;
  permissions?: Record<string, string>;
  steps: Step[];
}

const jobs = (
  parse(readFileSync(join(WORKFLOWS, "release.yml"), "utf8")) as {
    jobs: Record<string, Job>;
  }
).jobs;

// Reads of the credentials this change moves; `github.token` and `GITHUB_TOKEN` are the run's own.
const CREDENTIAL = /secrets\.(APPLE_[A-Z0-9_]+|HOMEBREW_TAP_TOKEN)/g;

describe("a release's credentials are read only in the release environment", () => {
  const readers = Object.entries(jobs).filter(
    ([, job]) => JSON.stringify(job).match(CREDENTIAL) !== null,
  );

  it("finds the jobs that read them rather than passing over none", () => {
    expect(readers.map(([name]) => name).sort()).toEqual(["sign", "tap"]);
  });

  it("names no repository secret outside those jobs, and no other credential in them", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const secrets = JSON.stringify(job).match(/secrets\.[A-Z0-9_]+/g) ?? [];
      for (const secret of secrets) {
        const allowed =
          secret === "secrets.GITHUB_TOKEN" || CREDENTIAL.test(secret);
        CREDENTIAL.lastIndex = 0;
        expect(allowed, `${name} reads ${secret}`).toBe(true);
      }
    }
  });

  it("runs the jobs that read them, and the publish job, in the release environment, for a tag only", () => {
    expect(jobs.tap?.environment).toBe("release");
    expect(jobs.publish?.environment).toBe("release");
    expect(jobs.tap?.if).toBe("github.event_name == 'push'");
    expect(jobs.publish?.if).toBe("github.event_name == 'push'");
    expect(jobs.sign?.environment).toBe(
      "${{ github.event_name == 'push' && 'release' || '' }}",
    );
  });

  it("uses no other environment, so a branch's dispatch is never held by the tag rule", () => {
    const named = Object.entries(jobs)
      .filter(([, job]) => job.environment !== undefined)
      .map(([name]) => name)
      .sort();
    expect(named).toEqual(["publish", "sign", "tap"]);
  });

  it("reads the credentials in a step that runs only for a tag", () => {
    const step = jobs.sign?.steps.find((candidate) =>
      JSON.stringify(candidate).includes("secrets.APPLE_DEVELOPER_ID_P12"),
    );
    expect(step?.if).toBe("github.event_name == 'push'");
  });
});

describe("the release workflow runs on a tag or a dispatch, and the dispatch reads nothing secret", () => {
  const on = (
    parse(readFileSync(join(WORKFLOWS, "release.yml"), "utf8")) as {
      on: { push?: { tags?: string[] }; workflow_dispatch?: unknown };
    }
  ).on;

  it("starts on a v tag push and a dispatch", () => {
    expect(Object.keys(on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(on.push?.tags).toEqual(["v*"]);
    expect(on.workflow_dispatch).toBeDefined();
  });
});

describe("Require green CI accepts a run of main only for a tag", () => {
  const script = jobs["require-green-ci"]?.steps.find((step) =>
    (step.run ?? "").includes("workflow_runs"),
  )?.run;

  interface Ci {
    event: string;
    branch: string;
  }

  // The stand-in applies the step's own jq filter to a canned answer.
  function gate(eventName: string, runs: Ci[]) {
    expect(script).toBeTypeOf("string");
    const directory = mkdtempSync(join(tmpdir(), "marfa-require-ci-"));
    try {
      const answer = join(directory, "answer.json");
      writeFileSync(
        answer,
        JSON.stringify({
          workflow_runs: runs.map((run) => ({
            event: run.event,
            head_branch: run.branch,
          })),
        }),
      );
      writeFileSync(
        join(directory, "gh"),
        `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = --jq ]; then filter="$2"; fi
  shift
done
jq -r "$filter" "${answer}"
`,
      );
      chmodSync(join(directory, "gh"), 0o755);
      const ran = spawnSync(
        "bash",
        ["-e", "-c", `PATH="${directory}:$PATH"\n${script ?? "exit 1"}`],
        {
          encoding: "utf8",
          env: {
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            GITHUB_EVENT_NAME: eventName,
            GITHUB_SHA: "0".repeat(40),
            GITHUB_REPOSITORY: "withmarfa/marfa",
            GH_TOKEN: "unused",
          },
        },
      );
      return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("accepts a push run and a dispatch run of main for a tag", () => {
    expect(gate("push", [{ event: "push", branch: "main" }]).status).toBe(0);
    expect(
      gate("push", [{ event: "workflow_dispatch", branch: "main" }]).status,
    ).toBe(0);
  });

  it("refuses a dispatch run of another branch, a push run of one, and a pull request's run for a tag", () => {
    for (const run of [
      { event: "workflow_dispatch", branch: "some-branch" },
      { event: "push", branch: "some-branch" },
      { event: "pull_request", branch: "main" },
      { event: "pull_request", branch: "some-branch" },
    ]) {
      const refused = gate("push", [run]);
      expect(refused.status, JSON.stringify(run)).toBe(1);
      expect(refused.said).toContain("No successful ci.yml run");
    }
  });

  it("lets a dry run rest on any green run of the commit, which signs and publishes nothing", () => {
    expect(
      gate("workflow_dispatch", [{ event: "pull_request", branch: "topic" }])
        .status,
    ).toBe(0);
  });
});
