/**
 * Every action a workflow or a composite action uses is pinned by the commit
 * it runs, with its version after it, so that moving a tag or a branch
 * upstream cannot change what a job runs without a commit here. A local action
 * (`./`) is the repository's own code and is exempt.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB = join(ROOT, ".github");

const COMMIT = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const DIGEST = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;
const VERSION = /^v\d+(\.\d+)*$/;

interface Use {
  line: number;
  uses: string;
  comment: string | undefined;
}

/** Each `uses:` line of a workflow or action file, with its trailing comment. */
function usesOf(text: string): Use[] {
  const found: Use[] = [];
  text.split("\n").forEach((line, index) => {
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(.*?))?\s*$/.exec(line);
    if (match) {
      found.push({
        line: index + 1,
        uses: match[1]!.replace(/^["']|["']$/g, ""),
        comment: match[2],
      });
    }
  });
  return found;
}

/** What is wrong with each external `uses:` of a file, one sentence each. */
function refused(text: string): string[] {
  const problems: string[] = [];
  for (const { line, uses, comment } of usesOf(text)) {
    if (uses.startsWith("./")) continue;
    if (!COMMIT.test(uses) && !DIGEST.test(uses)) {
      problems.push(
        `line ${String(line)}: ${uses} is not pinned by a full commit`,
      );
    } else if (comment === undefined || !VERSION.test(comment)) {
      problems.push(
        `line ${String(line)}: ${uses} has no version comment (# v1.2.3)`,
      );
    }
  }
  return problems;
}

/** The workflow files and the composite actions, as paths from the root. */
function files(): string[] {
  const workflows = readdirSync(join(GITHUB, "workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => join(GITHUB, "workflows", name));
  const actions = readdirSync(join(GITHUB, "actions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(GITHUB, "actions", entry.name))
        .filter((name) => /^action\.ya?ml$/.test(name))
        .map((name) => join(GITHUB, "actions", entry.name, name)),
    );
  return [...workflows, ...actions];
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("the check refuses what a movable reference looks like", () => {
  it.each([
    ["a tag", "      - uses: owner/repo@v2", "is not pinned"],
    ["a branch", "      - uses: owner/repo@stable", "is not pinned"],
    [
      "a subfolder's tag",
      "      - uses: owner/repo/sub@v1.2.3",
      "is not pinned",
    ],
    ["a short commit", "      - uses: owner/repo@0123456", "is not pinned"],
    [
      "an upper case commit",
      `      - uses: owner/repo@${SHA.toUpperCase()}`,
      "is not pinned",
    ],
    ["no reference", "      - uses: owner/repo", "is not pinned"],
    ["an image by tag", "      - uses: docker://alpine:3", "is not pinned"],
    [
      "a commit with no version",
      `      - uses: owner/repo@${SHA}`,
      "no version comment",
    ],
    [
      "a commit with a branch comment",
      `      - uses: owner/repo@${SHA} # stable`,
      "no version comment",
    ],
  ])("%s", (_name, line, why) => {
    const problems = refused(line);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(why);
  });

  it.each([
    ["a commit with its version", `      - uses: owner/repo@${SHA} # v2.9.3`],
    ["a subfolder's commit", `        uses: owner/repo/sub@${SHA} # v4`],
    ["a quoted commit", `      - uses: "owner/repo@${SHA}" # v1.0`],
    ["a local action", "      - uses: ./.github/actions/rust-toolchain"],
    ["a local workflow", "    uses: ./.github/workflows/core-live.yml"],
    [
      "an image by digest",
      `      - uses: docker://alpine@sha256:${"a".repeat(64)} # v3`,
    ],
  ])("accepts %s", (_name, line) => {
    expect(refused(line)).toEqual([]);
  });
});

describe("every workflow and composite action", () => {
  const all = files();

  it("has the files the check is meant to read", () => {
    const names = all.map((path) => relative(GITHUB, path));
    expect(names).toContain("workflows/ci.yml");
    expect(names).toContain("workflows/release.yml");
    expect(names).toContain("actions/native-build-image/action.yml");
  });

  it.each(all.map((path) => [relative(ROOT, path), path] as const))(
    "%s pins every external action by commit",
    (_name, path) => {
      expect(refused(readFileSync(path, "utf8"))).toEqual([]);
    },
  );

  it("reads as many `uses` as the YAML holds", () => {
    // The text scan is what sees the comment; the parse is what sees every step.
    for (const path of all) {
      const text = readFileSync(path, "utf8");
      const document = parse(text) as {
        jobs?: Record<string, { uses?: string; steps?: { uses?: string }[] }>;
        runs?: { steps?: { uses?: string }[] };
      };
      const parsed =
        Object.values(document.jobs ?? {}).flatMap((job) => [
          ...(job.uses ? [job.uses] : []),
          ...(job.steps ?? []).flatMap((step) =>
            step.uses ? [step.uses] : [],
          ),
        ]).length +
        (document.runs?.steps ?? []).filter((step) => step.uses).length;
      expect(usesOf(text).length, relative(ROOT, path)).toBe(parsed);
    }
  });
});

describe("Dependabot keeps the pins current", () => {
  const dependabot = parse(
    readFileSync(join(GITHUB, "dependabot.yml"), "utf8"),
  ) as {
    updates: {
      "package-ecosystem": string;
      directory?: string;
      directories?: string[];
      "open-pull-requests-limit"?: number;
    }[];
  };
  const entry = dependabot.updates.find(
    (update) => update["package-ecosystem"] === "github-actions",
  );

  it("has a github-actions entry that reads the workflows", () => {
    expect(entry?.directories).toContain("/");
  });

  it("reads every folder of the composite actions", () => {
    // `/` covers the workflows only; a folder under .github/actions is read
    // when a glob in `directories` names it.
    expect(entry?.directories).toContain("/.github/actions/*");
    const folders = readdirSync(join(GITHUB, "actions"), {
      withFileTypes: true,
    }).filter((folder) => folder.isDirectory());
    expect(folders.length).toBeGreaterThan(0);
  });

  it("may open a pull request for each directory at once", () => {
    const folders = readdirSync(join(GITHUB, "actions"), {
      withFileTypes: true,
    }).filter((folder) => folder.isDirectory());
    expect(entry?.["open-pull-requests-limit"]).toBeGreaterThanOrEqual(
      1 + folders.length,
    );
  });
});
