/** Literal routing prevents an accidental return to paid hosted macOS. */
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

describe("jobs use local macOS and Blacksmith, with hosted release publishing", () => {
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
        ? ["self-hosted", "macOS", "ARM64", "withmarfa", "aic-mbp"]
        : file === "release.yml" && job === "publish"
          ? "ubuntu-latest"
          : "blacksmith-2vcpu-ubuntu-2404";
      expect(config["runs-on"], `${file}: ${job}`).toEqual(expected);
      if (MAC_JOBS.has(`${file}:${job}`)) {
        expect(config.concurrency, `${file}: ${job}`).toEqual({
          group: "marfa-suite-shared-host",
          "cancel-in-progress": false,
          queue: "max",
        });
      } else {
        expect(config.concurrency, `${file}: ${job}`).toBeUndefined();
      }
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
