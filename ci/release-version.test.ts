// Exercises the workflow's version gate.
import {
  chmodSync,
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
  id?: string;
  name?: string;
  run?: string;
}

const workflow = parse(
  readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
) as { jobs: Record<string, { steps: Step[] }> };

const script = workflow.jobs.version?.steps.find(
  (step) => step.id === "version",
)?.run;

interface World {
  /** Versions whose tags are on the remote, such as `0.1.0`. */
  tags: string[];
  /** Versions that have a public release. */
  released: string[];
  /** Versions that have a draft release. */
  drafts?: string[];
  /** What the compare answers, relative to the previous release. */
  relation?: string;
  /** The lines of `scripts/release/abandoned-versions`. */
  abandoned?: string[];
}

interface Run {
  dispatch?: string;
  tag?: string;
  ref?: string;
}

function release(world: World, run: Run) {
  expect(script).toBeTypeOf("string");
  const directory = mkdtempSync(join(tmpdir(), "marfa-release-version-"));
  try {
    const bin = join(directory, "bin");
    const output = join(directory, "output");
    writeFileSync(output, "");
    mkdirSync(join(directory, "scripts", "release"), { recursive: true });
    writeFileSync(
      join(directory, "scripts", "release", "abandoned-versions"),
      (world.abandoned ?? []).join("\n"),
    );
    const stub = (name: string, body: string) => {
      writeFileSync(join(directory, `${name}.sh`), body);
      chmodSync(join(directory, `${name}.sh`), 0o755);
    };
    stub(
      "git",
      `#!/bin/sh
for n in none ${world.tags.join(" ")}; do [ "$n" = none ] || printf 'abc123\\trefs/tags/v%s\\n' "$n"; done
printf 'abc123\\trefs/tags/vlatest\\nabc123\\trefs/tags/v0.0.70-rc1\\n'
`,
    );
    stub(
      "gh",
      `#!/bin/sh
case "$1" in
  release)
    version="\${3#v}"
    for n in none ${world.released.join(" ")}; do [ "$n" = "$version" ] && { echo false; exit 0; }; done
    for n in none ${(world.drafts ?? []).join(" ")}; do [ "$n" = "$version" ] && { echo true; exit 0; }; done
    echo "release not found" >&2
    exit 1
    ;;
  api) echo "${world.relation ?? "ahead"}" ;;
esac
`,
    );
    writeFileSync(
      join(directory, "install.sh"),
      `mkdir -p "${bin}"; cp "${join(directory, "git.sh")}" "${bin}/git"; cp "${join(directory, "gh.sh")}" "${bin}/gh"`,
    );
    spawnSync("sh", [join(directory, "install.sh")]);
    const dispatch = run.dispatch !== undefined;
    const ran = spawnSync(
      "bash",
      [
        "-e",
        "-c",
        `PATH="${bin}:$PATH"
${script ?? "exit 1"}`,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_OUTPUT: output,
          GITHUB_SHA: "0".repeat(40),
          GITHUB_REPOSITORY: "withmarfa/marfa",
          GITHUB_EVENT_NAME: dispatch ? "workflow_dispatch" : "push",
          GITHUB_REF:
            run.ref ??
            (dispatch ? "refs/heads/main" : `refs/tags/${run.tag ?? ""}`),
          DRY_RUN_VERSION: run.dispatch ?? "",
          GH_TOKEN: "unused",
        },
      },
    );
    return {
      status: ran.status,
      said: `${ran.stdout}${ran.stderr}`,
      output: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const tagged = (version: string, world: World) =>
  release(world, { tag: `v${version}` });

const refused = (run: ReturnType<typeof release>, said: string) => {
  expect(run.status, run.said).toBe(1);
  expect(run.output).toBe("");
  expect(run.said).toContain(said);
};

describe("the version a tag names", () => {
  it("finds the step rather than passing over none", () => {
    expect(script).toContain("next_minor");
  });

  it("accepts the next patch after the last release", () => {
    const run = tagged("0.0.71", {
      tags: ["0.0.70", "0.0.71"],
      released: ["0.0.70"],
    });
    expect(run.status, run.said).toBe(0);
    expect(run.output).toBe("version=0.0.71\n");
  });

  it.each([
    ["0.1.0", ["0.0.70", "0.0.71"]],
    ["0.1.1", ["0.0.71", "0.1.0"]],
    ["0.1.4", ["0.1.0", "0.1.3"]],
    ["0.2.0", ["0.1.0", "0.1.3"]],
    ["0.10.0", ["0.9.12"]],
    ["0.1.0", ["0.0.71"]],
  ])("accepts %s after %j", (version, tags) => {
    const run = tagged(version, {
      tags: [...tags, version],
      released: tags,
    });
    expect(run.status, run.said).toBe(0);
    expect(run.output).toBe(`version=${version}\n`);
  });

  it("accepts 0.0.1 when no release exists", () => {
    const run = tagged("0.0.1", { tags: ["0.0.1"], released: [] });
    expect(run.status, run.said).toBe(0);
  });

  it("finds the previous release among tags of every series", () => {
    const run = tagged("0.1.1", {
      tags: ["0.0.70", "0.0.71", "0.1.0", "0.1.1"],
      released: ["0.0.70", "0.0.71", "0.1.0"],
    });
    expect(run.status, run.said).toBe(0);
  });

  it("ignores a tag that is not a plain version", () => {
    const run = tagged("0.0.71", {
      tags: ["0.0.70", "0.0.71"],
      released: ["0.0.70"],
    });
    expect(run.status, run.said).toBe(0);
  });

  it.each([
    ["0.0.72", ["0.0.71", "0.1.0"], "0.1.0 is already released"],
    ["0.0.71", ["0.0.70", "0.0.71", "0.1.0"], "0.1.0 is already released"],
    ["0.1.2", ["0.0.71", "0.1.0"], "the next version is 0.1.1, or 0.2.0"],
    ["0.3.0", ["0.0.71", "0.1.0"], "the next version is 0.1.1, or 0.2.0"],
    ["0.2.1", ["0.1.0", "0.1.3"], "the next version is 0.1.4, or 0.2.0"],
    ["0.0.73", ["0.0.71"], "the next version is 0.0.72, or 0.1.0"],
    ["0.2.0", ["0.0.71"], "the next version is 0.0.72, or 0.1.0"],
    ["0.1.1", ["0.0.71"], "the next version is 0.0.72, or 0.1.0"],
  ])("refuses %s after %j", (version, released, said) => {
    refused(tagged(version, { tags: [...released, version], released }), said);
  });

  it("refuses a second 0.1.0, which is already released", () => {
    refused(
      tagged("0.1.0", {
        tags: ["0.0.71", "0.1.0"],
        released: ["0.0.71", "0.1.0"],
      }),
      "0.1.0 is already released",
    );
  });

  it("refuses 1.0.0, the next minor's patch zero but a major above 0", () => {
    refused(
      tagged("1.0.0", { tags: ["0.1.0", "1.0.0"], released: ["0.1.0"] }),
      "a major above 0",
    );
  });

  it("refuses a 0.1.0 tagged while 0.0.72 is only tagged", () => {
    refused(
      tagged("0.1.0", {
        tags: ["0.0.71", "0.0.72", "0.1.0"],
        released: ["0.0.71"],
      }),
      "0.0.72 is tagged but not released",
    );
  });

  it("refuses 0.0.72 when the last release is above it", () => {
    refused(
      tagged("0.0.72", {
        tags: ["0.0.71", "0.0.72", "0.1.0", "0.1.1"],
        released: ["0.0.71", "0.1.1"],
      }),
      "0.1.1 is already released",
    );
  });

  it("waits for a higher tag that is only a draft, as two tags pushed together do", () => {
    const run = tagged("0.0.71", {
      tags: ["0.0.70", "0.0.71", "0.0.72"],
      released: ["0.0.70"],
      drafts: ["0.0.72"],
    });
    expect(run.status, run.said).toBe(0);
  });

  it("refuses a commit that does not come after the previous release", () => {
    refused(
      tagged("0.1.0", {
        tags: ["0.0.71", "0.1.0"],
        released: ["0.0.71"],
        relation: "behind",
      }),
      "is behind of v0.0.71",
    );
  });

  it.each(["v1.0.0", "v0.0.70-rc1", "v0.0", "vlatest", "v0.0.070", "v0.1.0.0"])(
    "refuses the tag %s, which is not a version this gate releases",
    (tag) => {
      const run = release({ tags: ["0.0.71"], released: ["0.0.71"] }, { tag });
      expect(run.status).toBe(1);
      expect(run.output).toBe("");
    },
  );

  it("takes a dry run's version from the input and applies the same rules", () => {
    const world = { tags: ["0.0.71"], released: ["0.0.71"] };
    const accepted = release(world, { dispatch: "0.1.0" });
    expect(accepted.status, accepted.said).toBe(0);
    expect(accepted.output).toBe("version=0.1.0\n");
    refused(
      release(world, { dispatch: "0.2.0" }),
      "the next version is 0.0.72, or 0.1.0",
    );
    refused(release(world, { dispatch: "1.0.0" }), "a major above 0");
    refused(
      release(world, { dispatch: "0.0.70" }),
      "0.0.71 is already released",
    );
    const shell = release(world, { dispatch: "0.0.72; echo hacked" });
    expect(shell.status).toBe(1);
    expect(shell.said).not.toContain("hacked\n");
  });

  it("passes over an abandoned version to the release before it", () => {
    const world = {
      tags: ["0.0.84", "0.0.85", "0.0.86"],
      released: ["0.0.84"],
      abandoned: ["# Never released.", "0.0.85  # a comment", ""],
    };
    const run = tagged("0.0.86", world);
    expect(run.status, run.said).toBe(0);
    expect(run.output).toBe("version=0.0.86\n");
    const minor = tagged("0.1.0", {
      ...world,
      tags: ["0.0.84", "0.0.85", "0.1.0"],
    });
    expect(minor.status, minor.said).toBe(0);
  });

  it("still waits for a version that is only tagged and not abandoned", () => {
    refused(
      tagged("0.0.86", {
        tags: ["0.0.84", "0.0.85", "0.0.86"],
        released: ["0.0.84"],
        abandoned: ["0.0.83"],
      }),
      "0.0.85 is tagged but not released",
    );
  });

  it("refuses an abandoned version itself", () => {
    refused(
      tagged("0.0.85", {
        tags: ["0.0.84", "0.0.85"],
        released: ["0.0.84"],
        abandoned: ["0.0.85"],
      }),
      "0.0.85 is listed in scripts/release/abandoned-versions",
    );
  });

  it("refuses a list that names a released version", () => {
    refused(
      tagged("0.0.86", {
        tags: ["0.0.84", "0.0.85", "0.0.86"],
        released: ["0.0.84", "0.0.85"],
        abandoned: ["0.0.85"],
      }),
      "0.0.85 is released, so scripts/release/abandoned-versions cannot list it",
    );
  });

  it("reads the committed list as versions only", () => {
    const listed = readFileSync(
      join(ROOT, "scripts", "release", "abandoned-versions"),
      "utf8",
    )
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean);
    expect(listed).toContain("0.0.85");
    for (const version of listed) {
      expect(version).toMatch(/^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    }
  });

  it("refuses a run that is not at a tag ref", () => {
    const run = release(
      { tags: ["0.0.71"], released: ["0.0.71"] },
      { ref: "refs/heads/main" },
    );
    expect(run.status).toBe(1);
    expect(run.said).toContain("A release runs at a tag ref");
  });
});
