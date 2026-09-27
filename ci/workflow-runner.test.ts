/**
 * Standard hosted runners isolate pull-request code from developer machines.
 * Literal labels also keep a variable or a larger runner from changing that
 * security and billing boundary without a reviewed policy change.
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

function isStandardHosted(runner: unknown): boolean {
  return (
    runner === "ubuntu-24.04" ||
    runner === "ubuntu-latest" ||
    runner === "macos-26"
  );
}

const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

describe("every job runs on a standard GitHub-hosted runner", () => {
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
        : file === "release.yml" && job === "publish"
          ? "ubuntu-latest"
          : "ubuntu-24.04";
      expect(config["runs-on"], `${file}: ${job}`).toBe(expected);
      expect(isStandardHosted(config["runs-on"])).toBe(true);
      // Separate VMs do not compete for a developer machine. Workflow-level
      // cancellation still applies; no job should wait for the old host lock.
      expect(
        config.concurrency,
        `${file}: ${job} serializes isolated VMs`,
      ).toBeUndefined();
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

  it.each([
    "self-hosted",
    ["self-hosted", "macOS", "ARM64"],
    "macos-26-large",
    "macos-26-xlarge",
    "${{ vars.CI_RUNNER || 'ubuntu-24.04' }}",
    undefined,
  ])("refuses nonstandard selection %j", (runner) => {
    expect(isStandardHosted(runner)).toBe(false);
  });

  it.each(["ubuntu-24.04", "ubuntu-latest", "macos-26"])(
    "accepts %s",
    (runner) => {
      expect(isStandardHosted(runner)).toBe(true);
    },
  );
});
