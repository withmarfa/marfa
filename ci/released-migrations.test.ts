/**
 * What a published release shipped stays as it shipped.
 *
 * A release's databases must keep opening, and a migration's SQL is what makes
 * them. `core/marfa-server/src/db/pinned.rs` pins each migration's digest, but a
 * pin is rewritten in the same change as the edit it guards, so the pin alone
 * lets an edit through (v0.0.88 edited `0001` in place and could not open a
 * v0.0.87 database). This test compares the tree with the newest published tag
 * and holds three things the tag has to what the tag has:
 *
 * - every migration file, byte for byte;
 * - every entry of `PINS` (version, file and holds), so a released version
 *   cannot be pointed at another file, dropped or re-pinned;
 * - every entry of the device store's `SHAPES`, which must be a prefix of the
 *   tree's list. Whether a store a release wrote still opens is
 *   `OLDEST_UPGRADED`'s choice in `core/marfa-core/src/store/open.rs`, not
 *   this test's.
 *
 * Something the tag lacks is new, and allowed. The Rust tests tie `PINS` and
 * `SHAPES` to what the build makes, so together they cover a change the files
 * alone would miss.
 *
 * In `Quick checks` the `Fetch the newest release tag` step fetches the tag
 * and names it in `MARFA_RELEASE_TAG`. Elsewhere the test chooses from the
 * local tags, and a checkout with none fails here, loudly, since a skip would
 * be a silent pass. It reads git from the repository root, so it works in a
 * linked worktree.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FETCH_TAGS,
  abandoned,
  abandonedVersions,
  newestPublished,
  tagsListed,
} from "../scripts/release/newest-release.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = "core/marfa-server/src/db/migrations/";
const PINNED_RS = "core/marfa-server/src/db/pinned.rs";
const OPENING_RS = "core/marfa-core/src/store/tests/opening.rs";

const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const releaseTag = (): string => {
  const named = process.env.MARFA_RELEASE_TAG;
  if (named !== undefined && named !== "") return named;
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  return newestPublished(tags, abandonedVersions());
};

const atTag = (tag: string, path: string): string => {
  try {
    return git("show", `${tag}:${path}`);
  } catch {
    throw new Error(`${tag} holds no ${path}: ${FETCH_TAGS}.`);
  }
};

const atHead = (path: string): string => readFileSync(`${ROOT}${path}`, "utf8");

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

const hashHere = (path: string): string | undefined => {
  try {
    return git("hash-object", "--", path);
  } catch {
    return undefined;
  }
};

/** Each `PINS` entry of `pinned.rs`, by version, as `file holds`. */
export function pins(source: string): Map<string, string> {
  const start = source.indexOf("const PINS");
  const table = source.slice(start, source.indexOf("];", start));
  const found = new Map<string, string>();
  const entry =
    /Pin\s*\{\s*version:\s*(\d+),\s*file:\s*"([0-9a-f]+)",\s*holds:\s*"([0-9a-f]+)",?\s*\}/g;
  for (const [, version, file, holds] of table.matchAll(entry)) {
    if (version !== undefined && file !== undefined && holds !== undefined) {
      if (found.has(version)) {
        throw new Error(`PINS names schema version ${version} twice.`);
      }
      found.set(version, `${file} ${holds}`);
    }
  }
  return found;
}

/** The `SHAPES` of the store's opening tests, by version, as the hash. */
export function shapes(source: string): Map<string, string> {
  const start = source.indexOf("const SHAPES");
  const body = source.slice(start, source.indexOf("];", start));
  const found = new Map<string, string>();
  [...body.matchAll(/"([0-9a-f]+)"/g)].forEach((hash, at) => {
    if (hash[1] !== undefined) found.set(String(at + 1), hash[1]);
  });
  return found;
}

/**
 * What a release holds that the tree lacks or has changed. `here` answers
 * undefined for what is absent. The two cases need different words: a branch
 * behind the tag lacks what the tag has, and must not add a duplicate.
 */
export function frozenProblems(
  tag: string,
  what: string,
  shipped: Map<string, string>,
  here: (key: string) => string | undefined,
  remedy: string,
): string[] {
  const absent: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of shipped) {
    const now = here(key);
    if (now === undefined) absent.push(key);
    else if (now !== value) changed.push(key);
  }
  const problems: string[] = [];
  if (absent.length > 0) {
    problems.push(
      `${what} ${absent.join(", ")} in ${tag} but not in this tree: if this branch is older than ${tag}, bring it up to date with main.`,
    );
  }
  if (changed.length > 0) {
    problems.push(
      `${what} ${changed.join(", ")} changed since ${tag}, a release that shipped it. ${remedy}`,
    );
  }
  return problems;
}

const MIGRATION_REMEDY =
  "A migration a release has shipped is never edited: put it back as it was, and make the change a new numbered migration.";
const PIN_REMEDY =
  "A released version's pin is frozen: put it back as it was, and pin a new migration as a new version. A new pin is only for a version no release holds.";
const SHAPE_REMEDY =
  "A released shape is never edited: put the entry back as it was and append the new shape as a new version. Raising SCHEMA_VERSION while OLDEST_UPGRADED equals SCHEMA_VERSION (open.rs) makes the build refuse every store the release wrote, so to keep those stores opening, fix OLDEST_UPGRADED at the old version and add a step to UPGRADES.";

const migrationProblems = (tag: string): string[] =>
  frozenProblems(
    tag,
    "migration",
    treeBlobs(tag, MIGRATIONS),
    hashHere,
    MIGRATION_REMEDY,
  );

const pinProblems = (tag: string, here: string): string[] =>
  frozenProblems(
    tag,
    "pin for version",
    pins(atTag(tag, PINNED_RS)),
    (version) => pins(here).get(version),
    PIN_REMEDY,
  );

const shapeProblems = (tag: string, here: string): string[] =>
  frozenProblems(
    tag,
    "SHAPES entry for version",
    shapes(atTag(tag, OPENING_RS)),
    (version) => shapes(here).get(version),
    SHAPE_REMEDY,
  );

describe("a migration a release has shipped", () => {
  const tag = releaseTag();

  it("is never edited, deleted or renamed", () => {
    // A stale fetch shows here: the tag this run compared with.
    console.log(
      `Migrations compared with the newest published release, ${tag}`,
    );
    expect(
      treeBlobs(tag, MIGRATIONS).size,
      `${tag} holds no migration under ${MIGRATIONS}: ${FETCH_TAGS}.`,
    ).toBeGreaterThan(0);
    expect(migrationProblems(tag)).toEqual([]);
  });

  it("keeps its pin: every pin the release holds is still there, unchanged", () => {
    expect(pins(atTag(tag, PINNED_RS)).size).toBeGreaterThan(0);
    expect(pinProblems(tag, atHead(PINNED_RS))).toEqual([]);
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
    const check = (here: (path: string) => string | undefined): string[] =>
      frozenProblems("v1", "migration", shipped, here, MIGRATION_REMEDY);
    expect(check(at)).toEqual([]);
    const edited = check((p) => (p === "m/0001.sql" ? "x" : at(p)));
    expect(edited).toHaveLength(1);
    expect(edited[0]).toContain(
      "A migration a release has shipped is never edited",
    );
    expect(edited[0]).toContain("m/0001.sql changed since v1");
    expect(edited[0]).not.toContain("not in this tree");
    const gone = check((p) => (p === "m/0002.sql" ? undefined : at(p)));
    expect(gone).toHaveLength(1);
    expect(gone[0]).toContain(
      "m/0002.sql in v1 but not in this tree: if this branch is older than v1, bring it up to date with main",
    );
    expect(gone[0]).not.toContain("never edited");
  });
});

describe("the pins", () => {
  const entry = (version: number, file: string, holds: string): string =>
    `Pin { version: ${String(version)}, file: "${file}", holds: "${holds}" },`;
  const released = `const PINS: &[Pin] = &[\n${entry(11, "aa", "bb")}\n${entry(12, "cc", "dd")}\n];`;

  it("reads each entry as the file writes it", () => {
    const multiline = `const PINS: &[Pin] = &[\n    Pin {\n        version: 1,\n        file: "ab12",\n        holds: "cd34",\n    },\n];`;
    expect([...pins(multiline)]).toEqual([["1", "ab12 cd34"]]);
    expect([...pins(released)]).toEqual([
      ["11", "aa bb"],
      ["12", "cc dd"],
    ]);
  });

  it("lets a new version be appended", () => {
    const next = `${released}\n${entry(13, "ee", "ff")}`;
    expect(
      frozenProblems(
        "v1",
        "pin",
        pins(released),
        (v) => pins(next).get(v),
        PIN_REMEDY,
      ),
    ).toEqual([]);
  });

  it("fails a version pointed at a new file with a new pin (the remap trick)", () => {
    const remapped = released.replace(
      entry(12, "cc", "dd"),
      entry(12, "ee", "dd"),
    );
    const found = frozenProblems(
      "v1",
      "pin",
      pins(released),
      (v) => pins(remapped).get(v),
      PIN_REMEDY,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("pin 12 changed since v1");
  });

  it("fails a changed holds, and a removed entry", () => {
    const drifted = released.replace(
      entry(11, "aa", "bb"),
      entry(11, "aa", "99"),
    );
    expect(
      frozenProblems(
        "v1",
        "pin",
        pins(released),
        (v) => pins(drifted).get(v),
        PIN_REMEDY,
      )[0],
    ).toContain("pin 11 changed since v1");
    const removed = released.replace(entry(12, "cc", "dd"), "");
    expect(
      frozenProblems(
        "v1",
        "pin",
        pins(released),
        (v) => pins(removed).get(v),
        PIN_REMEDY,
      )[0],
    ).toContain("12 in v1 but not in this tree");
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

  it("reads the abandoned versions as release.yml does, past comments, blanks and spaces", () => {
    expect([
      ...abandoned(
        "# note\n\n0.0.85\n 0.0.91 \n0.0.99  # a comment\n0 . 0.100\n",
      ),
    ]).toEqual(["0.0.85", "0.0.91", "0.0.99", "0.0.100"]);
  });

  it("reads tag names from `git ls-remote --tags --refs`", () => {
    const listed = "abc\trefs/tags/v0.0.97\ndef\trefs/tags/v0.0.98\n";
    expect(tagsListed(listed)).toEqual(["v0.0.97", "v0.0.98"]);
    expect(newestPublished(tagsListed(listed), new Set())).toBe("v0.0.98");
    expect(tagsListed("")).toEqual([]);
  });
});

describe("the device store", () => {
  const tag = releaseTag();

  it("keeps every shape the newest published release holds", () => {
    expect(shapes(atTag(tag, OPENING_RS)).size).toBeGreaterThan(0);
    expect(shapeProblems(tag, atHead(OPENING_RS))).toEqual([]);
  });

  it("reads SHAPES from source", () => {
    const source = `const SHAPES: [&str; 2] = [\n    "ab12",\n    "cd34",\n];\nfn x() {}`;
    expect([...shapes(source)]).toEqual([
      ["1", "ab12"],
      ["2", "cd34"],
    ]);
  });

  it("passes a comment-only edit, which leaves SHAPES alone, and an appended shape", () => {
    const shipped = `const SHAPES: [&str; 2] = [\n    "ab12",\n    "cd34",\n];`;
    const appended = `const SHAPES: [&str; 3] = [\n    "ab12",\n    "cd34",\n    "ef56",\n];`;
    const held = shapes(shipped);
    expect(
      frozenProblems(
        "v1",
        "shape",
        held,
        (v) => shapes(shipped).get(v),
        SHAPE_REMEDY,
      ),
    ).toEqual([]);
    expect(
      frozenProblems(
        "v1",
        "shape",
        held,
        (v) => shapes(appended).get(v),
        SHAPE_REMEDY,
      ),
    ).toEqual([]);
  });

  it("fails an edited released entry, and says what raising the version does to stores", () => {
    const shipped = `const SHAPES: [&str; 2] = [\n    "ab12",\n    "cd34",\n];`;
    const edited = shipped.replace("cd34", "ff00");
    const found = frozenProblems(
      "v1",
      "SHAPES entry for version",
      shapes(shipped),
      (v) => shapes(edited).get(v),
      SHAPE_REMEDY,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("SHAPES entry for version 2 changed since v1");
    expect(found[0]).toContain("refuse every store the release wrote");
    expect(found[0]).toContain("fix OLDEST_UPGRADED at the old version");
    const dropped = frozenProblems(
      "v1",
      "SHAPES entry for version",
      shapes(shipped),
      (v) => shapes(`const SHAPES: [&str; 1] = [ "ab12" ];`).get(v),
      SHAPE_REMEDY,
    );
    expect(dropped[0]).toContain("2 in v1 but not in this tree");
  });
});
