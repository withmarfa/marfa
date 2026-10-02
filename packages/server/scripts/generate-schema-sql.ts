/**
 * Regenerate `src/storage/sqlite/schema.sql` from `schema.ts`.
 *
 * `schema.sql` is the whole of the database's DDL. `createConnection` applies
 * it at every open, `IF NOT EXISTS` throughout, so a fresh path gets the
 * schema and an existing one is left alone. The declarations in `schema.ts`
 * are the source: drizzle-kit renders them, and this script makes the result
 * idempotent and writes it beside them. `schema-sql.test.ts` holds the two in
 * step by introspecting a database built from the file against the
 * declarations, so a `schema.ts` change that forgets to run this fails there.
 *
 * Usage:
 *   pnpm --filter @withmarfa/server schema-sql:generate
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOB_REFERENCE_TRIGGERS } from "../src/storage/sqlite/schema.js";

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_TS = "src/storage/sqlite/schema.ts";
const SCHEMA_SQL = join(SERVER_ROOT, "src/storage/sqlite/schema.sql");

const HEADER = `-- Generated from ${SCHEMA_TS} by scripts/generate-schema-sql.ts; do not edit.
-- Regenerate with: pnpm --filter @withmarfa/server schema-sql:generate
--
-- Applied in full at every database open. Every statement is idempotent, so
-- an existing database is left as it is. The FTS5 virtual table lives in
-- sqlite/connection.ts, which drizzle-kit cannot express; the triggers at
-- the end are declared as SQL in schema.ts for the same reason.

`;

const rendered = execFileSync(
  "pnpm",
  [
    "exec",
    "drizzle-kit",
    "export",
    "--dialect",
    "sqlite",
    "--schema",
    SCHEMA_TS,
  ],
  { cwd: SERVER_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);

const idempotent = rendered
  .replace(/^CREATE TABLE /gm, "CREATE TABLE IF NOT EXISTS ")
  .replace(/^CREATE (UNIQUE )?INDEX /gm, "CREATE $1INDEX IF NOT EXISTS ");

const triggers = BLOB_REFERENCE_TRIGGERS.join("\n");

writeFileSync(
  SCHEMA_SQL,
  HEADER + idempotent.trimEnd() + "\n\n" + triggers + "\n",
);
process.stderr.write(`wrote ${SCHEMA_SQL}\n`);
