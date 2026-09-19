/**
 * An index predating the schema is refused on open, and nothing else is.
 *
 * This replaced a rebuild — drop the virtual table, re-index every row — and
 * the refusal is worth a test for the reason the rebuild was not: it is on
 * the open path, so getting it wrong does not degrade the server, it stops
 * it starting. Three cases, and the middle one is the one a careless probe
 * fails: a database that is merely unreadable this second must not be
 * reported as one whose schema has aged out, because those have opposite
 * remedies and only one of them destroys data.
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
    // The shape the rebuild used to repair: an `items_fts` with no `tags`.
    // `IF NOT EXISTS` means the real schema leaves it alone, so the probe is
    // the only thing between this database and a silently partial search.
    //
    // Any `items_fts` missing the column reads as stale here, whether it is
    // genuinely an older index or a table that merely shares the name. That
    // is the right collapse: the remedy is the same for both, because
    // neither can serve the searches this build makes.
    const seed = createClient({ url: `file:${path}` });
    await seed.executeMultiple(
      `CREATE VIRTUAL TABLE items_fts USING fts5(
         item_id, title, body, description, name, extra,
         tokenize='porter unicode61'
       );`,
    );
    seed.close();

    await expect(createConnection(path)).rejects.toThrow(
      /predates the current schema/,
    );
    await expect(createConnection(path)).rejects.toThrow(path);
  });

  it("does not report an unreadable file as a stale index", async () => {
    // Corruption is the failure that must not wear the staleness message,
    // because the two remedies differ and only one of them discards data.
    // This one is refused before the probe is even reached, which is the
    // right order: a file that is not a database has nothing to probe.
    const path = scratch();
    writeFileSync(path, "this is not a database");

    await expect(createConnection(path)).rejects.toThrow();
    await expect(createConnection(path)).rejects.not.toThrow(
      /predates the current schema/,
    );
  });
});
