/**
 * A database file this build began creating and did not finish.
 *
 * The DDL is a series of statements that are each atomic and together are
 * not, so a start that is stopped partway leaves a file holding the first
 * of this build's objects and not the rest. Such a file holds no rows,
 * because nothing writes one before the DDL is done, and the next start
 * completes it. A file that lacks tables and holds rows was written by
 * another build, and is refused as one.
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
  const dir = mkdtempSync(join(tmpdir(), "marfa-incomplete-"));
  dirs.push(dir);
  return join(dir, "marfa.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * This build's schema up to the start of `table`'s statement: what the file
 * holds when the process stopped between the statement before it and it.
 */
function stoppedBefore(table: string): string {
  const at = SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS \`${table}\` (`);
  if (at < 0) throw new Error(`no ${table} table in the schema`);
  return SCHEMA_SQL.slice(0, at);
}

/** This build's schema without its triggers, which the DDL ends with. */
function stoppedBeforeTriggers(): string {
  const at = SCHEMA_SQL.indexOf("CREATE TRIGGER");
  if (at < 0) throw new Error("no trigger in the schema");
  return SCHEMA_SQL.slice(0, at);
}

async function seed(path: string, sql: string, after = ""): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  await client.executeMultiple(sql);
  if (after !== "") await client.executeMultiple(after);
  client.close();
}

async function objectNames(path: string): Promise<string[]> {
  const client = createClient({ url: `file:${path}` });
  try {
    const rows = await client.execute(
      "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'items_fts_%' ORDER BY name",
    );
    return rows.rows.flatMap((row) =>
      typeof row.name === "string" ? [row.name] : [],
    );
  } finally {
    client.close();
  }
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const ROW =
  "INSERT INTO api_keys (id, key_hash, label, source, type_permissions, created_at) VALUES ('k1', 'h1', 'acme', 'integration:acme/thing', '{}', '2026-01-01T00:00:00.000Z');";

describe("a database this build began creating and did not finish", () => {
  it("is completed when it holds no rows, and ends as a fresh file does", async () => {
    const fresh = scratch();
    await (await createConnection(fresh)).close();

    // The witness that the cut is real: this file lacks tables the fresh
    // one holds.
    const path = scratch();
    await seed(path, stoppedBefore("item_blob_references"));
    expect(await objectNames(path)).not.toEqual(await objectNames(fresh));

    const completed = await createConnection(path);
    await completed.close();
    expect(await objectNames(path)).toEqual(await objectNames(fresh));

    const again = await createConnection(path);
    await again.close();
  });

  it("is completed when only the triggers are missing", async () => {
    const path = scratch();
    await seed(path, stoppedBeforeTriggers());
    const before = await objectNames(path);

    const completed = await createConnection(path);
    await completed.close();
    expect(await objectNames(path)).not.toEqual(before);
    expect(await objectNames(path)).toContain(
      "item_blob_references_insert_lifts_blob_orphans",
    );
  });

  it("is refused as another build's, naming what it lacks and leaving the file, when it holds rows", async () => {
    // Cut at the same place, with a row: it cannot be a first start this
    // build left, and the message must not say that it is.
    const path = scratch();
    await seed(path, stoppedBefore("item_blob_references"), ROW);
    const before = digest(path);

    const refusal = createConnection(path);
    await expect(refusal).rejects.toBeInstanceOf(RefusedDatabaseError);
    await expect(refusal).rejects.toThrow(path);
    await expect(refusal).rejects.toThrow(
      /is not this build's: .*the file lacks the item_blob_references table/,
    );
    await expect(refusal).rejects.not.toThrow(/is incomplete|damaged/);
    await expect(refusal).rejects.toThrow(
      /export it with the build that wrote it/,
    );
    expect(digest(path)).toBe(before);
  });

  it("is refused when an older build finished and filled it and it lacks one table this build added", async () => {
    const path = scratch();
    await seed(
      path,
      SCHEMA_SQL.replace(
        /CREATE TABLE IF NOT EXISTS `extension_blob_references` \([\s\S]*?\);\n/,
        "",
      )
        .split("\n")
        .filter((line) => !line.includes("`extension_blob_references`"))
        .join("\n"),
      ROW,
    );
    expect(await objectNames(path)).not.toContain("extension_blob_references");

    await expect(createConnection(path)).rejects.toThrow(
      /is not this build's: the file lacks the extension_blob_references table/,
    );
  });

  it("is refused as it is today when it also holds a column this build does not declare", async () => {
    const path = scratch();
    await seed(
      path,
      stoppedBefore("item_blob_references").replace(
        "\n\t`client_ip` text,",
        "\n\t`client_ip` text,\n\t`user_agent` text NOT NULL,",
      ),
    );
    const before = digest(path);

    const refusal = createConnection(path);
    await expect(refusal).rejects.toBeInstanceOf(RefusedDatabaseError);
    await expect(refusal).rejects.toThrow(
      /the audit_log table has user_agent, which this build does not declare/,
    );
    expect(digest(path)).toBe(before);
  });

  it("is refused as it is today when it also holds an index this build does not declare", async () => {
    const path = scratch();
    await seed(
      path,
      `${stoppedBefore("item_blob_references")}\nCREATE UNIQUE INDEX idx_audit_log_retired ON audit_log (action);`,
    );
    const before = digest(path);

    await expect(createConnection(path)).rejects.toThrow(
      /idx_audit_log_retired index on the audit_log table this build does not declare/,
    );
    expect(digest(path)).toBe(before);
  });

  it("leaves a table this build does not declare alone while completing", async () => {
    const path = scratch();
    await seed(
      path,
      `${stoppedBefore("item_blob_references")}\nCREATE TABLE _sidecar_seq (id INTEGER PRIMARY KEY, seq INTEGER);`,
      "INSERT INTO _sidecar_seq (seq) VALUES (7);",
    );

    const completed = await createConnection(path);
    await completed.close();
    expect(await objectNames(path)).toContain("item_blob_references");
    const client = createClient({ url: `file:${path}` });
    try {
      const rows = await client.execute("SELECT seq FROM _sidecar_seq");
      expect(rows.rows.map((row) => row.seq)).toEqual([7]);
    } finally {
      client.close();
    }
  });
});
