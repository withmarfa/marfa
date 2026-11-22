/**
 * Which tag is the newest published release.
 *
 * `ci/released-migrations.test.ts` compares the tree with that tag, and the
 * `Quick checks` job fetches only that tag, so both choose it here:
 *
 *   node scripts/release/newest-release.ts
 *
 * prints the tag, read from the remote's `v*` tags without fetching them. A
 * version is ordered as `release.yml` orders it, by number and not by name,
 * and one listed in `scripts/release/abandoned-versions` was tagged and never
 * released, so it is passed over.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FETCH_TAGS =
  "fetch the tags (`git fetch --tags`, or `git fetch --depth=1 origin 'refs/tags/v*:refs/tags/v*'` in a shallow checkout)";

const byVersion = (a: string, b: string): number => {
  const [x, y] = [a, b].map((tag) => tag.slice(1).split(".").map(Number));
  for (let at = 0; at < 3; at += 1) {
    const diff = (x?.[at] ?? 0) - (y?.[at] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** Versions tagged and never released. Reads the file as `release.yml` does. */
export function abandoned(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((line) => line.replace(/#.*/, "").replace(/\s+/g, ""))
      .filter((line) => line !== ""),
  );
}

/** The newest tag that was published, or a failure naming how to get the tags. */
export function newestPublished(tags: string[], skip: Set<string>): string {
  const published = tags
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag) && !skip.has(tag.slice(1)))
    .sort(byVersion);
  const newest = published.at(-1);
  if (newest === undefined) {
    throw new Error(
      `No release tag is available, so no migration can be compared with a release: ${FETCH_TAGS}.`,
    );
  }
  return newest;
}

/** The tag names in the output of `git ls-remote --tags --refs`. */
export function tagsListed(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.split("\t")[1]?.replace(/^refs\/tags\//, ""))
    .filter((tag): tag is string => tag !== undefined && tag !== "");
}

export const abandonedVersions = (): Set<string> =>
  abandoned(
    readFileSync(new URL("./abandoned-versions", import.meta.url), "utf8"),
  );

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const listed = execFileSync(
    "git",
    ["ls-remote", "--tags", "--refs", "origin", "refs/tags/v*"],
    { encoding: "utf8" },
  );
  const tags = tagsListed(listed);
  if (tags.length === 0) {
    console.error("origin lists no v* release tag.");
    process.exit(1);
  }
  console.log(newestPublished(tags, abandonedVersions()));
}
