// Exercises the workflow's version gate.
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
  /** Versions whose tags are on the remote. */
  tags: number[];
  /** Versions that have a public release. */
  released: number[];
  /** Versions that have a draft release. */
  drafts?: number[];
  /** What the compare answers, relative to the previous release. */
  relation?: string;
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
    const stub = (name: string, body: string) => {
      writeFileSync(join(directory, `${name}.sh`), body);
      chmodSync(join(directory, `${name}.sh`), 0o755);
    };
    stub(
      "git",
      `#!/bin/sh
for n in none ${world.tags.join(" ")}; do [ "$n" = none ] || printf 'abc123\\trefs/tags/v0.0.%s\\n' "$n"; done
`,
    );
    stub(
      "gh",
      `#!/bin/sh
case "$1" in
  release)
    version="\${3#v0.0.}"
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

describe("the version a tag names", () => {
  it("finds the step rather than passing over none", () => {
    expect(script).toContain("first_rust=70");
  });

  it("accepts the next version after the last release", () => {
    const run = tagged("0.0.71", { tags: [66, 70, 71], released: [66, 70] });
    expect(run.status, run.said).toBe(0);
    expect(run.output).toBe("version=0.0.71\n");
  });

  it.each([1, 67, 68, 69])(
    "refuses 0.0.%i, which is below the first Rust release",
    (version) => {
      const run = tagged(`0.0.${String(version)}`, {
        tags: [66, version],
        released: [66],
      });
      expect(run.status).toBe(1);
      expect(run.output).toBe("");
      expect(run.said).toContain("below 0.0.70, the first Rust release");
    },
  );

  it("accepts 0.0.70 after 0.0.66, the one gap a release may leave", () => {
    const run = tagged("0.0.70", { tags: [65, 66, 70], released: [65, 66] });
    expect(run.status, run.said).toBe(0);
    expect(run.output).toBe("version=0.0.70\n");
    expect(run.said).toContain("first Rust release");
  });

  it("refuses any other gap, including the one after 0.0.70", () => {
    for (const version of [71, 72]) {
      const run = tagged(`0.0.${String(version)}`, {
        tags: [66, version],
        released: [66],
      });
      expect(run.status, `0.0.${String(version)}`).toBe(1);
      expect(run.said).toContain("does not follow the tags before it");
    }
    const after = tagged("0.0.72", { tags: [66, 70, 72], released: [66, 70] });
    expect(after.status).toBe(1);
    expect(after.said).toContain("the next version is 0.0.71");
  });

  it("refuses 0.0.70 when 0.0.66 was tagged but never released", () => {
    const run = tagged("0.0.70", { tags: [65, 66, 70], released: [65] });
    expect(run.status).toBe(1);
    expect(run.said).toContain("0.0.66 is tagged but not released");
  });

  it("refuses a tag made below a version that is already released", () => {
    const run = tagged("0.0.71", {
      tags: [66, 70, 71, 72],
      released: [66, 70, 72],
    });
    expect(run.status).toBe(1);
    expect(run.said).toContain("0.0.72 is already released");
  });

  it("waits for a higher tag that is only a draft, as two tags pushed together do", () => {
    const run = tagged("0.0.71", {
      tags: [66, 70, 71, 72],
      released: [66, 70],
      drafts: [72],
    });
    expect(run.status, run.said).toBe(0);
  });

  it("refuses a commit that does not come after the previous release", () => {
    const run = tagged("0.0.71", {
      tags: [66, 70, 71],
      released: [66, 70],
      relation: "behind",
    });
    expect(run.status).toBe(1);
    expect(run.said).toContain("is behind of v0.0.70");
  });

  it.each(["v0.1.0", "v1.0.0", "v0.0.70-rc1", "v0.0", "vlatest", "v0.0.070"])(
    "refuses the tag %s, which is not a 0.0.N version",
    (tag) => {
      const run = release({ tags: [66], released: [66] }, { tag });
      expect(run.status).toBe(1);
      expect(run.output).toBe("");
    },
  );

  it("takes a dry run's version from the input and applies the same rules", () => {
    const accepted = release(
      { tags: [66], released: [66] },
      { dispatch: "0.0.70" },
    );
    expect(accepted.status, accepted.said).toBe(0);
    expect(accepted.output).toBe("version=0.0.70\n");
    const refused = release(
      { tags: [66], released: [66] },
      { dispatch: "0.0.69" },
    );
    expect(refused.status).toBe(1);
    expect(refused.said).toContain("below 0.0.70");
    const shell = release(
      { tags: [66], released: [66] },
      { dispatch: "0.0.67; echo hacked" },
    );
    expect(shell.status).toBe(1);
    expect(shell.said).not.toContain("hacked\n");
  });

  it("refuses a run that is not at a tag ref", () => {
    const run = release(
      { tags: [66], released: [66] },
      { ref: "refs/heads/main" },
    );
    expect(run.status).toBe(1);
    expect(run.said).toContain("A release runs at a tag ref");
  });
});
