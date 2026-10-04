/**
 * The writer `backup-copy.test.ts` copies the directory of: a separate
 * process, so a copy overlaps its commits and checkpoints for real, opened
 * through the server's own connection and so with its own settings.
 *
 * Takes the data directory, resumes counting from what the database already
 * holds, and prints each number once its insert has committed. A number
 * printed is a write acknowledged.
 */
import { createConnection } from "./connection.js";

const directory = process.argv[2];
if (directory === undefined) throw new Error("usage: backup-writer <dir>");

const { raw } = await createConnection(`${directory}/marfa.db`);
await raw.execute(
  "CREATE TABLE IF NOT EXISTS probe (n INTEGER PRIMARY KEY, pad TEXT NOT NULL)",
);
const last = await raw.execute("SELECT coalesce(max(n), 0) AS n FROM probe");
let n = Number(last.rows[0]?.n ?? 0);

// A row fills about a page, so the automatic checkpoint, and with it the
// reset of the log, comes round every few hundred writes.
const pad = "x".repeat(3000);
for (;;) {
  n += 1;
  await raw.execute({
    sql: "INSERT INTO probe (n, pad) VALUES (?, ?)",
    args: [n, pad],
  });
  process.stdout.write(`${String(n)}\n`);
}
