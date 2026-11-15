// A release refuses a draft or an image tag that was built from another commit.
import {
  chmodSync,
  existsSync,
  mkdirSync,
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

interface Step {
  name?: string;
  run?: string;
}

const workflow = parse(
  readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
) as { jobs: Record<string, { steps: Step[] }> };

const stepNamed = (name: string) =>
  workflow.jobs.publish?.steps.find((step) => step.name === name)?.run;

const draftStep = stepNamed("Draft the GitHub release");
const imageStep = stepNamed("Tag the server image");

const COMMIT = "c".repeat(40);
const OTHER = "d".repeat(40);
const DIGEST = `sha256:${"a".repeat(64)}`;

interface Release {
  isDraft: boolean;
  /** What the release's `targetCommitish` answers. */
  targetCommitish: string;
  assets: string[];
}

interface Outcome {
  status: number | null;
  said: string;
  /** Each write the step made, one per line. */
  writes: string[];
  /** How many times the step asked docker to inspect the tag. */
  inspects: number;
}

function inFolder(
  script: string | undefined,
  stubs: Record<string, string>,
  files: Record<string, string>,
): Outcome {
  expect(script).toBeTypeOf("string");
  const directory = mkdtempSync(join(tmpdir(), "marfa-release-draft-"));
  try {
    const bin = join(directory, "bin");
    const work = join(directory, "work");
    mkdirSync(bin);
    mkdirSync(work);
    const log = join(directory, "writes");
    writeFileSync(log, "");
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), `#!/bin/sh\nLOG="${log}"\n${body}`);
      chmodSync(join(bin, name), 0o755);
    }
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(work, name)), { recursive: true });
      writeFileSync(join(work, name), body);
    }
    const ran = spawnSync(
      "bash",
      ["-e", "-c", `PATH="${bin}:$PATH"\n${script ?? "exit 1"}`],
      {
        cwd: work,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: directory,
          VERSION: "0.1.0",
          IMAGE: "ghcr.io/withmarfa/marfa-server",
          GITHUB_SHA: COMMIT,
          GH_TOKEN: "unused",
        },
      },
    );
    return {
      status: ran.status,
      said: `${ran.stdout}${ran.stderr}`,
      writes: readFileSync(log, "utf8").split("\n").filter(Boolean),
      inspects: existsSync(`${log}.inspects`)
        ? readFileSync(`${log}.inspects`, "utf8").split("\n").filter(Boolean)
            .length
        : 0,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const ARCHIVES = {
  "artifacts/marfa-0.1.0-checksums.txt": "x",
  "artifacts/marfa-0.1.0-linux-x86_64.tar.gz": "x",
  "artifacts/marfa-0.1.0-darwin-arm64.tar.gz": "x",
};

function draft(release: Release | "none"): Outcome {
  const answer =
    release === "none"
      ? `echo "release not found" >&2; exit 1`
      : `case "$*" in
  *isDraft*) echo ${String(release.isDraft)} ;;
  *targetCommitish*) echo ${release.targetCommitish} ;;
  *assets*) printf '%s\\n' ${release.assets.map((name) => `"${name}"`).join(" ")} ;;
esac`;
  return inFolder(
    draftStep,
    {
      gh: `case "$1 $2" in
  "release view") ${answer} ;;
  *) echo "$*" >> "$LOG" ;;
esac
`,
    },
    ARCHIVES,
  );
}

describe("the draft of a release", () => {
  it("finds the step rather than passing over none", () => {
    expect(draftStep).toContain("gh release create");
  });

  it("is created for the commit the run builds", () => {
    const result = draft("none");
    expect(result.status, result.said).toBe(0);
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]).toContain("release create v0.1.0");
    expect(result.writes[0]).toContain(`--target ${COMMIT}`);
  });

  it("is given only the files it lacks when it was made for this commit", () => {
    const result = draft({
      isDraft: true,
      targetCommitish: COMMIT,
      assets: ["marfa-0.1.0-checksums.txt"],
    });
    expect(result.status, result.said).toBe(0);
    expect(result.writes).toEqual([
      "release upload v0.1.0 artifacts/marfa-0.1.0-darwin-arm64.tar.gz",
      "release upload v0.1.0 artifacts/marfa-0.1.0-linux-x86_64.tar.gz",
    ]);
  });

  it.each([
    ["another commit", OTHER],
    [
      "a branch name, as a draft made before the commit was recorded holds",
      "main",
    ],
  ])(
    "is refused, with nothing uploaded, when it was made for %s",
    (_, made) => {
      const result = draft({
        isDraft: true,
        targetCommitish: made,
        assets: [],
      });
      expect(result.status).toBe(1);
      expect(result.writes).toEqual([]);
      expect(result.said).toContain(`was made for ${made}`);
      expect(result.said).toContain(`this run builds ${COMMIT}`);
      expect(result.said).toContain("gh release delete v0.1.0");
    },
  );
});

const platform = (revision: string | null) => ({
  config: {
    Labels:
      revision === null
        ? { "org.opencontainers.image.title": "Marfa server" }
        : { "org.opencontainers.image.revision": revision },
  },
});

/**
 * What `docker buildx imagetools inspect` does for the image tag: an index
 * answers a map of platforms to configs, a single manifest answers its config.
 */
function image(
  tag:
    | { amd64: string | null; arm64: string | null }
    | { single: string | null }
    | "none"
    | "docker-error",
): Outcome {
  const inspected =
    tag === "none" || tag === "docker-error"
      ? ""
      : JSON.stringify(
          "single" in tag
            ? platform(tag.single)
            : {
                "linux/amd64": platform(tag.amd64),
                "linux/arm64": platform(tag.arm64),
              },
        );
  const inspect =
    tag === "none"
      ? `echo "ghcr.io/withmarfa/marfa-server:0.1.0: not found" >&2; exit 1`
      : tag === "docker-error"
        ? `echo "dial tcp: i/o timeout" >&2; exit 1`
        : `echo '${inspected}'`;
  return inFolder(
    imageStep,
    {
      docker: `case "$*" in
  "buildx imagetools inspect"*) echo x >> "$LOG.inspects"; ${inspect} ;;
  "buildx imagetools create"*) echo "$*" >> "$LOG" ;;
esac
`,
    },
    { "digests/amd64": DIGEST, "digests/arm64": DIGEST },
  );
}

describe("the server image tag of a release", () => {
  it("finds the step rather than passing over none", () => {
    expect(imageStep).toContain("imagetools create");
  });

  it("is made from this run's digests when it does not exist", () => {
    const result = image("none");
    expect(result.status, result.said).toBe(0);
    expect(result.writes).toHaveLength(2);
    expect(result.writes[0]).toContain(
      "-t ghcr.io/withmarfa/marfa-server:0.1.0",
    );
    expect(result.writes[1]).toContain(
      "-t ghcr.io/withmarfa/marfa-server:latest",
    );
  });

  it("is kept, and latest follows it, when both platforms were built from this commit", () => {
    const result = image({ amd64: COMMIT, arm64: COMMIT });
    expect(result.status, result.said).toBe(0);
    expect(result.said).toContain("is already tagged");
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]).toContain(
      "-t ghcr.io/withmarfa/marfa-server:latest",
    );
  });

  it.each([
    ["both platforms", { amd64: OTHER, arm64: OTHER }, OTHER],
    ["one platform", { amd64: COMMIT, arm64: OTHER }, `${COMMIT} ${OTHER}`],
    [
      "a platform with no revision label",
      { amd64: COMMIT, arm64: null },
      `${COMMIT} none`,
    ],
  ])(
    "is refused, and nothing tagged, when %s came from another commit",
    (_, tag, named) => {
      const result = image(tag);
      expect(result.status).toBe(1);
      expect(result.writes).toEqual([]);
      expect(result.said).toContain(`was built from ${named}`);
      expect(result.said).toContain(`this run builds ${COMMIT}`);
      expect(result.said).toContain("Delete the 0.1.0 version");
    },
  );

  it("asks docker once, and is kept when it is", () => {
    const result = image({ amd64: COMMIT, arm64: COMMIT });
    expect(result.inspects).toBe(1);
  });

  it.each([
    ["from another commit", OTHER, OTHER],
    ["from this commit", COMMIT, COMMIT],
    ["with no revision label", null, "none"],
  ])(
    "is refused, and nothing tagged, when it is one manifest %s, not an index",
    (_, revision, named) => {
      const result = image({ single: revision });
      expect(result.status).toBe(1);
      expect(result.writes).toEqual([]);
      expect(result.said).toContain(
        `was built from ${named} (one platform only)`,
      );
      expect(result.said).not.toContain("jq:");
    },
  );

  it("fails on a docker error, with no advice to delete the image and nothing tagged", () => {
    const result = image("docker-error");
    expect(result.status).toBe(1);
    expect(result.writes).toEqual([]);
    expect(result.said).toContain("Could not ask whether");
    expect(result.said).toContain("i/o timeout");
    expect(result.said).not.toContain("was built from");
    expect(result.said).not.toContain("Delete the");
  });
});
