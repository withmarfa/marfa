/**
 * Literal routing keeps public pull requests off personal and paid runners.
 * The only expression is a per-architecture matrix's runner, pinned whole.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const WORKFLOWS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
);

const MAC_JOBS = new Set([
  "ci.yml:core-checks",
  "ci.yml:rust-contract-macos",
  "core-live.yml:live",
  "release.yml:programs-macos",
  "release.yml:sign",
  "ci.yml:control-socket",
]);

// The server image is built, each Linux archive is run, and the install is
// proved on a runner of each platform they ship for, and all are standard
// GitHub-hosted runners. The install proof also runs on the Mac the archive is
// signed on.
const PER_ARCHITECTURE_JOBS = new Map([
  ["release.yml:image", ["ubuntu-latest", "ubuntu-24.04-arm"]],
  ["release.yml:run-linux", ["ubuntu-latest", "ubuntu-24.04-arm"]],
  [
    "release.yml:install-proof",
    ["macos-26", "ubuntu-latest", "ubuntu-24.04-arm"],
  ],
]);
const PER_ARCHITECTURE_RUNNER = "${{ matrix.runner }}";

interface Workflow {
  jobs: Record<
    string,
    {
      "runs-on"?: unknown;
      concurrency?: unknown;
      uses?: unknown;
      strategy?: { matrix?: { include?: { runner?: string }[] } };
    }
  >;
}

// Parse YAML so quoted labels, arrays and expressions cannot bypass the rule.
function jobsOf(text: string): Workflow["jobs"] {
  return (parse(text) as Workflow).jobs;
}

const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

describe("jobs use standard GitHub-hosted runners", () => {
  it("finds workflows and jobs rather than passing over an empty tree", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(
        Object.keys(jobsOf(readFileSync(join(WORKFLOWS, file), "utf8"))).length,
      ).toBeGreaterThan(0);
    }
  });

  it.each(files)("%s preserves each job's platform", (file) => {
    for (const [job, config] of Object.entries(
      jobsOf(readFileSync(join(WORKFLOWS, file), "utf8")),
    )) {
      // A job that calls a workflow of this repository has no runner of its
      // own; the jobs of the workflow it calls are held to the policy here.
      if (config.uses !== undefined) {
        expect(config.uses, `${file}: ${job}`).toMatch(
          /^\.\/\.github\/workflows\/[\w-]+\.yml$/,
        );
        expect(config["runs-on"], `${file}: ${job}`).toBeUndefined();
        expect(config.concurrency, `${file}: ${job}`).toBeUndefined();
        continue;
      }
      const key = `${file}:${job}`;
      const allowed = PER_ARCHITECTURE_JOBS.get(key);
      if (allowed !== undefined) {
        expect(config["runs-on"], key).toEqual(PER_ARCHITECTURE_RUNNER);
        const runners = (config.strategy?.matrix?.include ?? []).map(
          (entry) => entry.runner,
        );
        expect(runners.length, key).toBeGreaterThan(0);
        for (const runner of runners) {
          expect(allowed, `${key}: ${runner ?? ""}`).toContain(runner);
        }
        expect(config.concurrency, key).toBeUndefined();
        continue;
      }
      const expected = MAC_JOBS.has(key) ? "macos-26" : "ubuntu-latest";
      expect(config["runs-on"], `${file}: ${job}`).toEqual(expected);
      expect(config.concurrency, `${file}: ${job}`).toBeUndefined();
    }
  });

  it.each(["ci.yml", "codeql.yml"])(
    "%s cancels only a superseded run of the same pull request and draft state, and preserves every other run",
    (file) => {
      const { concurrency } = parse(
        readFileSync(join(WORKFLOWS, file), "utf8"),
      ) as { concurrency?: unknown };
      expect(concurrency).toEqual({
        group:
          "${{ github.workflow }}-${{ github.event_name }}-${{ github.event_name == 'pull_request' && format('{0}-{1}', github.ref, github.event.pull_request.draft && 'draft' || 'ready') || github.run_id }}",
        "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      });
    },
  );

  it("runs on macOS once a night and when asked by hand, never by default", () => {
    const { on } = parse(readFileSync(join(WORKFLOWS, "ci.yml"), "utf8")) as {
      on: {
        schedule?: { cron: string }[];
        workflow_dispatch?: { inputs?: Record<string, unknown> };
      };
    };
    expect(on.schedule).toHaveLength(1);
    expect(on.schedule?.[0]?.cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    expect(on.workflow_dispatch?.inputs?.macos).toMatchObject({
      type: "boolean",
      default: false,
    });
  });

  it("finds every per-architecture job named by the policy", () => {
    for (const key of PER_ARCHITECTURE_JOBS.keys()) {
      const [file = "", job = ""] = key.split(":");
      expect(
        jobsOf(readFileSync(join(WORKFLOWS, file), "utf8"))[job],
        key,
      ).toBeDefined();
    }
  });

  it("finds every macOS job named by the policy", () => {
    for (const key of MAC_JOBS) {
      const [file = "", job = ""] = key.split(":");
      expect(
        jobsOf(readFileSync(join(WORKFLOWS, file), "utf8"))[job],
        key,
      ).toBeDefined();
    }
  });
});
