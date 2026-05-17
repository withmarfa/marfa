/**
 * Per-file template database lifecycle for PG tests.
 *
 * Replaces the shared-DB + truncate-on-setup pattern. Each test file
 * clones a pre-built template database, runs against the clone, and
 * drops it on teardown. Parallel-safe, no truncate races, no leaked
 * session state across files.
 *
 * Lifecycle:
 *   - Test-run start (vitest globalSetup): drop any leftover clones
 *     from a crashed prior run, rebuild the template (DROP + CREATE +
 *     migrate).
 *   - Per test file (createPgTestStorage / createTestContext):
 *     CREATE DATABASE <unique> TEMPLATE myme_test_template, return the
 *     connection URL + a drop callback.
 *   - Per-file teardown: the cleanup callback closes the storage pool
 *     and drops the clone with WITH (FORCE) so any lingering connections
 *     are terminated.
 *   - Test-run end (globalTeardown): drop the template.
 *
 * Constraints from PG 17 (verified against current docs):
 *   - CREATE DATABASE ... TEMPLATE requires the template to have no
 *     active connections at the moment of CREATE. The template is built
 *     once at run start and never connected to afterwards — clones read
 *     the template's filesystem state, no live connection needed.
 *   - DROP DATABASE ... WITH (FORCE) (PG 13+) terminates active
 *     connections to the target database before dropping. We use it
 *     unconditionally so a leaked pool connection can't block teardown.
 *   - CREATE/DROP DATABASE cannot run inside a transaction block.
 *
 * The role + grants set up by migrations 0035 / 0037 / 0040 (myme_app)
 * are CLUSTER-scoped, not database-scoped. The first migration run
 * against the template creates the role; clones inherit the grants
 * automatically.
 */

import postgres from "postgres";
import { runPgMigrations } from "../migrate.js";

/** Name of the persistent template database. Built once per test run. */
export const TEMPLATE_DB_NAME = "myme_test_template";

/** Prefix for per-file clone databases. */
const CLONE_PREFIX = "myme_test_clone_";

/**
 * Substitute the database segment of a Postgres connection URL.
 * Used to derive admin / template / per-clone URLs from one base.
 */
export function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * The admin connection URL — points at a database that's always
 * available (`postgres` by convention) so we can CREATE / DROP arbitrary
 * databases on the cluster.
 *
 * Reads MYME_TEST_PG_ADMIN_URL when set (test-pg.sh exports it). When
 * unset, derives it by swapping the DATABASE_URL's database segment to
 * `postgres`. Fails loud if neither is set — there's no reasonable
 * default for a test admin URL.
 */
export function getAdminUrl(): string {
  const explicit = process.env.MYME_TEST_PG_ADMIN_URL;
  if (explicit) return explicit;
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "PG test lifecycle requires MYME_TEST_PG_ADMIN_URL or DATABASE_URL to be set. Invoke via `pnpm test:pg` which sets both.",
    );
  }
  return withDatabase(base, "postgres");
}

/**
 * Drop any leftover per-file test databases from prior runs. Idempotent.
 * Called by the global setup before rebuilding the template — without
 * this, a crashed prior run can leave hundreds of orphan clones.
 */
async function dropStaleClones(adminUrl: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1 });
  try {
    const rows = await sql<{ datname: string }[]>`
      SELECT datname FROM pg_database
      WHERE datname LIKE ${CLONE_PREFIX + "%"}
    `;
    for (const row of rows) {
      // Identifier is system-generated (LIKE-matched against our own
      // prefix), so it's safe to interpolate. DROP DATABASE doesn't
      // accept parameterised names.
      await sql.unsafe(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
    }
  } finally {
    await sql.end();
  }
}

/**
 * Build the template database. Idempotent across runs: drops any
 * existing template + clones first, then creates a fresh empty database
 * and runs migrations into it.
 *
 * Returns the template URL for callers that want to inspect it; ordinary
 * test setup doesn't need it.
 */
export async function buildTemplate(): Promise<string> {
  const adminUrl = getAdminUrl();
  await dropStaleClones(adminUrl);

  const sql = postgres(adminUrl, { max: 1 });
  try {
    await sql.unsafe(
      `DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}" WITH (FORCE)`,
    );
    await sql.unsafe(`CREATE DATABASE "${TEMPLATE_DB_NAME}"`);
  } finally {
    await sql.end();
  }

  const templateUrl = withDatabase(adminUrl, TEMPLATE_DB_NAME);
  await runPgMigrations(templateUrl);
  return templateUrl;
}

/**
 * Drop the template database. Called by global teardown at test-run end.
 * Idempotent; safe to call when no template exists.
 */
export async function dropTemplate(): Promise<void> {
  const adminUrl = getAdminUrl();
  const sql = postgres(adminUrl, { max: 1 });
  try {
    await sql.unsafe(
      `DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}" WITH (FORCE)`,
    );
  } finally {
    await sql.end();
  }
}

/** Per-clone handle returned by {@link cloneTemplate}. */
export interface PgTemplateClone {
  /** Connection URL pointing at the newly-created clone database. */
  url: string;
  /** The clone's database name. Useful for debugging. */
  dbName: string;
  /** Drop the clone. Idempotent; best-effort (errors are swallowed
   *  so a partial teardown doesn't break the test). */
  drop: () => Promise<void>;
}

/**
 * Clone the template into a uniquely-named database. Returns the
 * connection URL the test should pass to `createPgStorage`, plus the
 * `drop` callback the cleanup path must invoke.
 *
 * `CREATE DATABASE ... TEMPLATE` is fast (file-copy at the FS level —
 * typically 50-200ms for ~30 tables) and serialises briefly per
 * template, so concurrent clones across worker files don't race; PG
 * handles the serialisation internally.
 */
export async function cloneTemplate(): Promise<PgTemplateClone> {
  const adminUrl = getAdminUrl();
  const suffix = Math.random().toString(36).slice(2, 14);
  const dbName = `${CLONE_PREFIX}${suffix}`;

  const sql = postgres(adminUrl, { max: 1 });
  // CREATE DATABASE FROM TEMPLATE serialises briefly per template inside
  // PG. Under parallel test execution multiple workers can race; if PG
  // raises 55006 (object_in_use — "source database is being accessed by
  // other users") we retry with a small backoff. The lock releases after
  // each in-flight CREATE completes so retries succeed quickly.
  //
  // Matching on the SQLSTATE code rather than the error message string —
  // codes are part of the SQL standard and stable across PG versions;
  // messages aren't.
  try {
    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await sql.unsafe(
          `CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB_NAME}"`,
        );
        break;
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        const transient = code === "55006";
        if (!transient || attempt === maxAttempts) {
          throw err;
        }
        // Backoff: 25ms × attempt (25, 50, 75, ... up to 200ms total).
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  } finally {
    await sql.end();
  }

  return {
    url: withDatabase(adminUrl, dbName),
    dbName,
    drop: async () => {
      const dropSql = postgres(adminUrl, { max: 1 });
      try {
        await dropSql.unsafe(
          `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`,
        );
      } catch {
        // Best-effort. If the drop fails (cluster transient, lock
        // contention), the next test-run's dropStaleClones pass will
        // mop up the orphan. Test correctness is not affected.
      } finally {
        await dropSql.end();
      }
    },
  };
}
