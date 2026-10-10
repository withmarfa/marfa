/**
 * A full-text index of another shape is refused on open, and nothing else
 * is.
 *
 * The refusal is on the open path, so getting it wrong does not degrade the
 * server, it stops it starting. A database that is merely unreadable this
 * second must not be reported as one whose schema is not this build's,
 * because those have opposite remedies and only one of them destroys data.
 */
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection } from "./connection.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-fts-"));
  dirs.push(dir);
  return join(dir, "marfa.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("the full-text index is refused when it predates the schema", () => {
  it("opens a fresh database, where the table is created before it is probed", async () => {
    const { close } = await createConnection(scratch());
    await close();
  });

  it("opens a database it has already opened", async () => {
    const path = scratch();
    const first = await createConnection(path);
    await first.close();
    const second = await createConnection(path);
    await second.close();
  });

  it("refuses an index built before the newest column, naming the file", async () => {
    const path = scratch();
    // An `items_fts` with no `tags`. `IF NOT EXISTS` means the real schema
    // leaves it alone, so the refusal is the only thing between this
    // database and a silently partial search.
    const seed = createClient({ url: `file:${path}` });
    await seed.executeMultiple(
      `CREATE VIRTUAL TABLE items_fts USING fts5(
         item_id, title, body, description, name, extra,
         tokenize='porter unicode61'
       );`,
    );
    seed.close();

    await expect(createConnection(path)).rejects.toThrow(
      /the items_fts table lacks tags/,
    );
    await expect(createConnection(path)).rejects.toThrow(path);
  });

  it("does not report an unreadable file as a stale index", async () => {
    // Corruption is the failure that must not wear the schema message,
    // because the two remedies differ and only one of them discards data.
    const path = scratch();
    writeFileSync(path, "this is not a database");

    await expect(createConnection(path)).rejects.toThrow();
    await expect(createConnection(path)).rejects.not.toThrow(
      /is not this build's/,
    );
  });

  it("refuses the searchable item-ID shape without rebuilding it", async () => {
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.execute(
      "CREATE VIRTUAL TABLE items_fts USING fts5(item_id, title, body, description, name, extra, tags, tokenize='porter unicode61')",
    );
    seed.close();
    await expect(createConnection(path)).rejects.toThrow(
      /items_fts table has item_id/,
    );
    const untouched = createClient({ url: `file:${path}` });
    try {
      const columns = await untouched.execute("PRAGMA table_info(items_fts)");
      expect(columns.rows.map((row) => row.name)).toContain("item_id");
      const map = await untouched.execute(
        "SELECT name FROM sqlite_master WHERE name = 'item_search_keys'",
      );
      expect(map.rows).toEqual([]);
    } finally {
      untouched.close();
    }
  });

  it("refuses a populated schema with its stable-key table missing", async () => {
    const path = scratch();
    const first = await createConnection(path);
    await first.raw.execute(
      "INSERT INTO api_keys (id, key_hash, label, source, type_permissions, created_at) VALUES ('k1', 'h1', 'acme', 'integration:acme/thing', '{}', '2026-01-01T00:00:00.000Z')",
    );
    await first.raw.execute("DROP TABLE item_search_keys");
    await first.close();
    await expect(createConnection(path)).rejects.toThrow(
      /file lacks the item_search_keys table/,
    );
  });
});
