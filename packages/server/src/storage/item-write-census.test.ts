/**
 * Every item write goes through `writeItem`.
 *
 * The rules an item write must pass were once called door by door, outside
 * the transaction that wrote, and each door fixed on its own. A module that
 * reaches the store's write primitives directly reads as covered from every
 * angle a test of one door can see, so this reads the source instead: it
 * fails on a module outside the store that calls them, and on a module that
 * writes the `items` table with a statement of its own.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

/** The store's primitives that write an item row's content. */
const PRIMITIVE = /\.items\.(create|update)\(/;

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
  it("finds the primitives where they are called, so the scan below can see one", () => {
    const writer = readFileSync(join(root, "storage/item-write.ts"), "utf8");
    expect(writer).toMatch(PRIMITIVE);
  });

  it("calls the store's write primitives from writeItem alone", () => {
    const callers = sources().filter((rel) =>
      PRIMITIVE.test(readFileSync(join(root, rel), "utf8")),
    );
    expect(callers).toEqual(["storage/item-write.ts"]);
  });

  it("writes the items table only where a reason is named", () => {
    const writers = sources().filter((rel) =>
      TABLE_WRITE.test(readFileSync(join(root, rel), "utf8")),
    );
    expect(writers).toEqual(Object.keys(TABLE_WRITERS).sort());
  });
});
