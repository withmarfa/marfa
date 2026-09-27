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

// Two queues, so the local pool never runs more than two jobs at once.
const MAC_JOBS = new Map([
  ["ci.yml:core-checks", "marfa-mac-build"],
  ["ci.yml:conformance", "marfa-mac-suite"],
  ["ci.yml:cli-scenarios", "marfa-mac-suite"],
  ["core.yml:core", "marfa-mac-build"],
  ["release.yml:build", "marfa-mac-build"],
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
      const queue = MAC_JOBS.get(`${file}:${job}`);
      if (queue) {
        expect(config.concurrency, `${file}: ${job}`).toEqual({
          group: queue,
          "cancel-in-progress": false,
          queue: "max",
        });
      } else {
        expect(config.concurrency, `${file}: ${job}`).toBeUndefined();
      }
    }
  });

  it.each(["ci.yml", "core.yml"])(
    "%s cancels a branch's superseded run and keeps one waiting run on main",
    (file) => {
      const { concurrency } = parse(
        readFileSync(join(WORKFLOWS, file), "utf8"),
      ) as { concurrency?: unknown };
      expect(concurrency).toEqual({
        group: "${{ github.workflow }}-${{ github.ref }}",
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
