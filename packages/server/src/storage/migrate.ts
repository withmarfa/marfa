/**
 * Create or refresh the schema at `SQLITE_PATH` and exit.
 *
 * `createConnection` applies `schema.sql` at every open, so this is the
 * same thing the server does at boot, without the server.
 *
 * Usage: tsx src/storage/migrate.ts, or node dist/migrate.js
 */
import { loadConfig } from "../config.js";
import { createConnection } from "./sqlite/connection.js";

try {
  const { sqlitePath } = loadConfig();
  console.log(`Applying the schema to ${sqlitePath}...`);
  const { close } = await createConnection(sqlitePath);
  await close();
  console.log("Schema applied.");
  process.exit(0);
} catch (err) {
  console.error("Schema apply failed:", err);
  process.exit(1);
}
