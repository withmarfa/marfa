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
  "\nINSERT INTO api_keys (id, key_hash, label, source, type_permissions, created_at) VALUES ('k1', 'h1', 'acme', 'integration:acme/thing', '{}', '2026-01-01T00:00:00.000Z');";

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

it("refuses a populated registration-owned inbound schema without modifying its file", async () => {
  const path = scratch();
  const old = SCHEMA_SQL.replace(
    /CREATE TABLE IF NOT EXISTS `inbound_sources` \([\s\S]*?CREATE UNIQUE INDEX IF NOT EXISTS `inbound_sources_connector_id_unique`[^;]+;/,
    "",
  )
    .replace(
      /CREATE TABLE IF NOT EXISTS `inbound_endpoints` \([\s\S]*?CREATE UNIQUE INDEX IF NOT EXISTS `idx_inbound_endpoints_id_source`[^;]+;/,
      `
      CREATE TABLE inbound_endpoints (
        id TEXT PRIMARY KEY, connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE, token_last4 TEXT NOT NULL, label TEXT,
        duplicate_header TEXT, created_at TEXT NOT NULL, retired_at TEXT
      );
      CREATE INDEX idx_inbound_endpoints_connector ON inbound_endpoints(connector_id);
    `,
    )
    .replace(
      /(CREATE TABLE IF NOT EXISTS `inbound_deliveries` \([\s\S]*?)`source` text NOT NULL,([\s\S]*?)FOREIGN KEY \(`endpoint_id`,`source`\) REFERENCES `inbound_endpoints`\(`id`,`source`\)/,
      "$1`connector_id` text NOT NULL,$2FOREIGN KEY (`endpoint_id`) REFERENCES `inbound_endpoints`(`id`)",
    )
    .replace(
      "idx_inbound_deliveries_source_handled",
      "idx_inbound_deliveries_connector_handled",
    )
    .replace(
      "ON `inbound_deliveries` (`source`,",
      "ON `inbound_deliveries` (`connector_id`,",
    );
  expect(old).not.toContain("CREATE TABLE IF NOT EXISTS `inbound_sources`");
  await seed(
    path,
    old +
      A_ROW +
      `
    INSERT INTO connectors(id,key_id,source,name,registered_at,updated_at)
      VALUES ('c','k1','integration:acme/thing','Reader','2026-01-01','2026-01-01');
    INSERT INTO inbound_endpoints(id,connector_id,token_hash,token_last4,created_at)
      VALUES ('e','c','hash','last','2026-01-01');
    INSERT INTO inbound_deliveries(id,endpoint_id,connector_id,received_at,method,query,headers,size,stored_bytes,sha256)
      VALUES ('d','e','c','2026-01-01','POST','','[]',3,100,'hash');
    INSERT INTO inbound_delivery_bodies(delivery_id,body) VALUES ('d',X'00ff80');
  `,
  );
  const before = digest(path);
  await expect(createConnection(path)).rejects.toBeInstanceOf(
    RefusedDatabaseError,
  );
  expect(digest(path)).toBe(before);
});

it("refuses a database without the durable trash actor without changing it", async () => {
  const path = scratch();
  await seed(path, schemaWith("items", "\n\t`trashed_by` text,", "") + A_ROW);
  const before = digest(path);
  await expect(createConnection(path)).rejects.toThrow(
    /the items table lacks trashed_by/,
  );
  expect(digest(path)).toBe(before);
});
