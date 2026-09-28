/** Literal routing keeps public pull requests off personal and paid runners. */
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
  "ci.yml:conformance",
  "ci.yml:cli-scenarios",
  "core.yml:core",
  "release.yml:build",
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
      const expected = MAC_JOBS.has(`${file}:${job}`)
        ? "macos-26"
        : "ubuntu-latest";
      expect(config["runs-on"], `${file}: ${job}`).toEqual(expected);
      expect(config.concurrency, `${file}: ${job}`).toBeUndefined();
    }
  });

  it.each(["ci.yml", "core.yml"])(
    "%s cancels a branch's superseded run and preserves every main commit",
    (file) => {
      const { concurrency } = parse(
        readFileSync(join(WORKFLOWS, file), "utf8"),
      ) as { concurrency?: unknown };
      expect(concurrency).toEqual({
        group:
          "${{ github.workflow }}-${{ github.ref }}-${{ github.ref == 'refs/heads/main' && github.sha || '' }}",
        "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}",
      });
    },
  );

  it("finds every macOS job named by the policy", () => {
    for (const key of MAC_JOBS.keys()) {
      const [file = "", job = ""] = key.split(":");
      expect(
        jobsOf(readFileSync(join(WORKFLOWS, file), "utf8"))[job],
        key,
      ).toBeDefined();
    }
  });
});
