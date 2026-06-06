import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { stampPgDrizzleMigrations } from "../bootstrap-stamp.js";
import { wrapDbWithRequestContext } from "./request-context.js";
import { SCHEMA_SQL } from "./schema-sql.generated.js";

export type PgDb = ReturnType<typeof drizzle<typeof schema>>;
export type PgClient = ReturnType<typeof postgres>;

// SCHEMA_SQL is auto-generated from drizzle/pg/ migrations by
// scripts/generate-schema-sql.ts. Imported above.

export async function createConnection(
  connectionString: string,
  options?: {
    /** Override the postgres-js pool size. Defaults to 10 — the
     *  production default. Tests pass a small value (3) so parallel
     *  test files don't exhaust PG's cluster-wide `max_connections`
     *  (default 100). */
    maxPoolSize?: number;
    /** Skip the bootstrap `SCHEMA_SQL` + migration-journal stamp.
     *  Tests against a database cloned from a pre-built template
     *  (`createPgTestStorage`) already have the schema applied; running
     *  SCHEMA_SQL again is idempotent but takes hundreds of milliseconds
     *  per storage instance and serialises across two storages on the
     *  same DB via the advisory lock — meaningful overhead at scale.
     *  Defaults to false (production behaviour preserved). */
    skipBootstrap?: boolean;
  },
): Promise<{
  /**
   * Drizzle instance wrapped with the per-request context proxy.
   * Storage classes consume this so per-request transactions (set up
   * by the RLS middleware) transparently substitute. Use for everything
   * except Better Auth.
   */
  db: PgDb;
  /**
   * Unwrapped base Drizzle instance — bypasses the per-request
   * context. Reserved for Better Auth, which manages its own
   * connection / cookie context outside the data-plane request
   * middleware. Auth tables (`auth_*`) have no RLS policies and
   * always operate as the connection owner.
   */
  baseDb: PgDb;
  client: PgClient;
  close: () => Promise<void>;
}> {
  const client = postgres(connectionString, {
    max: options?.maxPoolSize ?? 10,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onnotice: () => {},
  });
  const baseDb = drizzle(client, { schema });
  const db = wrapDbWithRequestContext(baseDb);

  // Apply schema — use advisory lock to prevent concurrent DDL race conditions.
  //
  // SCHEMA_SQL is auto-generated from the Drizzle migrations under
  // drizzle/pg/ by scripts/generate-schema-sql.ts. It's the fresh-database
  // bootstrap path used when the server starts against an empty database.
  // Schema changes go through a Drizzle migration; the SCHEMA_SQL refresh
  // runs automatically as a post-step of `pnpm migrate:pg:generate`.
  //
  // The FTS5 virtual table in sqlite/connection.ts remains inline because
  // Drizzle Kit cannot express it; it has no equivalent here.
  //
  // RLS — the per-table `marfa_app` role + CRUD grants + tenant-isolation
  // policies are part of SCHEMA_SQL. Activation is gated by
  // `MARFA_RLS_ENFORCE=true`, wired via the per-request context proxy +
  // `rls-tenant-context.ts` middleware. With the flag unset (the default)
  // all queries fall through to the unwrapped base instance and run as the
  // connection owner — RLS bypassed by virtue of ownership. Single-tenant
  // self-hosts are unaffected.
  if (!options?.skipBootstrap) {
    await client.unsafe(`SELECT pg_advisory_lock(42)`);
    try {
      await client.unsafe(SCHEMA_SQL);
      // Stamp Drizzle's `__drizzle_migrations` table so a follow-up
      // `pnpm migrate` against this bootstrapped DB short-circuits as a
      // no-op. Idempotent — only stamps when the table is empty.
      await stampPgDrizzleMigrations(client);
    } finally {
      await client.unsafe(`SELECT pg_advisory_unlock(42)`);
    }
  }

  return {
    db,
    baseDb,
    client,
    close: async () => {
      await client.end();
    },
  };
}
