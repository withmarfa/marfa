/**
 * The roster of scanned columns has to keep up with the storage layer, and
 * nothing about writing a new store makes anybody think about it.
 *
 * This is the failure the ticket demonstrated on itself. Its inventory of
 * bare casts was counted by hand, and by the time the work started one row
 * of it was wrong: `spaces.status` had been closed and consolidated into
 * `storage/stored-space-status.ts`, so the table still named a defect that
 * no longer existed. A list a person maintains by reading the code is a
 * list that is accurate on the day it is written.
 *
 * So the roster is held to the code instead. Every `row.<column> as <T>` in
 * the storage sources names a claim about what a column contains, and each
 * one has to be either counted at boot or deliberately excluded with a
 * reason. A store that grows a new union fails here until somebody decides
 * which.
 *
 * The repository already blesses this shape: `routes/one-auth-layout.test.ts`
 * reads the route sources for a structural property and carries an allowed
 * list where each entry states why it does not generalize, and
 * `auth/non-http-mint-ceilings.test.ts` pins a set of call sites the same
 * way. This follows the first.
 *
 * **What it deliberately does not catch.** A cast written through a local
 * alias, a projection that narrows without casting at all, and a column
 * with no union in the first place are all outside it. It closes the way
 * the existing casts are written, which is the way the next one will be.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCANNED_COLUMNS,
  DELIBERATELY_UNSCANNED,
} from "./stored-value-scan.js";

const STORAGE_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Type names a cast can target that name no set of values.
 *
 * A cast to a primitive is an assertion about the shape the driver handed
 * back, not a claim that the string is one of a few particular strings, so
 * there is nothing for a scan to count. Everything else has to be
 * accounted for.
 */
const NOT_A_VALUE_UNION = new Set(["string", "number", "boolean", "unknown"]);

/** Every `.ts` under the storage layer, tests and generated files aside. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".generated.ts")
    ) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Source with its comments removed.
 *
 * Load-bearing rather than tidiness: the first run of this guard failed
 * against the module it guards, because that module's own doc comment
 * writes the pattern out to explain it. A cast inside a comment is not a
 * cast, and a guard that cannot tell prose from code makes documenting it
 * a build failure.
 *
 * Block comments and whole-line `//` comments only. A trailing `//` is
 * left alone because a URL inside a string literal is spelled the same
 * way, and dropping the rest of that line could hide a real cast beside
 * it.
 *
 * **What would make this wrong.** It does not parse, so a `/* *\/` marker
 * inside a string literal — a SQL comment in a query, most plausibly —
 * would start a strip at the wrong place and could swallow a real cast
 * after it. Nothing in the storage layer writes one today. The counting
 * case below is what would notice if something did.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Every `row.<column> as <Type>` in the storage sources, carrying the
 * column as well as the type, and where it was found so a failure names a
 * file rather than a type in the abstract.
 *
 * Anchored on `row.` rather than on `as` alone so it reads projections of
 * a stored row and not the many casts that shape a value on its way into
 * one. An indexed access is part of the name because that is how two of
 * these are spelled.
 *
 * **`\s+` rather than a literal space around `as`.** A cast Prettier wraps
 * across two lines is the same cast, and a reader that only matched one
 * spaced line would drop it silently — leaving the roster free to go stale
 * by reformatting.
 */
function storedValueCasts(): {
  column: string;
  type: string;
  where: string;
}[] {
  const pattern = /\brow\.(\w+)\s+as\s+([A-Za-z_$][\w$]*(?:\["[^"]+"\])?)/g;
  const found: { column: string; type: string; where: string }[] = [];
  for (const file of walk(STORAGE_DIR)) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(pattern)) {
      const [, column, type] = match;
      if (column && type) {
        found.push({ column, type, where: relative(STORAGE_DIR, file) });
      }
    }
  }
  return found;
}

/** How a column and its union are keyed together on both rosters. */
function pair(column: string, type: string): string {
  return `${column} as ${type}`;
}

describe("the scanned-column roster keeps up with the storage layer", () => {
  it("accounts for every column a stored row is cast on", () => {
    // Keyed on the column and the union together, not on the union alone.
    // A roster that asked only whether a type appeared somewhere was
    // silent on the case this feature exists for: a second column carrying
    // a union already on the list. `Tier` is on two of them already,
    // `api_keys.default_tier` and `items.tier`, so a third column cast to
    // it would pass that guard without anybody deciding anything, which is
    // the shape of the incident behind all of this: a column holding a
    // value nothing recognized.
    const scanned = new Set(
      SCANNED_COLUMNS.map((c) => pair(c.column, c.castType)),
    );
    const excused = new Set(
      DELIBERATELY_UNSCANNED.map((c) => pair(c.column, c.castType)),
    );

    const unaccounted = storedValueCasts().filter(
      ({ column, type }) =>
        !NOT_A_VALUE_UNION.has(type) &&
        !scanned.has(pair(column, type)) &&
        !excused.has(pair(column, type)),
    );

    // Reported with their locations: a bare count would say a column had
    // been added without saying which, which is the same investigation
    // every time.
    expect(
      unaccounted.map(
        ({ column, type, where }) => `${pair(column, type)} (${where})`,
      ),
    ).toEqual([]);
  });

  it("finds every occurrence it should, so partial loss cannot pass", () => {
    // Counting rather than detecting. An earlier version asked only
    // whether three type names appeared *at all*, so reformatting one
    // dialect's cast across two lines dropped it from the match set and
    // the suite stayed green — a reader losing half its input while
    // reporting success.
    //
    // Two properties, and the first is the one that maintains itself.
    // Every `(column, union)` pair in `pg/` has a mirror in `sqlite/`,
    // because the two dialects are written as siblings; a reader that
    // stopped seeing one file's casts breaks the symmetry without any
    // number being hardcoded here.
    const counts = new Map<string, { pg: number; sqlite: number }>();
    for (const { column, type, where } of storedValueCasts()) {
      if (NOT_A_VALUE_UNION.has(type)) continue;
      const key = pair(column, type);
      const seen = counts.get(key) ?? { pg: 0, sqlite: 0 };
      if (where.startsWith(`pg${sep}`)) seen.pg += 1;
      else if (where.startsWith(`sqlite${sep}`)) seen.sqlite += 1;
      counts.set(key, seen);
    }

    const asymmetric = [...counts.entries()]
      .filter(([, n]) => n.pg !== n.sqlite)
      .map(
        ([key, n]) => `${key}: pg ${String(n.pg)}, sqlite ${String(n.sqlite)}`,
      );
    expect(asymmetric).toEqual([]);

    // And an absolute floor under the three the scan depends on, so a
    // change that lost both dialects at once — symmetric, and therefore
    // invisible above — still fails. `>=` rather than `===` so a
    // legitimate new read does not redden a test it has nothing to do
    // with. Measured today: two, two, and four.
    const total = (key: string) => {
      const n = counts.get(key);
      return n ? n.pg + n.sqlite : 0;
    };
    expect(total("state as ItemState")).toBeGreaterThanOrEqual(2);
    expect(total("default_tier as Tier")).toBeGreaterThanOrEqual(2);
    expect(total("deletion_state as DeletionState")).toBeGreaterThanOrEqual(4);
  });

  it("gives a reason for every column it leaves uncounted", () => {
    for (const { table, column, because } of DELIBERATELY_UNSCANNED) {
      // "We thought about it and decided not to" and "nobody has looked"
      // are indistinguishable without one.
      expect(
        because.length,
        `${table}.${column} carries no reason`,
      ).toBeGreaterThan(40);
    }
  });

  it("does not both scan and excuse the same column", () => {
    const excused = new Set(
      DELIBERATELY_UNSCANNED.map((c) => pair(c.column, c.castType)),
    );
    const both = SCANNED_COLUMNS.filter((c) =>
      excused.has(pair(c.column, c.castType)),
    ).map((c) => `${c.table}.${c.column}`);
    expect(both).toEqual([]);
  });
});
