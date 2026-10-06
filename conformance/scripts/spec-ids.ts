/**
 * Move the references to a chapter's numbered statements to the IDs that
 * replaced them, when the chapter moves to the ID form:
 *
 *   tsx scripts/spec-ids.ts plan <chapter> <decisions.json>
 *   tsx scripts/spec-ids.ts apply <chapter> <decisions.json>
 *   tsx scripts/spec-ids.ts verify <chapter> <git-ref>
 *
 * `plan` reads `spec-migrations/<chapter>.json`, finds every reference to the
 * chapter's numbers in the tree and writes each with the text that would
 * replace it. A reference that needs a reading, not a lookup, is marked
 * `needs_choice`: give it a `choice` in the file, the replacement text or a
 * list of IDs. `apply` refuses until every one has a choice, then rewrites
 * every reference. `verify` fails when the chapter, as it stands, no longer
 * cites a fixture it cited at the Git reference.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  droppedCitations,
  findSites,
  rewrite,
  unchosen,
  type Migration,
  type Site,
} from "../src/utils/spec-migration.js";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where a reference is rewritten. */
const REWRITTEN = /\.(?:ts|rs|swift|md|example)$/;
/** Where one is only reported: text that nothing here rewrites. */
const REPORTED = /\.(?:json|ya?ml|toml|sh|[cm]?js|txt|html|css|mdx)$/;
const SKIPPED =
  /(?:^|\/)(?:node_modules|target|dist)\/|^\.claude\/worktrees\/|^conformance\/spec-migrations\/|(?:^|\/)pnpm-lock\.yaml$/;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPOSITORY,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Every file Git tracks or would, that still exists, outside what is skipped. */
function tree(): string[] {
  return git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    .split("\0")
    .filter(
      (path) =>
        path !== "" &&
        !SKIPPED.test(path) &&
        existsSync(resolve(REPOSITORY, path)),
    );
}

function chapterName(value: string | undefined): string {
  if (value === undefined || !/^[a-z][a-z-]*$/.test(value)) {
    throw new Error("name a chapter, such as items, without .md");
  }
  return value;
}

function readMigration(chapter: string): Migration {
  const path = resolve(
    REPOSITORY,
    "conformance",
    "spec-migrations",
    `${chapter}.json`,
  );
  if (!existsSync(path)) {
    throw new Error(
      `conformance/spec-migrations/${chapter}.json does not exist`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Migration;
}

function plan(chapter: string, output: string | undefined): void {
  if (output === undefined) throw new Error("name the decisions file to write");
  const migration = readMigration(chapter);
  const own = `conformance/spec/${chapter}.md`;
  const sites: Site[] = [];
  const unrewritten: string[] = [];
  for (const path of tree()) {
    const rewritten = REWRITTEN.test(path);
    if (!rewritten && !REPORTED.test(path)) continue;
    const found = findSites(
      path,
      readFileSync(resolve(REPOSITORY, path), "utf8"),
      chapter,
      migration,
      path === own,
    );
    if (rewritten) sites.push(...found);
    else unrewritten.push(...found.map((s) => `${s.file}:${String(s.line)}`));
  }
  writeFileSync(
    resolve(output),
    `${JSON.stringify({ chapter, sites }, null, 2)}\n`,
  );
  const files = new Set(sites.map((site) => site.file));
  const waiting = sites.filter((site) => site.needs_choice);
  console.log(
    `${String(sites.length)} references in ${String(files.size)} files; ${String(waiting.length)} need a choice.`,
  );
  for (const site of waiting) {
    console.log(
      `  ${site.file}:${String(site.line)}  ${JSON.stringify(site.original)}  ${site.reasons.join("; ")}`,
    );
  }
  if (unrewritten.length > 0) {
    console.log(
      `References in files this does not rewrite, to move by hand: ${unrewritten.join(", ")}`,
    );
  }
}

function apply(chapter: string, input: string | undefined): void {
  if (input === undefined) throw new Error("name the decisions file to read");
  const decisions = JSON.parse(readFileSync(resolve(input), "utf8")) as {
    chapter: string;
    sites: Site[];
  };
  if (decisions.chapter !== chapter) {
    throw new Error(
      `the decisions are for ${decisions.chapter}, not ${chapter}`,
    );
  }
  const waiting = unchosen(decisions.sites);
  if (waiting.length > 0) {
    throw new Error(
      `${String(waiting.length)} references still need a choice: ${waiting.join(", ")}`,
    );
  }
  const byFile = new Map<string, Site[]>();
  for (const site of decisions.sites) {
    const path = resolve(REPOSITORY, site.file);
    if (!path.startsWith(`${REPOSITORY}/`)) {
      throw new Error(`${site.file} is outside the repository`);
    }
    byFile.set(site.file, [...(byFile.get(site.file) ?? []), site]);
  }
  // Every file is rewritten in memory first, so a stale plan writes nothing.
  const written = [...byFile].map(([file, sites]) => {
    const path = resolve(REPOSITORY, file);
    return [path, rewrite(readFileSync(path, "utf8"), sites)] as const;
  });
  for (const [path, text] of written) writeFileSync(path, text);
  console.log(
    `Rewrote ${String(decisions.sites.length)} references in ${String(byFile.size)} files.`,
  );
}

function verify(chapter: string, ref: string | undefined): void {
  if (ref === undefined)
    throw new Error("name a Git reference to compare with");
  const path = `conformance/spec/${chapter}.md`;
  const dropped = droppedCitations(
    git("show", `${ref}:${path}`),
    readFileSync(resolve(REPOSITORY, path), "utf8"),
  );
  if (dropped.length > 0) {
    console.error(
      `${path} no longer cites ${String(dropped.length)} fixtures it cited at ${ref}:`,
    );
    for (const citation of dropped) console.error(`  ${citation}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${path} cites every fixture it cited at ${ref}.`);
}

const [command, chapter, argument] = process.argv.slice(2);
try {
  if (command === "plan") plan(chapterName(chapter), argument);
  else if (command === "apply") apply(chapterName(chapter), argument);
  else if (command === "verify") verify(chapterName(chapter), argument);
  else throw new Error("use plan, apply or verify; see the top of this file");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
