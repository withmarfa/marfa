/**
 * Every journal entry's `when` must be strictly later than every stamp
 * before it, on every migration chain in the repository.
 *
 * `when` is chosen by hand, and it is the only thing the migrator reads to
 * decide what to apply. It compares each entry against the single highest
 * `created_at` already recorded and applies only entries strictly greater
 * (`Number(lastDbMigration.created_at) < migration.folderMillis`, identically
 * in drizzle-orm's Postgres and libsql migrators). Three things follow, and
 * none of them is visible in the file's shape:
 *
 *   - The filename number and `idx` are never read. They locate the `.sql`
 *     file and nothing more, so renumbering a rebased migration looks like
 *     the fix and is not one.
 *   - The comparison is against one row, not against a set of what has run.
 *     An entry stamped at or below the high-water mark is skipped, and the
 *     mark only ever rises, so nothing revisits it. The skip is permanent.
 *   - Nothing reports it. No error, no warning, no row. The deploy succeeds
 *     and the schema is silently short.
 *
 * The two `Fresh migrate` jobs are what a reader expects to cover this and
 * are structurally incapable of it: on an empty database the migrations
 * table has no rows, so the `!lastDbMigration` arm short-circuits and every
 * entry applies whatever its stamp. A fresh migrate is green under any
 * ordering at all, and the defect exists only on the upgrade path, which no
 * job exercises. `scripts/lint-sqlite-migrations.ts` checks statement
 * breakpoints and never opens the journal.
 *
 * So this is a plain test in the ordinary suite rather than a workflow, for
 * the reason `publishing/published-surface.test.ts` states for itself:
 * freshness workflows are excluded from pull-request events, so a test is
 * the only thing that cannot be merged past.
 *
 * **The chains are discovered, not listed.** This was keyed on a union of
 * the server's two dialects and rooted at that package, so a chain belonging
 * to anything else was outside what it could see -- and one was about to
 * arrive. Restating the rule in the package that owns the new chain would
 * make it two rules free to drift, which is the failure this repository
 * records most often, so instead the rule takes the chains as data and finds
 * them by shape. A chain added anywhere is covered the moment it lands, with
 * nobody needing to remember.
 */
import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/**
 * One migration chain: the repository-relative directory holding it, used as
 * its name everywhere, and the journal inside it.
 */
interface Chain {
  /** e.g. `packages/server/drizzle/sqlite`. Names the chain in every message. */
  id: string;
  journalPath: string;
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Violation {
  /** The entry that will be skipped. */
  tag: string;
  when: number;
  /** The entry holding the high-water mark it fails to beat. */
  afterTag: string;
  afterWhen: number;
}

/**
 * Every migration chain under `root`, found by shape: a directory holding a
 * `meta/_journal.json`.
 *
 * Keyed on the journal rather than on a dialect name, because the dialect is
 * the part that varies -- `sqlite` and a kit's `local` store are two
 * different words for one structure, and a union of them is a list to forget
 * to extend. The journal file is what the migrator actually reads, so finding
 * it is finding the thing the rule is about.
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function discoverChains(root: string): Chain[] {
  const chains: Chain[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".turbo"]);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      const journalPath = join(full, "meta/_journal.json");
      if (isFile(journalPath)) {
        chains.push({
          id: relative(root, full).split(sep).join("/"),
          journalPath,
        });
        continue;
      }
      walk(full);
    }
  };
  walk(root);
  return chains.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Pairs already in a journal whose `when` does not increase, each accepted
 * deliberately and each carrying the reasoning for it.
 *
 * An entry is exempt only on an exact match of all four identity fields and
 * the chain holding it, so a second out-of-order pair still fails, and so
 * does any edit that moves either stamp. Adding a row here is a decision
 * about a migration that has already been applied somewhere, never a way to
 * land a new one.
 */
interface AcceptedPair extends Violation {
  chain: string;
  reason: string;
}

const ACCEPTED: readonly AcceptedPair[] = [];

function readJournalEntries(chain: Chain): JournalEntry[] {
  const journal = JSON.parse(readFileSync(chain.journalPath, "utf-8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/**
 * Every entry whose `when` fails to beat the highest stamp before it, in
 * journal order. Comparison is `<=`, because an equal stamp is skipped by the
 * migrator's strict `<` exactly as a lower one is.
 */
function findNonIncreasingStamps(
  entries: readonly JournalEntry[],
): Violation[] {
  const violations: Violation[] = [];
  let maxWhen = Number.NEGATIVE_INFINITY;
  let maxTag = "";
  for (const entry of entries) {
    if (maxTag !== "" && entry.when <= maxWhen) {
      violations.push({
        tag: entry.tag,
        when: entry.when,
        afterTag: maxTag,
        afterWhen: maxWhen,
      });
      continue;
    }
    maxWhen = entry.when;
    maxTag = entry.tag;
  }
  return violations;
}

function isAccepted(chain: Chain, violation: Violation): boolean {
  return ACCEPTED.some(
    (a) =>
      a.chain === chain.id &&
      a.tag === violation.tag &&
      a.when === violation.when &&
      a.afterTag === violation.afterTag &&
      a.afterWhen === violation.afterWhen,
  );
}

/**
 * What somebody meeting this at 2am has to be able to act on without any
 * other context: which chain, both tags, both stamps, what happens, and what
 * to change. The chain is named from what was discovered rather than
 * assembled from a dialect, so the path in the message is the file to open
 * even on a chain this test has never seen before.
 */
function describeViolation(chain: Chain, v: Violation): string {
  const journal = `${chain.id}/meta/_journal.json`;
  return [
    `${chain.id}: "${v.tag}" is stamped when=${String(v.when)} ` +
      `(${new Date(v.when).toISOString()}), which is not later than the highest ` +
      `stamp before it, "${v.afterTag}" at when=${String(v.afterWhen)} ` +
      `(${new Date(v.afterWhen).toISOString()}).`,
    `Consequence: on any database that has already applied "${v.afterTag}", the ` +
      `entry "${v.tag}" will never be applied. The migrator compares each entry's ` +
      `when against the single highest created_at already recorded and applies only ` +
      `entries strictly greater, so this one is skipped with no error, no warning ` +
      `and no row. That mark only rises, so the skip is permanent, and the deploy ` +
      `reports success against a schema that is silently short.`,
    `Fix: re-stamp "${v.tag}" in ${journal} to the current epoch millis, above ` +
      `every stamp already in the file. Renumbering the file or bumping idx changes ` +
      `nothing: the migrator reads neither. If the migration has already been ` +
      `applied somewhere, re-stamping runs it again there, so decide that before ` +
      `editing and record the pair in ACCEPTED instead if it cannot be re-stamped.`,
  ].join("\n\n");
}

describe("findNonIncreasingStamps", () => {
  const entry = (idx: number, tag: string, when: number): JournalEntry => ({
    idx,
    version: "7",
    when,
    tag,
    breakpoints: true,
  });

  it("finds nothing in a strictly increasing journal", () => {
    expect(
      findNonIncreasingStamps([
        entry(0, "0000_a", 1000),
        entry(1, "0001_b", 2000),
        entry(2, "0002_c", 3000),
      ]),
    ).toEqual([]);
  });

  it("catches an entry stamped before its predecessor", () => {
    expect(
      findNonIncreasingStamps([
        entry(0, "0000_a", 1000),
        entry(1, "0001_b", 3000),
        entry(2, "0002_c", 2000),
      ]),
    ).toEqual([
      { tag: "0002_c", when: 2000, afterTag: "0001_b", afterWhen: 3000 },
    ]);
  });

  it("catches an entry stamped equal to the mark, which the migrator skips too", () => {
    // The migrator's comparison is strict (`<`), so an equal stamp is not
    // applied either. A check written with `<` rather than `<=` would pass
    // this journal and the migration would still never run.
    expect(
      findNonIncreasingStamps([
        entry(0, "0000_a", 1000),
        entry(1, "0001_b", 1000),
      ]),
    ).toEqual([
      { tag: "0001_b", when: 1000, afterTag: "0000_a", afterWhen: 1000 },
    ]);
  });

  it("compares against the running maximum, not against the previous entry", () => {
    // A single low entry does not lower the bar for what comes after it.
    // Comparing neighbors would report 0002_c and then call 0003_d fine,
    // when 0003_d is skipped for exactly the same reason.
    expect(
      findNonIncreasingStamps([
        entry(0, "0000_a", 1000),
        entry(1, "0001_b", 9000),
        entry(2, "0002_c", 2000),
        entry(3, "0003_d", 3000),
      ]).map((v) => v.tag),
    ).toEqual(["0002_c", "0003_d"]);
  });

  it("never reports the first entry, which has nothing before it", () => {
    expect(findNonIncreasingStamps([entry(0, "0000_a", 0)])).toEqual([]);
  });
});

describe("describeViolation", () => {
  it("names the chain, both tags, both stamps and the consequence", () => {
    const message = describeViolation(
      {
        id: "packages/server/drizzle/sqlite",
        journalPath: "/anywhere/meta/_journal.json",
      },
      { tag: "0099_late", when: 111, afterTag: "0098_early", afterWhen: 222 },
    );
    expect(message).toContain("0099_late");
    expect(message).toContain("0098_early");
    expect(message).toContain("when=111");
    expect(message).toContain("when=222");
    expect(message).toContain("will never be applied");
    expect(message).toContain(
      "packages/server/drizzle/sqlite/meta/_journal.json",
    );
  });

  it("names a chain it has never seen rather than a dialect it assumed", () => {
    // The message used to assemble `packages/server/drizzle/${dialect}`, so a
    // chain anywhere else would have been reported against a path that does
    // not exist -- pointing whoever read it at the wrong file, or at no file.
    const message = describeViolation(
      {
        id: "packages/sdk/drizzle/local",
        journalPath: "/anywhere/meta/_journal.json",
      },
      { tag: "0002_b", when: 111, afterTag: "0001_a", afterWhen: 222 },
    );
    expect(message).toContain("packages/sdk/drizzle/local/meta/_journal.json");
    expect(message).not.toContain("packages/server");
  });
});

describe("discoverChains", () => {
  /** A throwaway repository holding whatever chains the case needs. */
  function scratchRepo(
    chains: Record<string, { tag: string; when: number }[]>,
  ): string {
    const root = mkdtempSync(join(tmpdir(), "marfa-journal-"));
    for (const [dir, entries] of Object.entries(chains)) {
      mkdirSync(join(root, dir, "meta"), { recursive: true });
      writeFileSync(
        join(root, dir, "meta/_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "sqlite",
          entries: entries.map((e, idx) => ({
            idx,
            version: "7",
            when: e.when,
            tag: e.tag,
            breakpoints: true,
          })),
        }),
      );
    }
    return root;
  }

  it("finds a chain under any package, not only the server's", () => {
    const root = scratchRepo({
      "packages/server/drizzle/sqlite": [{ tag: "0000_a", when: 1000 }],
      "packages/sdk/drizzle/local": [{ tag: "0000_a", when: 1000 }],
    });
    expect(discoverChains(root).map((c) => c.id)).toEqual([
      "packages/sdk/drizzle/local",
      "packages/server/drizzle/sqlite",
    ]);
  });

  it("reports an out-of-order stamp on a chain it has never seen, by name", () => {
    // The acceptance this rewrite exists for. A guard that discovers nothing
    // and passes is indistinguishable from one that discovers everything and
    // passes, so the new chain has to be shown being reached: a third chain,
    // in a package that is not the server, breaking the rule, named in the
    // output rather than merely counted.
    const root = scratchRepo({
      "packages/server/drizzle/sqlite": [{ tag: "0000_a", when: 1000 }],
      "packages/sdk/drizzle/local": [
        { tag: "0000_a", when: 3000 },
        { tag: "0001_b", when: 2000 },
      ],
    });
    const reported = discoverChains(root).flatMap((chain) =>
      findNonIncreasingStamps(readJournalEntries(chain)).map((v) =>
        describeViolation(chain, v),
      ),
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("packages/sdk/drizzle/local");
    expect(reported[0]).toContain("0001_b");
    expect(reported[0]).toContain(
      "packages/sdk/drizzle/local/meta/_journal.json",
    );
  });

  it("does not mistake a directory that merely has a meta folder", () => {
    const root = scratchRepo({});
    mkdirSync(join(root, "packages/server/drizzle/sqlite/meta"), {
      recursive: true,
    });
    expect(discoverChains(root)).toEqual([]);
  });

  it("does not descend into node_modules", () => {
    // A dependency shipping its own journal is not ours to hold to this rule,
    // and there are enough of them to make the suite unusable.
    const root = scratchRepo({
      "node_modules/some-dep/drizzle/sqlite": [{ tag: "0000_a", when: 1000 }],
    });
    expect(discoverChains(root)).toEqual([]);
  });
});

describe("migration journals", () => {
  const chains = discoverChains(REPO_ROOT);

  it("finds every chain in the repository", () => {
    // The control. Discovery that walks the wrong root returns nothing and
    // every check below passes vacuously, which reads exactly like a clean
    // repository. This is the chain on this branch; the assertion is a floor
    // rather than an equality so that landing a second covers it here
    // instead of failing here.
    expect(chains.map((c) => c.id)).toEqual(
      expect.arrayContaining(["packages/server/drizzle/sqlite"]),
    );
  });

  it.each(chains.map((c) => [c.id, c] as const))(
    "%s: every entry's when beats every stamp before it",
    (_id, chain) => {
      const violations = findNonIncreasingStamps(
        readJournalEntries(chain),
      ).filter((v) => !isAccepted(chain, v));
      expect(
        violations.map((v) => describeViolation(chain, v)).join("\n\n---\n\n"),
      ).toBe("");
    },
  );

  it("holds every accepted pair to a violation that is really there", () => {
    // An exception nothing matches is dead configuration, and the shape it
    // would rot into is one that silently exempts a pair somebody later
    // re-stamped. Each row has to still describe a real violation in the
    // chain it names -- including that chain still existing, since a row
    // pointing at a journal that moved exempts nothing and hides that it
    // does.
    for (const accepted of ACCEPTED) {
      const chain = chains.find((c) => c.id === accepted.chain);
      expect(
        chain,
        `ACCEPTED names the chain "${accepted.chain}", and no such chain was ` +
          `discovered. Point the row at wherever that journal moved to, or remove it.`,
      ).toBeDefined();
      const violations = findNonIncreasingStamps(readJournalEntries(chain!));
      expect(
        violations.some(
          (v) =>
            v.tag === accepted.tag &&
            v.when === accepted.when &&
            v.afterTag === accepted.afterTag &&
            v.afterWhen === accepted.afterWhen,
        ),
        `ACCEPTED names ${accepted.chain} "${accepted.tag}" at when=${String(accepted.when)} ` +
          `after "${accepted.afterTag}" at when=${String(accepted.afterWhen)}, and no such ` +
          `violation is in that journal. Remove the row rather than leaving it to ` +
          `exempt something it was never written for.`,
      ).toBe(true);
    }
  });

  it("every tag names a journal entry that is unique", () => {
    // The comparison keys on tag, so a duplicate tag would make an exception
    // ambiguous about which entry it exempts.
    for (const chain of chains) {
      const tags = readJournalEntries(chain).map((e) => e.tag);
      expect(new Set(tags).size, `duplicate tag in ${chain.id}`).toBe(
        tags.length,
      );
    }
  });
});
