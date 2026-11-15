// A release attests the files a person downloads and the server image, from the one job that publishes.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

const WORKFLOWS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
);

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  environment?: unknown;
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
}

const workflows = readdirSync(WORKFLOWS)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({
    file,
    workflow: parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow,
  }));
const release = workflows.find(({ file }) => file === "release.yml")!.workflow;
const publish = release.jobs.publish!;
const steps = publish.steps ?? [];

const ATTEST = /^actions\/attest-build-provenance@[0-9a-f]{40}( |$)/;
const attesting = (list: Step[]) =>
  list.filter((step) => ATTEST.test(step.uses ?? ""));

function at(name: string): number {
  const found = steps.findIndex((step) => step.name?.startsWith(name));
  expect(found, `a step named "${name}"`).toBeGreaterThanOrEqual(0);
  return found;
}

describe("the release attests from the publish job, pinned by commit", () => {
  it("finds the attestation steps rather than passing over none", () => {
    expect(attesting(steps)).toHaveLength(4);
  });

  it("uses the action in no other job or workflow, and by commit only", () => {
    for (const { file, workflow } of workflows) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          if (!(step.uses ?? "").includes("attest")) continue;
          expect(
            file === "release.yml" && name === "publish",
            `${file} ${name} attests`,
          ).toBe(true);
          expect(step.uses, `${step.uses ?? ""} is pinned`).toMatch(ATTEST);
        }
      }
    }
  });

  it("gives the write permissions to the job that attests and to no other", () => {
    for (const { file, workflow } of workflows) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const writes =
          job.permissions?.attestations === "write" ||
          job.permissions?.["id-token"] === "write";
        expect(
          writes,
          `${file} ${name} writes attestations or an identity`,
        ).toBe(file === "release.yml" && name === "publish");
      }
    }
    expect(publish.permissions).toMatchObject({
      attestations: "write",
      "id-token": "write",
    });
    expect(publish.permissions).not.toHaveProperty("artifact-metadata");
  });

  it("runs only for a tag, in the release environment, so a dry run writes none", () => {
    expect(publish.if).toBe("github.event_name == 'push'");
    expect(publish.environment).toBe("release");
    for (const step of attesting(steps)) {
      expect(step.if).toBeUndefined();
    }
  });
});

describe("the archives and the checksum file", () => {
  const step = steps[at("Attest the archives and the checksum file")];

  it("attests the files the draft holds, which a person downloads", () => {
    const download = steps[at("Check the release's archives")]?.run ?? "";
    expect(download).toContain("--pattern 'marfa-*'");
    expect(download).toContain('--dir "$RUNNER_TEMP/held"');
    expect(step?.with?.["subject-path"]).toBe(
      "${{ runner.temp }}/held/marfa-*",
    );
  });

  it("attests after the checksums have vouched for them and before anything is tagged or published to npm", () => {
    expect(at("Attest the archives")).toBeGreaterThan(
      at("Check the release's archives"),
    );
    expect(at("Attest the archives")).toBeLessThan(at("Tag the server image"));
    expect(at("Attest the archives")).toBeLessThan(at("Publish @withmarfa/"));
  });
});

describe("the server image", () => {
  const names = [
    "Attest the server image index",
    "Attest the linux/amd64 server image",
    "Attest the linux/arm64 server image",
  ];

  it("attests the index and each platform's image, and stores each in the registry", () => {
    const outputs = ["index", "amd64", "arm64"] as const;
    names.forEach((name, position) => {
      const step = steps[at(name)];
      expect(step?.with?.["subject-name"]).toBe("${{ env.IMAGE }}");
      expect(step?.with?.["subject-digest"]).toBe(
        `\${{ steps.image.outputs.${outputs[position] ?? ""} }}`,
      );
      expect(step?.with?.["push-to-registry"]).toBe(true);
    });
  });

  it("attests after the tag exists and while the registry login is still held, and before npm", () => {
    for (const name of names) {
      expect(at(name)).toBeGreaterThan(at("Tag the server image"));
      expect(at(name)).toBeLessThan(at("Check the published server image"));
      expect(at(name)).toBeLessThan(at("Publish @withmarfa/"));
    }
    const logout = steps.findIndex((step) =>
      (step.run ?? "").includes("docker logout"),
    );
    expect(logout).toBeGreaterThan(at(names[2] ?? ""));
  });

  describe("reading the digests", () => {
    const script = steps[at("Read the digests the image attestations")]?.run;
    const AMD = `sha256:${"a".repeat(64)}`;
    const ARM = `sha256:${"b".repeat(64)}`;
    const INDEX = `sha256:${"c".repeat(64)}`;

    function read(index: string, amd64 = AMD, arm64 = ARM) {
      expect(script).toBeTypeOf("string");
      const directory = mkdtempSync(join(tmpdir(), "marfa-attest-digests-"));
      try {
        mkdirSync(join(directory, "bin"));
        mkdirSync(join(directory, "digests"));
        writeFileSync(
          join(directory, "bin", "docker"),
          `#!/bin/sh\nprintf '%s\\n' '${index}'\n`,
        );
        chmodSync(join(directory, "bin", "docker"), 0o755);
        writeFileSync(join(directory, "digests", "amd64"), `${amd64}\n`);
        writeFileSync(join(directory, "digests", "arm64"), `${arm64}\n`);
        writeFileSync(join(directory, "output"), "");
        const ran = spawnSync(
          "bash",
          [
            "-e",
            "-c",
            `PATH="${join(directory, "bin")}:$PATH"\n${script ?? "exit 1"}`,
          ],
          {
            cwd: directory,
            encoding: "utf8",
            env: {
              PATH: process.env.PATH ?? "",
              GITHUB_OUTPUT: join(directory, "output"),
              IMAGE: "ghcr.io/example/server",
              VERSION: "0.1.0",
            },
          },
        );
        return {
          status: ran.status,
          said: `${ran.stdout}${ran.stderr}`,
          output: readFileSync(join(directory, "output"), "utf8"),
        };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    it("names the version's index and the two pushed digests", () => {
      const run = read(INDEX);
      expect(run.status, run.said).toBe(0);
      expect(run.output).toBe(`index=${INDEX}\namd64=${AMD}\narm64=${ARM}\n`);
    });

    it("refuses an answer that is not a digest, so no attestation is for nothing", () => {
      for (const bad of ["", "latest", "sha256:abc"]) {
        const run = read(bad);
        expect(run.status).toBe(1);
        expect(run.said).toContain("Not an image digest");
        expect(run.output).toBe("");
      }
      expect(read(INDEX, "", ARM).status).toBe(1);
    });
  });
});
