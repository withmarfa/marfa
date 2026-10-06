import { execFileSync } from "node:child_process";
import {
  chapterIds,
  isChapterName,
  readChapter,
  type Chapter,
} from "./spec-statements.js";

/**
 * An ID is permanent. One that was a statement, or a retired statement, at a
 * base is still one now; and a retired one is not given to a new statement.
 */

export interface IdSets {
  active: Set<string>;
  retired: Set<string>;
}

export function idSetsOf(chapters: Iterable<Chapter>): IdSets {
  const sets: IdSets = { active: new Set(), retired: new Set() };
  for (const chapter of chapters) {
    const ids = chapterIds(chapter);
    for (const id of ids.active) sets.active.add(id);
    for (const id of ids.retired) sets.retired.add(id);
  }
  return sets;
}

/** What the working tree does to the IDs the base had, one line each. */
export function idHistoryBreaks(base: IdSets, now: IdSets): string[] {
  const breaks: string[] = [];
  const known = (id: string) => now.active.has(id) || now.retired.has(id);
  for (const id of [...base.active].sort()) {
    if (!known(id)) {
      breaks.push(
        `${id} was a statement and is neither a statement nor retired`,
      );
    }
  }
  for (const id of [...base.retired].sort()) {
    if (now.active.has(id)) {
      breaks.push(`${id} was retired and is a statement again`);
    } else if (!now.retired.has(id)) {
      breaks.push(`${id} was retired and is no longer listed`);
    }
  }
  return breaks;
}

/** The IDs the chapters under `conformance/spec/` held at a Git reference. */
export function idSetsAt(ref: string, repository: string): IdSets {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  const names = git(
    "ls-tree",
    "--full-tree",
    "--name-only",
    ref,
    "conformance/spec/",
  )
    .split("\n")
    .filter((path) => path.endsWith(".md"));
  return idSetsOf(
    names
      .map((path) => ({
        path,
        stem: path.slice(path.lastIndexOf("/") + 1, -3),
      }))
      .filter(({ stem }) => isChapterName(stem))
      .map(({ path, stem }) =>
        readChapter(stem, git("show", `${ref}:${path}`)),
      ),
  );
}
