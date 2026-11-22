/**
 * A migration a published release contains is never edited.
 *
 * A release's databases must keep opening, and a migration's SQL is what makes
 * them. `core/marfa-server/src/db/pinned.rs` pins each migration's digest, but a
 * pin is rewritten in the same change as the edit it guards, so the pin alone
 * lets an edit through (v0.0.88 edited `0001` in place and could not open a
 * v0.0.87 database). This test compares the tree with the newest published tag:
 * every migration the tag holds must be present here with the same bytes. A
 * migration the tag lacks is new, and allowed.
 *
 * The device store is held the same way: when `schema.sql` differs from the
 * tag's, `SCHEMA_VERSION` must have been raised, because a store at the old
 * version is opened as is.
 *
 * It needs the tags. A checkout without them fails here, loudly, since a skip
 * would be a silent pass. It reads git from the repository root, so it works in
 * a linked worktree.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = "core/marfa-server/src/db/migrations/";
const SCHEMA_SQL = "core/marfa-core/src/schema.sql";
const OPEN_RS = "core/marfa-core/src/store/open.rs";

const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const FETCH_TAGS =
  "fetch the tags (`git fetch --tags`, or `git fetch --depth=1 origin 'refs/tags/v*:refs/tags/v*'` in a shallow checkout)";

const byVersion = (a: string, b: string): number => {
  const [x, y] = [a, b].map((tag) => tag.slice(1).split(".").map(Number));
  for (let at = 0; at < 3; at += 1) {
    const diff = (x?.[at] ?? 0) - (y?.[at] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** Versions tagged and never released, from `scripts/release/abandoned-versions`. */
export function abandoned(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
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

/** The files a tag holds under a folder, with the blob id of each. */
export function treeBlobs(tag: string, folder: string): Map<string, string> {
  const listing = git("ls-tree", "-r", tag, "--", folder);
  const blobs = new Map<string, string>();
  for (const line of listing.split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    const id = meta?.split(" ")[2];
    if (id !== undefined && path !== undefined) blobs.set(path, id);
  }
  return blobs;
}

/** The files that changed, vanished or were renamed away from what the tag holds. */
export function editedSince(
  shipped: Map<string, string>,
  here: (path: string) => string | undefined,
): string[] {
  return [...shipped]
    .filter(([path, id]) => here(path) !== id)
    .map(([path]) => path);
}

export function storeVersion(source: string): number | undefined {
  const found = /pub const SCHEMA_VERSION: i64 = (\d+);/.exec(source);
  return found?.[1] === undefined ? undefined : Number(found[1]);
}

const hashHere = (path: string): string | undefined => {
  try {
    return git("hash-object", "--", path);
  } catch {
    return undefined;
  }
};

const abandonedText = readFileSync(
  new URL("../scripts/release/abandoned-versions", import.meta.url),
  "utf8",
);

describe("a migration a release has shipped", () => {
  it("is never edited, deleted or renamed", () => {
    const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
    const tag = newestPublished(tags, abandoned(abandonedText));
    // A stale fetch shows here: the tag this run compared with.
    console.log(
      `Migrations compared with the newest published release, ${tag}`,
    );
    const shipped = treeBlobs(tag, MIGRATIONS);
    expect(
      shipped.size,
      `${tag} holds no migration under ${MIGRATIONS}: ${FETCH_TAGS}.`,
    ).toBeGreaterThan(0);
    const edited = editedSince(shipped, hashHere);
    expect(
      edited,
      `${edited.join(", ")} changed since ${tag}, a release that shipped it. A migration a release has shipped is never edited: put it back as it was, and make the change a new numbered migration.`,
    ).toEqual([]);
  });

  it("is caught when the bytes differ, the file is gone or it was renamed", () => {
    const shipped = new Map([
      ["m/0001.sql", "aaa"],
      ["m/0002.sql", "bbb"],
    ]);
    const files: Record<string, string> = {
      "m/0001.sql": "aaa",
      "m/0002.sql": "bbb",
      "m/0003.sql": "ccc",
    };
    const at = (path: string): string | undefined => files[path];
    expect(editedSince(shipped, at)).toEqual([]);
    expect(
      editedSince(shipped, (p) => (p === "m/0001.sql" ? "x" : at(p))),
    ).toEqual(["m/0001.sql"]);
    expect(
      editedSince(shipped, (p) => (p === "m/0002.sql" ? undefined : at(p))),
    ).toEqual(["m/0002.sql"]);
  });
});

describe("the release finder", () => {
  it("takes the newest tag by version, not by name, and passes over an abandoned one", () => {
    const tags = ["v0.0.9", "v0.0.10", "v0.0.91", "v0.1.0-rc1", "other"];
    expect(newestPublished(tags, new Set())).toBe("v0.0.91");
    expect(newestPublished(tags, new Set(["0.0.91"]))).toBe("v0.0.10");
  });

  it("fails, naming how to fetch tags, when there are none", () => {
    expect(() => newestPublished([], new Set())).toThrow(/git fetch --tags/);
    expect(() => newestPublished(["v0.0.5"], new Set(["0.0.5"]))).toThrow(
      /git fetch --depth=1/,
    );
  });

  it("reads the abandoned versions past comments and blank lines", () => {
    expect([...abandoned("# note\n\n0.0.85\n 0.0.91 \n")]).toEqual([
      "0.0.85",
      "0.0.91",
    ]);
  });
});

describe("the device store", () => {
  it("raises SCHEMA_VERSION when schema.sql differs from the newest published release", () => {
    const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
    const tag = newestPublished(tags, abandoned(abandonedText));
    const shippedSql = git("rev-parse", `${tag}:${SCHEMA_SQL}`);
    if (shippedSql === hashHere(SCHEMA_SQL)) return;
    const was = storeVersion(git("show", `${tag}:${OPEN_RS}`));
    const now = storeVersion(readFileSync(`${ROOT}${OPEN_RS}`, "utf8"));
    expect(
      was,
      `SCHEMA_VERSION not found in ${OPEN_RS} at ${tag}`,
    ).toBeDefined();
    expect(now, `SCHEMA_VERSION not found in ${OPEN_RS}`).toBeDefined();
    expect(
      now,
      `${SCHEMA_SQL} changed since ${tag}, a release that shipped it, and SCHEMA_VERSION is still ${now}. Raise the store version in ${OPEN_RS} and add an upgrade step, so a store the release wrote still opens.`,
    ).toBeGreaterThan(was ?? Infinity);
  });

  it("reads the version from source", () => {
    expect(storeVersion("pub const SCHEMA_VERSION: i64 = 11;")).toBe(11);
    expect(storeVersion("nothing")).toBeUndefined();
  });
});
