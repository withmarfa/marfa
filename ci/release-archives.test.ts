/**
 * The release carries the `marfa` command line for four platforms, each as
 * its own archive, with one checksum file. It is published only when every
 * archive built, and each archive's binary has been unpacked and run.
 */
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
const PACK = join(ROOT, "scripts", "release", "pack-cli.sh");
const CHECKSUMS = join(ROOT, "scripts", "release", "write-checksums.sh");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: Record<string, string>[] };
  };
  steps: Step[];
}

const jobs = (
  parse(
    readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
  ) as { jobs: Record<string, Job> }
).jobs;

const needs = (job: Job | undefined): string[] => [job?.needs ?? []].flat();

/** Runs `script` in a fresh folder holding `files`, and says how it ended. */
function inFolder(
  files: Record<string, string>,
  script: (directory: string) => ReturnType<typeof spawnSync>,
) {
  const directory = mkdtempSync(join(tmpdir(), "marfa-release-archives-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(directory, name), text);
      chmodSync(join(directory, name), 0o755);
    }
    return script(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const reports = (version: string) => `#!/bin/sh\necho "marfa ${version}"\n`;

describe("the workflow builds the command line for every platform", () => {
  it("builds both Linux architectures on a runner of their own, stopping at the first failure", () => {
    const linux = jobs["cli-linux"];
    expect(linux?.strategy?.["fail-fast"]).toBe(true);
    expect(
      linux?.strategy?.matrix?.include?.map(({ arch, runner, target }) => [
        arch,
        runner,
        target,
      ]),
    ).toEqual([
      ["x86_64", "ubuntu-latest", "x86_64-unknown-linux-musl"],
      ["aarch64", "ubuntu-24.04-arm", "aarch64-unknown-linux-musl"],
    ]);
  });

  it("builds the Linux binary locked, stamped, and statically linked", () => {
    const steps = jobs["cli-linux"]?.steps ?? [];
    const stamp = steps.findIndex((step) =>
      (step.run ?? "").includes("stamp-version.sh"),
    );
    const build = steps.findIndex((step) =>
      (step.run ?? "").includes("cargo build --release --locked -p marfa-cli"),
    );
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(stamp);
    expect(steps[build]?.run).toContain('--target "$TARGET"');
    expect(steps[build]?.run).toContain("musl-gcc");
  });

  it("builds the Intel Mac binary beside the Apple silicon one and runs it under Rosetta", () => {
    const build = jobs.build?.steps.find((step) =>
      (step.run ?? "").includes("--target x86_64-apple-darwin"),
    );
    expect(build?.run).toContain("arch -x86_64 ");
    const toolchain = jobs.build?.steps.find((step) =>
      step.uses?.startsWith("dtolnay/rust-toolchain"),
    );
    expect(toolchain?.with?.targets).toBe("x86_64-apple-darwin");
  });

  it("unpacks and runs every archive it makes", () => {
    const packs = [jobs.sign, jobs["cli-linux"]].flatMap((job) =>
      (job?.steps ?? []).filter((step) =>
        (step.run ?? "").includes("pack-cli.sh"),
      ),
    );
    expect(packs).toHaveLength(2);
    expect(JSON.stringify(jobs.sign?.steps)).toContain("arch -x86_64");
  });
});

describe("a release is published only when every archive built", () => {
  it("collects the signed macOS archives and both Linux archives before it publishes", () => {
    expect(needs(jobs.collect).sort()).toEqual(["build", "cli-linux", "sign"]);
    expect(needs(jobs.publish)).toContain("collect");
    expect(jobs.collect?.if).toBeUndefined();
  });

  it("publishes what the collect job uploaded, and no other artifact", () => {
    const publish = jobs.publish?.steps.find(
      (step) =>
        step.uses?.startsWith("actions/download-artifact") &&
        step.with?.path === "artifacts",
    );
    expect(publish?.with?.name).toBe(
      "release-${{ needs.build.outputs.version }}",
    );
    const upload = jobs.collect?.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    expect(upload?.with?.name).toBe(
      "release-${{ needs.build.outputs.version }}",
    );
    const uploaded = jobs.sign?.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    expect(uploaded?.with?.name).not.toBe(upload?.with?.name);
  });

  it("writes one checksum file for the four archives", () => {
    const step = jobs.collect?.steps.find((candidate) =>
      (candidate.run ?? "").includes("write-checksums.sh"),
    );
    for (const platform of [
      "darwin-arm64",
      "darwin-x86_64",
      "linux-aarch64",
      "linux-x86_64",
    ]) {
      expect(step?.run).toContain(`"marfa-$VERSION-${platform}.tar.gz"`);
    }
    expect(step?.run).toContain('"marfa-$VERSION-checksums.txt"');
  });
});

describe("pack-cli.sh", () => {
  const archive = (directory: string) => join(directory, "out.tar.gz");

  it("packs the binary alone and accepts one that reports the version", () => {
    const result = inFolder({ binary: reports("0.0.9") }, (directory) =>
      spawnSync(
        "bash",
        [PACK, join(directory, "binary"), archive(directory), "0.0.9"],
        {
          encoding: "utf8",
        },
      ),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("out.tar.gz: marfa 0.0.9");
  });

  it("refuses a binary that reports another version", () => {
    const result = inFolder({ binary: reports("0.0.8") }, (directory) =>
      spawnSync(
        "bash",
        [PACK, join(directory, "binary"), archive(directory), "0.0.9"],
        {
          encoding: "utf8",
        },
      ),
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("reports 'marfa 0.0.8', not 'marfa 0.0.9'");
  });

  it("runs the extracted binary through the command it is given", () => {
    const result = inFolder({ binary: "not a program" }, (directory) => {
      writeFileSync(
        join(directory, "runner"),
        '#!/bin/sh\necho "marfa 0.0.9"\n',
      );
      chmodSync(join(directory, "runner"), 0o755);
      return spawnSync(
        "bash",
        [
          PACK,
          join(directory, "binary"),
          archive(directory),
          "0.0.9",
          join(directory, "runner"),
        ],
        { encoding: "utf8" },
      );
    });
    expect(result.status).toBe(0);
  });

  it("refuses a binary that is missing or empty", () => {
    const result = inFolder({ binary: "" }, (directory) =>
      spawnSync(
        "bash",
        [PACK, join(directory, "binary"), archive(directory), "0.0.9"],
        {
          encoding: "utf8",
        },
      ),
    );
    expect(result.status).toBe(1);
  });
});

describe("write-checksums.sh", () => {
  const run = (files: Record<string, string>, names: string[]) =>
    inFolder(files, (directory) =>
      spawnSync("bash", [CHECKSUMS, "sums.txt", ...names], {
        cwd: directory,
        encoding: "utf8",
      }),
    );

  it("covers each archive in the sha256sum format and verifies them", () => {
    let sums = "";
    const result = inFolder(
      { "a.tar.gz": "one", "b.tar.gz": "two" },
      (directory) => {
        const ran = spawnSync(
          "bash",
          [CHECKSUMS, "sums.txt", "a.tar.gz", "b.tar.gz"],
          {
            cwd: directory,
            encoding: "utf8",
          },
        );
        sums = readFileSync(join(directory, "sums.txt"), "utf8");
        return ran;
      },
    );
    expect(result.status).toBe(0);
    expect(sums.trim().split("\n")).toHaveLength(2);
    expect(sums).toMatch(
      /^[0-9a-f]{64} {2}a\.tar\.gz\n[0-9a-f]{64} {2}b\.tar\.gz\n$/,
    );
  });

  it("refuses an archive that is not there, naming it", () => {
    const result = run({ "a.tar.gz": "one" }, ["a.tar.gz", "missing.tar.gz"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing.tar.gz is missing or empty");
  });
});
