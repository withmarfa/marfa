/**
 * A database whose `versions` table predates the `type` column is refused
 * on open, naming the table, the column and the file.
 *
 * The schema is applied with `CREATE TABLE IF NOT EXISTS`, which does
 * nothing to a table that exists, so without the refusal such a file opens
 * and every write that takes a version step then fails on the snapshot's
 * insert, with a driver error naming a column the operator never heard of.
 * `REQUIRED_COLUMNS` in `connection.ts` is where an added column is named
 * for this, and this holds it there.
 */
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection, SCHEMA_SQL } from "./connection.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-versions-type-"));
  dirs.push(dir);
  return join(dir, "marfa.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** This build's schema with the `type` column struck from `versions`: the
 *  table as a build before this one wrote it. */
function schemaWithoutVersionsType(): string {
  const start = SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS `versions` (");
  const end = SCHEMA_SQL.indexOf(");", start);
  if (start < 0 || end < 0) {
    throw new Error("the versions table was not found in the schema");
  }
  const table = SCHEMA_SQL.slice(start, end);
  const struck = table.replace("\n\t`type` text NOT NULL,", "");
  if (struck === table) {
    throw new Error("the versions table's type column was not found to strike");
  }
  return SCHEMA_SQL.slice(0, start) + struck + SCHEMA_SQL.slice(end);
}

describe("a versions table without the type column", () => {
  it("is refused on open, naming the table, the column and the file", async () => {
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.executeMultiple(schemaWithoutVersionsType());
    seed.close();

    await expect(createConnection(path)).rejects.toThrow(/versions table/);
    await expect(createConnection(path)).rejects.toThrow(/no type column/);
    await expect(createConnection(path)).rejects.toThrow(path);
  });

  it("opens a database built from this build's schema", async () => {
    // The witness: the same file with the column present is accepted, so
    // the refusal above is about the column and not the file.
    const path = scratch();
    const seed = createClient({ url: `file:${path}` });
    await seed.executeMultiple(SCHEMA_SQL);
    seed.close();

    const connection = await createConnection(path);
    await connection.close();
  });
});
