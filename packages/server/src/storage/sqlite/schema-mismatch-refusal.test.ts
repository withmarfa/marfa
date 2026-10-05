/**
 * A database whose schema is not this build's is refused on open, whatever
 * the difference is.
 *
 * The schema is applied with `CREATE TABLE IF NOT EXISTS`, which does
 * nothing to a table that exists, so a file written by another build opens
 * and fails later: a missing column on the first write that names it, a
 * dropped default or a stale CHECK on the first insert it refuses. Each
 * case here is a file built from this build's schema with one thing
 * changed, so the refusal is about that thing and not the file.
 */
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection, SCHEMA_SQL } from "./connection.js";
import { RefusedDatabaseError } from "./refused-database.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-schema-"));
  dirs.push(dir);
  return join(dir, "marfa.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** This build's schema with `from` replaced by `to` inside one table. */
function schemaWith(table: string, from: string, to: string): string {
  const start = SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS \`${table}\` (`);
  const end = SCHEMA_SQL.indexOf(");", start);
  if (start < 0 || end < 0) throw new Error(`no ${table} table in the schema`);
  const body = SCHEMA_SQL.slice(start, end);
  const changed = body.replace(from, to);
  if (changed === body) throw new Error(`nothing to change in ${table}`);
  return SCHEMA_SQL.slice(0, start) + changed + SCHEMA_SQL.slice(end);
}

async function seed(path: string, sql: string): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  await client.executeMultiple(sql);
  client.close();
}

const A_ROW =
  "\nINSERT INTO api_keys (id, key_hash, label, source, created_at) VALUES ('k1', 'h1', 'acme', 'integration:acme/thing', '2026-01-01T00:00:00.000Z');";

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("a database whose schema is not this build's", () => {
  it("is refused when a table lacks a column, naming it, the file and the remedy", async () => {
    // Nothing indexes `client_ip`, so the DDL passes against this file and
    // the boot would succeed; the first audited write then fails on it.
    const path = scratch();
    await seed(path, schemaWith("audit_log", "\n\t`client_ip` text,", ""));
    const before = digest(path);

    await expect(createConnection(path)).rejects.toThrow(
      /the audit_log table lacks client_ip\./,
    );
    await expect(createConnection(path)).rejects.toThrow(path);
    await expect(createConnection(path)).rejects.toThrow(
      /export it with the build that wrote it.*start this build on a fresh file.*restore the archive there/,
    );
    await expect(createConnection(path)).rejects.toBeInstanceOf(
      RefusedDatabaseError,
    );
    expect(digest(path)).toBe(before);
  });

  it.each([
    ["item_blob_references", "idx_item_blob_references_item"],
    ["edge_blob_references", "idx_edge_blob_references_edge"],
    ["extension_blob_references", "idx_extension_blob_references_item"],
  ])(
    "is refused when it holds rows and lacks %s, naming it",
    async (table, index) => {
      // Created empty by the DDL, a missing index table would describe none of
      // the rows the file already holds.
      const path = scratch();
      const start = SCHEMA_SQL.indexOf(
        `CREATE TABLE IF NOT EXISTS \`${table}\` (`,
      );
      const end = SCHEMA_SQL.indexOf("\n", SCHEMA_SQL.indexOf(index));
      expect(start).toBeGreaterThan(0);
      // Its triggers go with it: SQLite will not create a trigger on a table
      // that is not there.
      // It holds a row, since a file that lacks tables and holds none is
      // one this build began creating, and is completed.
      await seed(
        path,
        (SCHEMA_SQL.slice(0, start) + SCHEMA_SQL.slice(end))
          .split("\n")
          .filter((line) => !line.includes(`ON \`${table}\``))
          .join("\n") + A_ROW,
      );
      const before = digest(path);

      await expect(createConnection(path)).rejects.toThrow(
        new RegExp(`the file lacks the ${table} table`),
      );
      expect(digest(path)).toBe(before);
    },
  );

  it("opens a new file, which holds none of this build's tables", async () => {
    const path = scratch();
    const { close } = await createConnection(path);
    await close();
  });

  it("is refused when a table carries a column this build does not declare", async () => {
    const path = scratch();
    await seed(
      path,
      schemaWith(
        "audit_log",
        "\n\t`client_ip` text,",
        "\n\t`client_ip` text,\n\t`user_agent` text NOT NULL,",
      ),
    );

    await expect(createConnection(path)).rejects.toThrow(
      /the audit_log table has user_agent, which this build does not declare/,
    );
  });

  it("is refused when only a column's definition differs", async () => {
    // Same names, so a check by column name passes it; the first insert that
    // leans on the default then fails on NOT NULL.
    const path = scratch();
    await seed(
      path,
      schemaWith(
        "audit_log",
        "`details` text DEFAULT '{}' NOT NULL",
        "`details` text NOT NULL",
      ),
    );

    await expect(createConnection(path)).rejects.toThrow(
      /the audit_log table differs from this build's definition of it/,
    );
  });

  it("is refused when a declared table carries an index this build does not declare", async () => {
    // A unique index an older build kept would refuse writes this build
    // allows, and `CREATE INDEX IF NOT EXISTS` never sees it.
    const path = scratch();
    await seed(
      path,
      `${SCHEMA_SQL}\nCREATE UNIQUE INDEX idx_audit_log_retired ON audit_log (action);`,
    );

    await expect(createConnection(path)).rejects.toThrow(
      /idx_audit_log_retired index on the audit_log table this build does not declare/,
    );
  });

  it("opens one built from this build's schema, beside a table of its own", async () => {
    // The witness for every case above, and a table this build does not
    // declare is left alone: a replication sidecar keeps its own beside
    // ours.
    const path = scratch();
    await seed(
      path,
      `${SCHEMA_SQL}\nCREATE TABLE _sidecar_seq (id INTEGER PRIMARY KEY, seq INTEGER);`,
    );

    const first = await createConnection(path);
    await first.close();
    const second = await createConnection(path);
    await second.close();
  });
});
