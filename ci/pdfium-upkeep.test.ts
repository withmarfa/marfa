/**
 * The weekly check that prepares a PDFium move. The workflow runs
 * `scripts/prepare-pdfium-move.sh`; the script is run here against stand-ins
 * for `gh`, `git` and `curl`, and nothing in these tests reaches the network.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "prepare-pdfium-move.sh");
const WORKFLOW = join(ROOT, ".github", "workflows", "pdfium-upkeep.yml");
const MANIFEST = "core/marfa-enrichment/native/manifest.txt";

describe("the pdfium-upkeep workflow", () => {
  const workflow = parse(readFileSync(WORKFLOW, "utf8")) as {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    jobs: Record<
      string,
      {
        "runs-on": string;
        "timeout-minutes": number;
        permissions?: Record<string, string>;
        steps: { uses?: string; run?: string }[];
      }
    >;
  };

  it("runs weekly and on demand", () => {
    expect(workflow.on).toHaveProperty("schedule");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("reads by default, and its one job may write the branch and the issue, and nothing else", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.prepare?.permissions).toEqual({
      contents: "write",
      issues: "write",
    });
    expect(workflow.jobs.prepare?.["runs-on"]).toBe("ubuntu-latest");
  });

  it("runs the script, and opens no pull request and keeps no artifact", () => {
    const text = readFileSync(WORKFLOW, "utf8");
    expect(
      workflow.jobs.prepare?.steps.some((s) =>
        s.run?.includes("scripts/prepare-pdfium-move.sh"),
      ),
    ).toBe(true);
    expect(text).not.toMatch(/gh pr create|create-pull-request/);
    expect(text).not.toContain("upload-artifact");
  });
});

describe("scripts/prepare-pdfium-move.sh", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pdfium-upkeep-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const ARCHIVE = "archive bytes";
  const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");
  const OLD_COMMIT = "a".repeat(40);
  const NEW_COMMIT = "b".repeat(40);
  const TAG_OBJECT = "c".repeat(40);
  const PDFIUM_HEAD = "d".repeat(40);
  const OLD_PDFIUM = "e".repeat(40);
  const DAY = 86400;

  const MANIFEST_TEXT = [
    "# Tesseract is pinned by commit.",
    "archive tesseract 5.5.4 https://example.test/tesseract.tar.gz " +
      "f".repeat(64),
    "",
    "# bblanchon/pdfium-binaries at the commit that tagged release chromium/8100.",
    "# pdfium-render's `pdfium_8100` feature is the newest API, and the 8100 library links against it.",
    `archive pdfium-binaries chromium/8100 https://github.com/bblanchon/pdfium-binaries/archive/${OLD_COMMIT}.tar.gz ${"9".repeat(64)}`,
    "",
    "# What build.sh checks out.",
    `git pdfium https://pdfium.example.test/pdfium chromium/8100 ${OLD_PDFIUM}`,
    "",
  ].join("\n");

  interface Setup {
    /** Days between the pinned release and the newest. */
    gap?: number;
    newest?: string;
    tag?: "commit" | "annotated";
    issues?: unknown;
    /** `gh api` paths, `issue list`, `curl` or `git ls-remote` answer an error. */
    fail?: string;
    lsRemote?: string;
    manifest?: string;
  }

  function run(
    name: string,
    setup: Setup,
    args: string[] = [],
  ): { status: number; output: string; calls: string[]; manifest: string } {
    const dir = join(scratch, name);
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    const api = join(dir, "api");
    mkdirSync(bin, { recursive: true });
    mkdirSync(api, { recursive: true });
    mkdirSync(dirname(join(repo, MANIFEST)), { recursive: true });
    writeFileSync(join(repo, MANIFEST), setup.manifest ?? MANIFEST_TEXT);

    const newest = setup.newest ?? "chromium/8130";
    const pinnedEpoch = Date.UTC(2026, 9, 5) / 1000;
    const iso = (epoch: number) =>
      new Date(epoch * 1000).toISOString().replace(".000Z", "Z");
    const put = (path: string, value: unknown): void => {
      writeFileSync(
        join(api, path.replaceAll("/", "_")),
        JSON.stringify(value),
      );
    };
    const up = "repos/bblanchon/pdfium-binaries";
    put(`${up}/releases/latest`, { tag_name: newest });
    put(`${up}/releases/tags/chromium/8100`, {
      published_at: iso(pinnedEpoch),
    });
    put(`${up}/releases/tags/${newest}`, {
      published_at: iso(pinnedEpoch + (setup.gap ?? 30) * DAY),
    });
    if (setup.tag === "annotated") {
      put(`${up}/git/ref/tags/${newest}`, {
        object: { type: "tag", sha: TAG_OBJECT },
      });
      put(`${up}/git/tags/${TAG_OBJECT}`, {
        object: { type: "commit", sha: NEW_COMMIT },
      });
    } else {
      put(`${up}/git/ref/tags/${newest}`, {
        object: { type: "commit", sha: NEW_COMMIT },
      });
    }

    const stub = (file: string, lines: string[]) => {
      writeFileSync(join(bin, file), ["#!/bin/bash", ...lines, ""].join("\n"));
      chmodSync(join(bin, file), 0o755);
    };
    stub("gh", [
      'echo "gh $*" >> "$FAKE_DIR/calls"',
      'if [ "${FAKE_FAIL:-}" = "$1 $2" ] || [ "${FAKE_FAIL:-}" = "$2" ]; then echo "gh: HTTP 500" >&2; exit 1; fi',
      'case "$1 $2" in',
      '  "api "*) f="$FAKE_DIR/api/${2//\\//_}"; if [ -f "$f" ]; then cat "$f"; else echo "gh: HTTP 404" >&2; exit 1; fi ;;',
      '  "issue list") printf "%s" "$FAKE_ISSUES" ;;',
      '  "issue create") echo "https://github.com/withmarfa/marfa/issues/9999" ;;',
      '  "issue edit") ;;',
      '  *) echo "unexpected: $*" >&2; exit 97 ;;',
      "esac",
    ]);
    stub("curl", [
      'echo "curl $*" >> "$FAKE_DIR/calls"',
      'if [ "${FAKE_FAIL:-}" = "curl" ]; then echo "curl: (22) 404" >&2; exit 22; fi',
      'while [ $# -gt 0 ]; do if [ "$1" = --output ]; then printf "%s" "$FAKE_ARCHIVE" > "$2"; fi; shift; done',
    ]);
    stub("git", [
      'echo "git $* [$GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL> $GIT_COMMITTER_NAME $GIT_AUTHOR_DATE]" >> "$FAKE_DIR/calls"',
      'if [ "${FAKE_FAIL:-}" = "ls-remote" ] && [ "$1" = ls-remote ]; then echo "fatal: unable to access" >&2; exit 128; fi',
      'if [ "$1" = -C ]; then shift 2; fi',
      'case "$1" in',
      '  rev-parse) echo "$FAKE_ROOT" ;;',
      '  ls-remote) printf "%s" "$FAKE_LS_REMOTE" ;;',
      "  log) echo 2026-11-08T10:00:00+00:00 ;;",
      "  *) ;;",
      "esac",
    ]);

    let status = 0;
    let output: string;
    try {
      output = execFileSync("bash", [SCRIPT, ...args], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          FAKE_DIR: dir,
          FAKE_ROOT: repo,
          FAKE_ARCHIVE: ARCHIVE,
          FAKE_ISSUES: JSON.stringify(setup.issues ?? []),
          FAKE_FAIL: setup.fail ?? "",
          FAKE_LS_REMOTE:
            setup.lsRemote ?? `${PDFIUM_HEAD}\trefs/heads/${newest}\n`,
          GH_TOKEN: "test-token",
          GITHUB_REPOSITORY: "withmarfa/marfa",
        },
        stdio: "pipe",
        encoding: "utf8",
      });
    } catch (error) {
      const failed = error as {
        status: number;
        stdout: string;
        stderr: string;
      };
      status = failed.status;
      output = failed.stdout + failed.stderr;
    }
    const read = (file: string): string => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return "";
      }
    };
    return {
      status,
      output,
      calls: read(join(dir, "calls")).split("\n").filter(Boolean),
      manifest: read(join(repo, MANIFEST)),
    };
  }

  const wrote = (calls: string[]) =>
    calls.filter(
      (c) =>
        c.startsWith("git push") ||
        c.includes(" push ") ||
        c.startsWith("gh issue create") ||
        c.startsWith("gh issue edit"),
    );

  it("does nothing when the pin is the newest release", () => {
    const result = run("current", { newest: "chromium/8100", gap: 0 });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("The pin is current");
    expect(wrote(result.calls)).toEqual([]);
    expect(result.calls.some((c) => c.startsWith("curl"))).toBe(false);
  });

  it("does nothing while the pin is under four weeks behind", () => {
    const result = run("recent", { gap: 27 });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("less than 28 days behind");
    expect(wrote(result.calls)).toEqual([]);
  });

  it("prepares the move at exactly four weeks", () => {
    const result = run("exactly", { gap: 28 }, ["--dry-run"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Branch: automation/pdfium-chromium-8130");
  });

  it("prints the diff, the branch and the issue on a dry run, and pushes and opens nothing", () => {
    const result = run("dry", {}, ["--dry-run"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Branch: automation/pdfium-chromium-8130");
    expect(result.output).toContain("Issue: Move PDFium to chromium/8130");
    expect(result.output).toContain(
      `+archive pdfium-binaries chromium/8130 https://github.com/bblanchon/pdfium-binaries/archive/${NEW_COMMIT}.tar.gz ${ARCHIVE_SHA}`,
    );
    expect(result.output).toContain(
      `+git pdfium https://pdfium.example.test/pdfium chromium/8130 ${PDFIUM_HEAD}`,
    );
    expect(result.output).toContain(
      "compare/main...automation/pdfium-chromium-8130",
    );
    expect(result.output).toContain("Dry run: would push");
    expect(wrote(result.calls)).toEqual([]);
    expect(result.manifest).toBe(MANIFEST_TEXT);
  });

  it("moves both pins and the comments about PDFium, and leaves other lines and the API feature name alone", () => {
    const result = run("move", {});
    expect(result.status, result.output).toBe(0);
    expect(result.manifest).toContain("release chromium/8130.");
    expect(result.manifest).toContain("the 8130 library links against it");
    expect(result.manifest).toContain("`pdfium_8100` feature");
    expect(result.manifest).toContain("# Tesseract is pinned by commit.");
    expect(result.manifest).not.toContain("chromium/8100");
    expect(result.manifest).toContain(`chromium/8130 ${PDFIUM_HEAD}`);
  });

  it("pushes only the automation branch, as the bot, and opens one issue labelled core", () => {
    const result = run("open", {});
    expect(result.status, result.output).toBe(0);
    const pushes = result.calls.filter((c) => c.includes(" push "));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain(
      "push --force origin HEAD:refs/heads/automation/pdfium-chromium-8130",
    );
    const commit = result.calls.find((c) => c.includes(" commit "));
    expect(commit).toContain("github-actions[bot]");
    expect(commit).toContain("chore(core): move PDFium to chromium/8130");
    const creates = result.calls.filter((c) => c.startsWith("gh issue create"));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("--title Move PDFium to chromium/8130");
    expect(creates[0]).toContain("--label core");
    expect(result.calls.filter((c) => c.startsWith("gh issue edit"))).toEqual(
      [],
    );
  });

  it("edits the open issue whose title starts 'Move PDFium to', and opens no second one", () => {
    const result = run("edit", {
      issues: [
        { number: 5, title: "Why does Move PDFium to be slow" },
        { number: 7, title: "Move PDFium to chromium/8120" },
      ],
    });
    expect(result.status, result.output).toBe(0);
    const edits = result.calls.filter((c) => c.startsWith("gh issue edit"));
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("issue edit 7");
    expect(edits[0]).toContain("--title Move PDFium to chromium/8130");
    expect(result.calls.filter((c) => c.startsWith("gh issue create"))).toEqual(
      [],
    );
  });

  it("opens an issue when the search finds only other titles", () => {
    const result = run("others", {
      issues: [{ number: 5, title: "Why does Move PDFium to be slow" }],
    });
    expect(result.status, result.output).toBe(0);
    expect(
      result.calls.filter((c) => c.startsWith("gh issue create")),
    ).toHaveLength(1);
  });

  it("follows an annotated tag to the commit it names", () => {
    const result = run("annotated", { tag: "annotated" }, ["--dry-run"]);
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toContain(
      "gh api repos/bblanchon/pdfium-binaries/git/tags/" + TAG_OBJECT,
    );
    expect(result.output).toContain(`archive/${NEW_COMMIT}.tar.gz`);
  });

  it.each([
    [
      "the newest release cannot be read",
      "repos/bblanchon/pdfium-binaries/releases/latest",
    ],
    [
      "the tag cannot be resolved",
      "repos/bblanchon/pdfium-binaries/git/ref/tags/chromium/8130",
    ],
    ["the archive cannot be downloaded", "curl"],
    ["PDFium's branch cannot be read", "ls-remote"],
    ["the issues cannot be listed", "issue list"],
  ])("fails loudly, and pushes and opens nothing, when %s", (_, fail) => {
    const result = run(`fail-${fail.replaceAll(/\W/g, "-")}`, { fail });
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("Nothing to do");
    expect(wrote(result.calls)).toEqual([]);
  });

  it.each([
    ["PDFium's branch is missing", ""],
    [
      "PDFium's branch resolves to two commits",
      `${PDFIUM_HEAD}\tx\n${OLD_PDFIUM}\ty\n`,
    ],
  ])("fails when %s", (_, lsRemote) => {
    const result = run(`ls-${String(lsRemote.length)}`, { lsRemote });
    expect(result.status).not.toBe(0);
    expect(wrote(result.calls)).toEqual([]);
  });

  it("fails rather than leave a stale mention of the old release in the manifest", () => {
    const result = run("stale", {
      manifest: MANIFEST_TEXT.replace(
        "# Tesseract is pinned by commit.",
        "# Tesseract was checked against 8100.",
      ),
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("still names 8100");
    expect(wrote(result.calls)).toEqual([]);
  });

  it("fails when the newest release is not a chromium build", () => {
    const result = run("odd-tag", { newest: "v1.0" });
    expect(result.status).not.toBe(0);
    expect(wrote(result.calls)).toEqual([]);
  });

  it("fails without a token or a repository", () => {
    for (const name of ["GH_TOKEN", "GITHUB_REPOSITORY"]) {
      const out = (() => {
        try {
          return execFileSync("bash", [SCRIPT, "--dry-run"], {
            env: {
              PATH: process.env.PATH ?? "",
              [name === "GH_TOKEN" ? "GITHUB_REPOSITORY" : "GH_TOKEN"]: "x",
            },
            stdio: "pipe",
            encoding: "utf8",
          });
        } catch (error) {
          return (error as { stderr: string }).stderr;
        }
      })();
      expect(out, name).toContain(`${name} is not set`);
    }
  });
});
