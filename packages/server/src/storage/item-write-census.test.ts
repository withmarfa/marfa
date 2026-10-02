/**
 * Every item write goes through `writeItem`.
 *
 * The rules an item write must pass were once called door by door, outside
 * the transaction that wrote, and each door fixed on its own. A module that
 * reaches the store's write primitives directly reads as covered from every
 * angle a test of one door can see. So `Storage.items` carries only the
 * store's reads, and the compiler refuses a write through it or through any
 * handle typed from it; the writes are reached through `itemWrites` and the
 * `ItemStore` type, and this fails on a module that imports either without a
 * reason named here, and on a module that writes the `items` table with a
 * statement of its own.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

/** Importing the way to the store's writes, by name or by type. */
const WRITER =
  /from "[./]*(?:storage\/)?item-writes\.js"|import[^;]*\bItemStore\b[^;]*from/;

/** Modules outside `storage/sqlite/` that reach the writes, each with why. */
const WRITERS: Record<string, string> = {
  "storage/item-write.ts": "the item write itself",
  "storage/item-writes.ts": "the way to the writes",
  "storage/retention.ts":
    "the trash and revoked-grant sweeps the store runs on itself, each typed to its one method",
  "housekeeping/registrations.ts": "hands those sweeps their one method each",
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
        WRITER.test(readFileSync(join(root, rel), "utf8")),
    );
    expect(writers).toEqual(Object.keys(WRITERS).sort());
  });

  it("writes the items table only where a reason is named", () => {
    const writers = sources().filter((rel) =>
      TABLE_WRITE.test(readFileSync(join(root, rel), "utf8")),
    );
    expect(writers).toEqual(Object.keys(TABLE_WRITERS).sort());
  });
});
