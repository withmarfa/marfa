/**
 * Every journal entry's `when` must be strictly later than every stamp
 * before it, in both dialects.
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
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Dialect = "pg" | "sqlite";

const DIALECTS: readonly Dialect[] = ["pg", "sqlite"];

const DRIZZLE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

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
 * Pairs already in a journal whose `when` does not increase, each accepted
 * deliberately and each carrying the reasoning for it.
 *
 * An entry is exempt only on an exact match of all four identity fields, so
 * a second out-of-order pair still fails, and so does any edit that moves
 * either stamp. Adding a row here is a decision about a migration that has
 * already been applied somewhere, never a way to land a new one.
 */
interface AcceptedPair extends Violation {
  dialect: Dialect;
  reason: string;
}

const ACCEPTED: readonly AcceptedPair[] = [
  {
    dialect: "pg",
    tag: "0057_grant_marfa_app_membership",
    when: 1779028180997,
    afterTag: "0056_auth_jwks",
    afterWhen: 1779638402000,
    reason:
      "Stamped about seven days before its predecessor despite landing a day later, " +
      "so it is skipped on any database that had already applied 0056. It is recorded " +
      "rather than re-stamped because re-stamping an applied migration makes it run " +
      "again everywhere that already has it, and this one grants marfa_app membership: " +
      "a grant that is already in place on every instance serving tenant-scoped traffic, " +
      "whether by the migration or by an operator running it by hand, which its own " +
      "comment contemplates. A latent hazard rather than a live outage, and the check " +
      "holds every entry added after it.",
  },
];

function readJournalEntries(dialect: Dialect): JournalEntry[] {
  const path = join(DRIZZLE_ROOT, dialect, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf-8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/**
 * Every entry whose `when` fails to beat the highest stamp before it, in
 * journal order. Comparison is `<=`, because an equal stamp is skipped by
 * the migrator's strict `<` exactly as a lower one is.
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

function isAccepted(dialect: Dialect, violation: Violation): boolean {
  return ACCEPTED.some(
    (a) =>
      a.dialect === dialect &&
      a.tag === violation.tag &&
      a.when === violation.when &&
      a.afterTag === violation.afterTag &&
      a.afterWhen === violation.afterWhen,
  );
}

/**
 * What somebody meeting this at 2am has to be able to act on without any
 * other context: both tags, both stamps, what happens, and what to change.
 */
function describeViolation(dialect: Dialect, v: Violation): string {
  return [
    `${dialect} journal: "${v.tag}" is stamped when=${String(v.when)} ` +
      `(${new Date(v.when).toISOString()}), which is not later than the highest ` +
      `stamp before it, "${v.afterTag}" at when=${String(v.afterWhen)} ` +
      `(${new Date(v.afterWhen).toISOString()}).`,
    `Consequence: on any database that has already applied "${v.afterTag}", the ` +
      `entry "${v.tag}" will never be applied. The migrator compares each entry's ` +
      `when against the single highest created_at already recorded and applies only ` +
      `entries strictly greater, so this one is skipped with no error, no warning ` +
      `and no row. That mark only rises, so the skip is permanent, and the deploy ` +
      `reports success against a schema that is silently short.`,
    `Fix: re-stamp "${v.tag}" in packages/server/drizzle/${dialect}/meta/_journal.json ` +
      `to the current epoch millis, above every stamp already in the file. Renumbering ` +
      `the file or bumping idx changes nothing: the migrator reads neither. If the ` +
      `migration has already been applied somewhere, re-stamping runs it again there, ` +
      `so decide that before editing and record the pair in ACCEPTED instead if it ` +
      `cannot be re-stamped.`,
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
  it("names both tags, both stamps and the consequence", () => {
    const message = describeViolation("pg", {
      tag: "0099_late",
      when: 111,
      afterTag: "0098_early",
      afterWhen: 222,
    });
    expect(message).toContain("0099_late");
    expect(message).toContain("0098_early");
    expect(message).toContain("when=111");
    expect(message).toContain("when=222");
    expect(message).toContain("will never be applied");
    expect(message).toContain("packages/server/drizzle/pg/meta/_journal.json");
  });
});

describe("migration journals", () => {
  it.each(DIALECTS)(
    "%s: every entry's when beats every stamp before it",
    (dialect) => {
      const violations = findNonIncreasingStamps(
        readJournalEntries(dialect),
      ).filter((v) => !isAccepted(dialect, v));
      expect(
        violations
          .map((v) => describeViolation(dialect, v))
          .join("\n\n---\n\n"),
      ).toBe("");
    },
  );

  it("catches the pair already in the pg journal when it is not excepted", () => {
    // The synthetic cases above prove the comparison. This proves it against
    // the real shape, so the exception below is the only thing standing
    // between this journal and a failure.
    const violations = findNonIncreasingStamps(readJournalEntries("pg"));
    expect(violations).toEqual([
      {
        tag: "0057_grant_marfa_app_membership",
        when: 1779028180997,
        afterTag: "0056_auth_jwks",
        afterWhen: 1779638402000,
      },
    ]);
  });

  it("holds every accepted pair to a violation that is really there", () => {
    // An exception nothing matches is dead configuration, and the shape it
    // would rot into is one that silently exempts a pair somebody later
    // re-stamped. Each row has to still describe a real violation in the
    // journal it names.
    for (const accepted of ACCEPTED) {
      const violations = findNonIncreasingStamps(
        readJournalEntries(accepted.dialect),
      );
      expect(
        violations.some(
          (v) =>
            v.tag === accepted.tag &&
            v.when === accepted.when &&
            v.afterTag === accepted.afterTag &&
            v.afterWhen === accepted.afterWhen,
        ),
        `ACCEPTED names ${accepted.dialect} "${accepted.tag}" at when=${String(accepted.when)} ` +
          `after "${accepted.afterTag}" at when=${String(accepted.afterWhen)}, and no such ` +
          `violation is in that journal. Remove the row rather than leaving it to ` +
          `exempt something it was never written for.`,
      ).toBe(true);
    }
  });

  it("every tag names a journal entry that is unique", () => {
    // The comparison keys on tag, so a duplicate tag would make an exception
    // ambiguous about which entry it exempts.
    for (const dialect of DIALECTS) {
      const tags = readJournalEntries(dialect).map((e) => e.tag);
      expect(new Set(tags).size).toBe(tags.length);
    }
  });
});
