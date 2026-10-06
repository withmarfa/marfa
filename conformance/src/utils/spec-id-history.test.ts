import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  idHistoryBreaks,
  idSetsAt,
  idSetsOf,
  type IdSets,
} from "./spec-id-history.js";
import { readChapter } from "./spec-statements.js";

// The chapter is called `sample`, which no chapter is, so the IDs written in
// this file are not read as references by the checks that walk its source.

function chapter(active: string[], retired: string[] = []): string {
  const statements = active.map(
    (id) =>
      `### \`${id}\`\n\nThe server MUST answer.\n\n**Tests:** waiting on #1.\n`,
  );
  const list = retired.map((id) => `- \`${id}\`: withdrawn.`);
  return [
    "# Sample\n",
    "## Rules\n",
    ...statements,
    ...(list.length > 0 ? ["## Retired\n", `${list.join("\n")}\n`] : []),
  ].join("\n");
}

const setsOf = (text: string): IdSets =>
  idSetsOf([readChapter("sample", text)]);

describe("an ID that was there", () => {
  const base = setsOf(chapter(["sample/a", "sample/b"], ["sample/old"]));

  it("passes when every ID is still active or retired", () => {
    expect(idHistoryBreaks(base, base)).toEqual([]);
    // A statement that moves to the Retired list, and a new one, are fine.
    expect(
      idHistoryBreaks(
        base,
        setsOf(chapter(["sample/a", "sample/c"], ["sample/old", "sample/b"])),
      ),
    ).toEqual([]);
  });

  it("fails an active ID that is deleted, or renamed", () => {
    expect(
      idHistoryBreaks(base, setsOf(chapter(["sample/a"], ["sample/old"]))),
    ).toEqual([
      "sample/b was a statement and is neither a statement nor retired",
    ]);
    expect(
      idHistoryBreaks(
        base,
        setsOf(chapter(["sample/a", "sample/renamed"], ["sample/old"])),
      ),
    ).toEqual([
      "sample/b was a statement and is neither a statement nor retired",
    ]);
  });

  it("fails a retired ID that is dropped from the list, or given to a statement again", () => {
    expect(
      idHistoryBreaks(base, setsOf(chapter(["sample/a", "sample/b"]))),
    ).toEqual(["sample/old was retired and is no longer listed"]);
    expect(
      idHistoryBreaks(
        base,
        setsOf(chapter(["sample/a", "sample/b", "sample/old"])),
      ),
    ).toEqual(["sample/old was retired and is a statement again"]);
  });

  it("fails every ID of a chapter that is deleted", () => {
    expect(idHistoryBreaks(base, idSetsOf([]))).toEqual([
      "sample/a was a statement and is neither a statement nor retired",
      "sample/b was a statement and is neither a statement nor retired",
      "sample/old was retired and is no longer listed",
    ]);
  });
});

describe("the IDs at a Git reference", () => {
  const repository = mkdtempSync(join(tmpdir(), "marfa-spec-id-history-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

  it("reads the chapters as they were committed, and not the working tree", () => {
    git("init", "--quiet", "--initial-branch=main");
    mkdirSync(join(repository, "conformance", "spec"), { recursive: true });
    const spec = (name: string, text: string) =>
      writeFileSync(join(repository, "conformance", "spec", name), text);
    spec("sample.md", chapter(["sample/a"], ["sample/old"]));
    spec("README.md", chapter(["sample/not-a-chapter"]));
    spec("numbered.md", "1. A rule.\n");
    git("add", "--all");
    git("commit", "--quiet", "--message", "base");

    const base = idSetsAt("HEAD", repository);
    expect([...base.active]).toEqual(["sample/a"]);
    expect([...base.retired]).toEqual(["sample/old"]);

    // The witness: a branch that deletes the statement is seen as doing so.
    spec("sample.md", chapter(["sample/other"], ["sample/old"]));
    git("add", "--all");
    git("commit", "--quiet", "--message", "branch");
    expect(
      idHistoryBreaks(
        idSetsAt("HEAD~1", repository),
        idSetsAt("HEAD", repository),
      ),
    ).toEqual([
      "sample/a was a statement and is neither a statement nor retired",
    ]);
    expect(() => idSetsAt("no-such-ref", repository)).toThrow();
    rmSync(repository, { recursive: true });
  });
});
