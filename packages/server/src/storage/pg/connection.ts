import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { DbPoolMode } from "../../config.js";
import { stampPgDrizzleMigrations } from "../bootstrap-stamp.js";
import { wrapDbWithRequestContext } from "./request-context.js";
import { SCHEMA_SQL } from "./schema-sql.generated.js";

export type PgDb = ReturnType<typeof drizzle<typeof schema>>;
export type PgClient = ReturnType<typeof postgres>;

/**
 * Host of a Postgres URL, for logging. Never the whole connection string —
 * that carries the password. Returns `"unknown"` rather than throwing, since
 * a log line is not worth failing a boot over.
 */
export function pgEndpointHost(connectionString: string): string {
  try {
    return new URL(connectionString).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

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
     *  per storage instance and serializes across two storages on the
     *  same DB via the advisory lock — meaningful overhead at scale.
     *  Defaults to false (production behavior preserved). */
    skipBootstrap?: boolean;
    /**
     * Direct (session-mode) connection string used ONLY for streaming RLS
     * reservations. Streaming issues a SESSION-level `SET ROLE marfa_app`;
     * over a transaction-mode pooler (Neon's pooled endpoint — the app's
     * `DATABASE_URL`) that role strands on a shared PgBouncer backend and is
     * inherited by a later, unrelated query, which then hits RLS as the
     * restricted role. Pointing streaming at the direct, unpooled endpoint
     * keeps the reserve → SET ROLE → reset cycle 1:1 with a real backend, so
     * nothing strands on the app pool.
     *
     * Required when `poolMode` is `transaction`; optional otherwise, and
     * streaming then reuses the main client.
     */
    directConnectionString?: string;
    /**
     * What kind of endpoint `connectionString` points at. Defaults to
     * `session` — a direct Postgres connection, where streaming can safely
     * share the main client. See `DbPoolMode`.
     */
    poolMode?: DbPoolMode;
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
  /**
   * Dedicated client for streaming RLS reservations. A separate small pool
   * on the direct (session-mode) endpoint when `directConnectionString` is
   * set; otherwise the same `client`. Only `acquireStreamRls` reserves from
   * it — never the data plane or Better Auth.
   */
  streamClient: PgClient;
  close: () => Promise<void>;
}> {
  const directConnectionString = options?.directConnectionString?.trim() ?? "";

  // Fail closed before opening anything. On a transaction-mode pooler,
  // "no direct endpoint" cannot mean "share the pooled client": streaming's
  // session-level SET ROLE would strand on a shared backend and be inherited
  // by unrelated queries across the whole instance. Silently disabling
  // streaming RLS instead would trade a loud failure for a quiet loss of
  // tenant isolation, so neither fallback is acceptable.
  if (options?.poolMode === "transaction" && directConnectionString === "") {
    throw new Error(
      "MARFA_DATABASE_URL_DIRECT is required when MARFA_DB_POOL_MODE=transaction. " +
        "Streaming RLS must reserve from a direct (unpooled) endpoint, not the " +
        "transaction-mode pooled one DATABASE_URL points at.",
    );
  }

  const client = postgres(connectionString, {
    max: options?.maxPoolSize ?? 10,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onnotice: () => {},
  });
  // Dedicated streaming client on the direct (session-mode) endpoint, when
  // configured, so streaming's session-level `SET ROLE` never strands on the
  // app's transaction-mode pooled connections (see `directConnectionString`).
  const streamClient = directConnectionString
    ? postgres(directConnectionString, {
        // One slot per concurrent stream; streams are far rarer than
        // data-plane requests and the direct endpoint has a tighter
        // connection ceiling than the pooler.
        max: Math.min(options?.maxPoolSize ?? 10, 5),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        onnotice: () => {},
      })
    : client;
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
    streamClient,
    close: async () => {
      await client.end();
      if (streamClient !== client) {
        await streamClient.end();
      }
    },
  };
}
