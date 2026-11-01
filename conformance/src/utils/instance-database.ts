import { DatabaseSync } from "node:sqlite";

/** How long a write waits for the server's own, which holds the lock briefly. */
const BUSY_WAIT_MS = 10_000;

/**
 * Runs `use` against the SQLite file of a server of the fixture's own, and
 * closes it.
 *
 * For arranging what no door will: a record left as a writer that died would
 * leave it, or a table gone. The
 * fixture then asks over HTTP, so what is asserted is still what the server
 * answers. Never for the run's shared server, whose rows other files hold.
 */
export function withInstanceDatabase<T>(
  sqlitePath: string,
  use: (db: DatabaseSync) => T,
): T {
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${String(BUSY_WAIT_MS)}`);
    return use(db);
  } finally {
    db.close();
  }
}

/**
 * Takes `last_used_at` off `auth_passkey`, as builds before schema version 8
 * wrote it, keeping every row. `ALTER TABLE ... DROP COLUMN` would leave table
 * text the server's shape check refuses, so the table is rebuilt from its own
 * definition without that column.
 */
export function passkeysBeforeLastUse(db: DatabaseSync): void {
  const { sql } = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'auth_passkey'",
    )
    .get() as { sql: string };
  const without = sql
    .split("\n")
    .filter((line) => !line.includes("`last_used_at`"))
    .join("\n");
  const columns = (
    db.prepare("PRAGMA table_info(auth_passkey)").all() as { name: string }[]
  )
    .map((column) => column.name)
    .filter((name) => name !== "last_used_at")
    .map((name) => `\`${name}\``)
    .join(", ");
  db.exec(
    `CREATE TABLE auth_passkey_was AS SELECT ${columns} FROM auth_passkey ORDER BY rowid;
DROP TABLE auth_passkey;
${without};
INSERT INTO auth_passkey (${columns}) SELECT ${columns} FROM auth_passkey_was;
DROP TABLE auth_passkey_was;
CREATE INDEX \`idx_auth_passkey_user_id\` ON \`auth_passkey\` (\`user_id\`);
CREATE INDEX \`idx_auth_passkey_credential_id\` ON \`auth_passkey\` (\`credential_id\`);`,
  );
}
