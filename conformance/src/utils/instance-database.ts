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
 * Writes or removes one row of the settings table as a hand edit would,
 * bounds unchecked, so a fixture can leave a stored setting that does not read.
 */
export function storeSettingRow(
  sqlitePath: string,
  key: string,
  value: string | null,
): void {
  withInstanceDatabase(sqlitePath, (db) => {
    if (value === null) {
      db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    } else {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
    }
  });
}
