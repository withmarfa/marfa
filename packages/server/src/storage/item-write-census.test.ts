/**
 * Every item write goes through `writeItem`.
 *
 * `Storage.items` carries only the store's reads, so the compiler refuses a
 * write through it or through any handle typed from it. Writes are reached
 * through `itemWrites` and the `ItemStore` type; this census fails on a
 * module that imports either without a reason named here, or writes the
 * `items` table with a statement of its own.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

/** Reaching the store's writes: `itemWrites`, or the `ItemStore` type however it is named. */
const WRITER = /\bitem-writes\.js"|\bItemStore\b/;

/** The source without its comments, so a mention is not a use. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

function reachesWrites(text: string): boolean {
  return WRITER.test(code(text));
}

/** Modules outside `storage/sqlite/` that reach the writes, each with why. */
const WRITERS: Record<string, string> = {
  "storage/item-write.ts": "the item write itself",
  "storage/item-writes.ts": "the way to the writes",
  "storage/interface.ts":
    "declares `ItemStore`, and `ItemReader` as it without its writes",
};

/** A statement written against the `items` table itself. */
const TABLE_WRITE =
  /\.(insert|update|delete)\(items\)|\b(INSERT INTO|UPDATE|DELETE FROM) items\b/;

/** Modules that write the table directly, each with why it may. */
const TABLE_WRITERS: Record<string, string> = {
  "storage/sqlite/item-store.ts": "the primitives `writeItem` calls",
  "storage/sqlite/metadata-store.ts":
    "moves the modification time beside a tag or extension write, inside that write's transaction",
  "storage/sqlite/oauth-provider-store.ts":
    "stamps a grant record's last use, a bookkeeping field no write door accepts",
};

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        rel !== "test-utils.ts"
      ) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out.sort();
}

describe("every item write goes through writeItem", () => {
  it("reaches the store's writes only where a reason is named", () => {
    const writers = sources().filter(
      (rel) =>
        !rel.startsWith("storage/sqlite/") &&
        reachesWrites(readFileSync(join(root, rel), "utf8")),
    );
    expect(writers).toEqual(Object.keys(WRITERS).sort());
  });

  it("sees the type however it is reached, and not where it is only mentioned", () => {
    expect(
      reachesWrites(
        'let s: import("../storage/interface.js").ItemStore | undefined;',
      ),
    ).toBe(true);
    expect(
      reachesWrites('import type { ItemStore } from "./interface.js";'),
    ).toBe(true);
    expect(
      reachesWrites('import { itemWrites } from "./item-writes.js";'),
    ).toBe(true);
    expect(
      reachesWrites(
        "/** Reads, as `ItemStore` has them. */\n// not an ItemStore\nconst a = 1;",
      ),
    ).toBe(false);
  });

  it("writes the items table only where a reason is named", () => {
    const writers = sources().filter((rel) =>
      TABLE_WRITE.test(readFileSync(join(root, rel), "utf8")),
    );
    expect(writers).toEqual(Object.keys(TABLE_WRITERS).sort());
  });
});
