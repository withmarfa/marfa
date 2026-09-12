/**
 * The single command a hosted deployment runs between build and release.
 *
 * It applies the Postgres migrations and then seeds the fixed first-party
 * OAuth clients, in that order, in one process.
 *
 * **Why one entry rather than two commands.** Railway's pre-deploy command is
 * executed rather than interpreted by a shell, so `a && b` does not chain:
 * everything after the first word is passed to the first program as
 * arguments. `node dist/migrate.js --dialect pg && node dist/seed-oauth-clients.js`
 * therefore runs the migrations, hands the rest to the migrator, which ignores
 * what it does not recognise, and exits 0 having seeded nothing. That failure
 * is silent in the worst way: the deploy is green, the API is healthy, and the
 * only symptom is that signing in from a browser app fails with
 * `invalid_client`, which reads as a problem with the app rather than the
 * deployment.
 *
 * **Why the seeding has to be part of every deploy rather than a reseed step.**
 * The browser apps use fixed client ids precisely so that a database reset
 * cannot orphan them, but that only holds if something re-creates the rows.
 * A step somebody has to remember after a reset is a step that gets missed;
 * this one was, on 12 September 2026, and hosted sign-in was broken until it
 * was noticed by hand. Seeding is idempotent, so running it on every deploy
 * costs a query and removes the chance of forgetting.
 *
 * The dialect is explicit and load-bearing: the migrator falls back to SQLite
 * when `DB_DIALECT` is absent or misspelled, which would print
 * `Migrations complete.` having applied nothing to Postgres.
 */
import { runPgMigrations } from "../storage/migrate.js";
import { seedFirstPartyClients } from "./seed-oauth-clients.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required for the pre-deploy step.");
    process.exit(1);
  }

  console.log("Running pg migrations...");
  await runPgMigrations(url);
  console.log("Migrations complete.");

  console.log("Seeding first-party OAuth clients...");
  await seedFirstPartyClients();
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("Pre-deploy failed:", err);
    process.exit(1);
  });
