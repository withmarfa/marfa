/**
 * The writer `backup-copy.test.ts` copies the directory of: a separate
 * process, so a copy overlaps its commits and checkpoints for real, opened
 * through the server's own connection and so with its own settings.
 *
 * Takes the data directory, resumes counting from what the database already
 * holds, and prints each number once its insert has committed. A number
 * printed is a write acknowledged. After the first write, stdin supplies
 * one batch size per line, so slow copying cannot grow the fixture forever.
 */
import { createInterface } from "node:readline";
import { createConnection } from "./connection.js";

const directory = process.argv[2];
if (directory === undefined) throw new Error("usage: backup-writer <dir>");

const batches = createInterface({ input: process.stdin });
const { raw, close } = await createConnection(`${directory}/marfa.db`);
await raw.execute(
  "CREATE TABLE IF NOT EXISTS probe (n INTEGER PRIMARY KEY, pad TEXT NOT NULL)",
);
const last = await raw.execute("SELECT coalesce(max(n), 0) AS n FROM probe");
let n = Number(last.rows[0]?.n ?? 0);

// A row fills about a page, so the automatic checkpoint, and with it the
// reset of the log, comes round every few hundred writes.
const pad = "x".repeat(3000);
async function write(): Promise<void> {
  n += 1;
  await raw.execute({
    sql: "INSERT INTO probe (n, pad) VALUES (?, ?)",
    args: [n, pad],
  });
  process.stdout.write(`${String(n)}\n`);
}

try {
  await write();
  for await (const line of batches) {
    const count = Number(line);
    if (!Number.isSafeInteger(count) || count < 1 || count > 500) {
      throw new Error("a write batch must contain 1 to 500 rows");
    }
    for (let i = 0; i < count; i += 1) await write();
  }
} finally {
  await close();
}
