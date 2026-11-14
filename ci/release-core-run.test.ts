// Exercises what a release waits for from `core.yml`: a green run for the
// commit, or for the nearest run before it with no core change since.
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
const SCRIPT = join(ROOT, "scripts", "release", "require-core-run.sh");

const RELEASE = "r".repeat(40);
const sha = (letter: string) => letter.repeat(40);

interface Run {
  id: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
  /** Newer runs have larger numbers. */
  created_at: string;
}

const run = (
  id: number,
  head: string,
  status: string,
  conclusion: string | null,
): Run => ({
  id,
  head_sha: head,
  status,
  conclusion,
  created_at: `2026-11-14T10:${String(id).padStart(2, "0")}:00Z`,
});

interface World {
  /** What the list of runs on `main` answers. */
  main: Run[];
  /** What the list of runs for the release commit answers. */
  own?: Run[];
  /** How the release commit stands to a run's commit, and what changed since. */
  compare: Record<string, { status: string; files: string[] }>;
}

function require(world: World) {
  const directory = mkdtempSync(join(tmpdir(), "marfa-release-core-"));
  try {
    const write = (name: string, body: unknown) => {
      writeFileSync(join(directory, name), JSON.stringify(body));
    };
    write("main.json", { workflow_runs: world.main });
    write("own.json", { workflow_runs: world.own ?? [] });
    for (const [base, comparison] of Object.entries(world.compare)) {
      write(`compare-${base}.json`, {
        status: comparison.status,
        files: comparison.files.map((filename) => ({ filename })),
      });
    }
    const bin = join(directory, "bin");
    writeFileSync(join(directory, "setup.sh"), `mkdir -p "${bin}"`);
    spawnSync("sh", [join(directory, "setup.sh")]);
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
url="$2"
case "$url" in
  *core.yml/runs*head_sha=*) cat "${directory}/own.json" ;;
  *core.yml/runs*) cat "${directory}/main.json" ;;
  */compare/*)
    base="\${url#*compare/}"
    base="\${base%%...*}"
    cat "${directory}/compare-$base.json" || { echo "Not Found" >&2; exit 1; }
    ;;
  *) echo "unexpected $url" >&2; exit 1 ;;
esac
`,
    );
    chmodSync(gh, 0o755);
    const ran = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_SHA: RELEASE,
        GITHUB_REPOSITORY: "withmarfa/marfa",
        GH_TOKEN: "unused",
      },
    });
    return { status: ran.status, said: `${ran.stdout}${ran.stderr}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const identical = { status: "identical", files: [] };

describe("a release waits for the core's live checks", () => {
  it("accepts a commit whose own run is green", () => {
    const result = require({
      main: [run(5, RELEASE, "completed", "success")],
      compare: { [RELEASE]: identical },
    });
    expect(result.status, result.said).toBe(0);
    expect(result.said).toContain("core.yml is green");
  });

  it("refuses a commit whose own run failed or was cancelled", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out"]) {
      const result = require({
        main: [run(5, RELEASE, "completed", conclusion)],
        compare: { [RELEASE]: identical },
      });
      expect(result.status, conclusion).toBe(1);
      expect(result.said).toContain(`ended ${conclusion}`);
    }
  });

  it("refuses a commit whose own run is still going, and says to run the job again", () => {
    for (const status of ["in_progress", "queued"]) {
      const result = require({
        main: [run(5, RELEASE, status, null)],
        compare: { [RELEASE]: identical },
      });
      expect(result.status, status).toBe(1);
      expect(result.said).toContain("still running");
      expect(result.said).toContain("Re-run this job");
    }
  });

  it("accepts a commit when any run for it is green, as a nightly beside a failed push", () => {
    const result = require({
      main: [
        run(6, RELEASE, "completed", "success"),
        run(5, RELEASE, "completed", "failure"),
      ],
      compare: { [RELEASE]: identical },
    });
    expect(result.status, result.said).toBe(0);
  });

  it("refuses a commit with no run at all", () => {
    const result = require({ main: [], compare: {} });
    expect(result.status).toBe(1);
    expect(result.said).toContain("No core.yml run at or before");
  });

  it("refuses a commit when the only runs are for commits it does not follow", () => {
    const result = require({
      main: [run(5, sha("a"), "completed", "success")],
      compare: { [sha("a")]: { status: "behind", files: [] } },
    });
    expect(result.status).toBe(1);
    expect(result.said).toContain("No core.yml run at or before");
  });

  it("lets an earlier green run vouch for a commit that changed nothing the core reads", () => {
    const result = require({
      main: [run(5, sha("a"), "completed", "success")],
      compare: {
        [sha("a")]: {
          status: "ahead",
          files: [
            "core/marfa-server/README.md",
            "docs/notes.md",
            "conformance/spec/events.md",
            "ci/release-version.test.ts",
            ".github/workflows/ci.yml",
          ],
        },
      },
    });
    expect(result.status, result.said).toBe(0);
    expect(result.said).toContain(`green for ${sha("a")}`);
  });

  it.each([
    "core/marfa-server/src/main.rs",
    "openapi.json",
    "package.json",
    ".github/workflows/core.yml",
    ".github/workflows/core-live.yml",
  ])(
    "refuses an earlier green run when %s changed since, with no run of its own",
    (file) => {
      const result = require({
        main: [run(5, sha("a"), "completed", "success")],
        compare: {
          [sha("a")]: { status: "ahead", files: ["README.md", file] },
        },
      });
      expect(result.status).toBe(1);
      expect(result.said).toContain("changed what the core's live checks read");
    },
  );

  it("refuses when the nearest earlier run is red, even if an older one is green", () => {
    const result = require({
      main: [
        run(9, sha("b"), "completed", "cancelled"),
        run(5, sha("a"), "completed", "success"),
      ],
      compare: {
        [sha("b")]: { status: "ahead", files: ["docs/notes.md"] },
        [sha("a")]: {
          status: "ahead",
          files: ["core/marfa-server/src/main.rs"],
        },
      },
    });
    expect(result.status).toBe(1);
    expect(result.said).toContain(`did not pass for ${sha("b")}`);
  });

  it("passes over a run for a later commit and uses the nearest one before", () => {
    const result = require({
      main: [
        run(9, sha("c"), "completed", "failure"),
        run(5, sha("a"), "completed", "success"),
      ],
      compare: {
        [sha("c")]: { status: "behind", files: [] },
        [sha("a")]: { status: "ahead", files: ["README.md"] },
      },
    });
    expect(result.status, result.said).toBe(0);
  });

  it("refuses when a comparison may have left files unlisted", () => {
    const files = Array.from(
      { length: 100 },
      (_, i) => `docs/page-${String(i)}.md`,
    );
    const result = require({
      main: [run(5, sha("a"), "completed", "success")],
      compare: { [sha("a")]: { status: "ahead", files } },
    });
    expect(result.status).toBe(1);
    expect(result.said).toContain("changed what the core's live checks read");
  });

  it("counts a run on the commit itself from a dry run on a branch", () => {
    const result = require({
      main: [],
      own: [run(5, RELEASE, "completed", "success")],
      compare: { [RELEASE]: identical },
    });
    expect(result.status, result.said).toBe(0);
  });
});

describe("the paths that make a commit need a core run", () => {
  const workflow = parse(
    readFileSync(join(ROOT, ".github", "workflows", "core.yml"), "utf8"),
  ) as { on: { push: { paths: string[] } } };
  const script = readFileSync(SCRIPT, "utf8");

  it("are the ones core.yml's push filter lists", () => {
    const listed = workflow.on.push.paths;
    expect(listed.length).toBeGreaterThan(0);
    const positive = listed.filter((path) => !path.startsWith("!"));
    const line = script
      .split("\n")
      .find((text) => text.includes(") return 0 ;;"));
    const named = (line ?? "")
      .replace(/\) return 0 ;;.*/, "")
      .trim()
      .split(/ \| /);
    expect(named.sort()).toEqual(
      positive
        .map((path) => (path.endsWith("/**") ? `${path.slice(0, -2)}*` : path))
        .sort(),
    );
    expect(listed).toContain("!**/*.md");
    expect(script).toContain("*.md) ;;");
  });
});
