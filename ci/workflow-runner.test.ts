/**
 * Literal routing keeps public pull requests off personal and paid runners.
 * The one expression is the nightly macOS choice of two jobs, pinned whole.
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
  "core.yml:core",
  "release.yml:build",
]);

// Ubuntu for a pull request, a push and a dispatch that does not ask, macOS
// for the nightly and a dispatch that does.
const NIGHTLY_MAC_RUNNER =
  "${{ (github.event_name == 'schedule' || inputs.macos) && 'macos-26' || 'ubuntu-latest' }}";

const NIGHTLY_MAC_JOBS = new Set([
  "ci.yml:conformance",
  "ci.yml:cli-scenarios",
]);

interface Workflow {
  jobs: Record<string, { "runs-on"?: unknown; concurrency?: unknown }>;
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
      const key = `${file}:${job}`;
      const expected = MAC_JOBS.has(key)
        ? "macos-26"
        : NIGHTLY_MAC_JOBS.has(key)
          ? NIGHTLY_MAC_RUNNER
          : "ubuntu-latest";
      expect(config["runs-on"], `${file}: ${job}`).toEqual(expected);
      expect(config.concurrency, `${file}: ${job}`).toBeUndefined();
    }
  });

  it.each(["ci.yml", "core.yml", "codeql.yml"])(
    "%s cancels only superseded pull requests and preserves every other run",
    (file) => {
      const { concurrency } = parse(
        readFileSync(join(WORKFLOWS, file), "utf8"),
      ) as { concurrency?: unknown };
      expect(concurrency).toEqual({
        group:
          "${{ github.workflow }}-${{ github.event_name }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}",
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

  it("finds every macOS job named by the policy", () => {
    for (const key of [...MAC_JOBS, ...NIGHTLY_MAC_JOBS]) {
      const [file = "", job = ""] = key.split(":");
      expect(
        jobsOf(readFileSync(join(WORKFLOWS, file), "utf8"))[job],
        key,
      ).toBeDefined();
    }
  });
});
