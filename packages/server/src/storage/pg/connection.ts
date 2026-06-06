import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { stampPgDrizzleMigrations } from "../bootstrap-stamp.js";
import { wrapDbWithRequestContext } from "./request-context.js";
import { SCHEMA_SQL } from "./schema-sql.generated.js";

export type PgDb = ReturnType<typeof drizzle<typeof schema>>;
export type PgClient = ReturnType<typeof postgres>;

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

  // Apply schema under an advisory lock to prevent concurrent DDL races.
  // SCHEMA_SQL is the fresh-database bootstrap path, auto-generated from
  // drizzle/pg/ migrations by scripts/generate-schema-sql.ts. RLS role +
  // policies are included; activation requires MARFA_RLS_ENFORCE=true.
  if (!options?.skipBootstrap) {
    await client.unsafe(`SELECT pg_advisory_lock(42)`);
    try {
      await client.unsafe(SCHEMA_SQL);
      // Stamp __drizzle_migrations so a follow-up `pnpm migrate` short-circuits. Idempotent.
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
