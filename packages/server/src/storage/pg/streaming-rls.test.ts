/**
 * T-189 regression — the streaming-RLS cleanup must scope its reset
 * to the role + tenant GUC only, NOT use `DISCARD ALL`.
 *
 * Pre-fix the cleanup ran `DISCARD ALL` on stream release. That
 * deallocated every server-side prepared statement on the recycled
 * connection. postgres.js retains a client-side `statements` cache
 * keyed per physical connection, so the next query that bound to a
 * cached statement name would surface `prepared statement "<name>"
 * does not exist` (SQLSTATE 26000). postgres.js does auto-retry on
 * the `FetchPreparedStatement` routine, but under concurrent SSE +
 * writes the retry window races against in-flight pipelined queries
 * — the QA Session 1 reproduction observed ~20% POST /items 500s.
 *
 * The fix scopes the reset to exactly what the cleanup invariant
 * requires:
 *
 *   - `RESET ROLE` — drop the `myme_app` elevation.
 *   - `set_config('marfa.tenant_id', '', false)` — clear the GUC the
 *     RLS policies read.
 *
 * Prepared statements survive untouched. RLS policies consult
 * `current_setting('marfa.tenant_id')` at execute time, so a
 * statement compiled while the GUC held tenant A executes safely
 * once the GUC flips to tenant B (or clears) — the cache is value-
 * agnostic with respect to tenant context.
 *
 * Two assertions land below:
 *
 *   1. **Server-side prepared statements survive release.** A
 *      session-level prepared statement created before the streaming
 *      reservation must still exist after `ctx.release()`. Under
 *      `DISCARD ALL` it would be deallocated; under the scoped reset
 *      it persists. This is the direct lock-in against a revert.
 *   2. **Role + tenant GUC are cleared on release.** The cleanup
 *      invariant must still hold — a connection returned to the pool
 *      cannot carry the `myme_app` role or a leaked `marfa.tenant_id`.
 *
 * Postgres-only — RLS is a PG feature.
 */

import { describe, it, expect } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { acquireStreamRls } from "./streaming-rls.js";

const isPg = process.env.STORAGE_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!isPg || !url)("streaming-rls cleanup (T-189)", () => {
  it("preserves server-side prepared statements across release (no DISCARD ALL)", async () => {
    // max: 1 ensures the streaming `reserve()` and the post-release
    // queries land on the same physical connection — deterministic
    // reproduction of the recycled-connection path.
    const client = postgres(url, {
      max: 1,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      onnotice: () => {},
    });
    const stmtName = `myme_t189_test_${Math.random().toString(36).slice(2, 10)}`;
    const tenantId = "t-189-cache-test";
    try {
      // Create a session-level prepared statement directly. PREPARE
      // is server-side; the statement lives until DEALLOCATE,
      // DISCARD, or session close.
      await client.unsafe(`PREPARE ${stmtName} AS SELECT 1 AS one`);

      // Sanity check — the statement is registered server-side.
      const pre = await client<
        { name: string }[]
      >`SELECT name FROM pg_prepared_statements WHERE name = ${stmtName}`;
      expect(pre.length).toBe(1);

      // Acquire + release. With the scoped-reset fix the prepared
      // statement should survive untouched.
      const ctx = await acquireStreamRls(client, tenantId);
      await ctx.release();

      // The killing assertion — under DISCARD ALL this returns 0
      // rows. Under the scoped reset it still returns 1.
      const post = await client<
        { name: string }[]
      >`SELECT name FROM pg_prepared_statements WHERE name = ${stmtName}`;
      expect(post.length).toBe(1);
    } finally {
      // Best-effort cleanup; if the statement was already nuked the
      // DEALLOCATE no-ops with an error we swallow.
      await client.unsafe(`DEALLOCATE ${stmtName}`).catch(() => undefined);
      await client.end();
    }
  });

  it("clears the role and tenant GUC so the recycled connection returns clean", async () => {
    // max: 1 keeps the test deterministic — the same connection
    // serves both the reserved (during the stream) and the recycled
    // (after release) phases, so post-release queries on the parent
    // client land on the very connection whose state was just reset.
    const client = postgres(url, {
      max: 1,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      onnotice: () => {},
    });
    const tenantId = "t-189-invariant-test";
    try {
      const ctx = await acquireStreamRls(client, tenantId);
      // During the stream: role is myme_app + GUC is set. Query via
      // the reserved connection (ctx.streamDb) — the parent client
      // has no free slot while the reservation is held.
      const midRole = (await ctx.streamDb.execute(
        sql`SELECT current_user::text AS current_user`,
      )) as unknown as readonly { current_user: string }[];
      const midTenant = (await ctx.streamDb.execute(
        sql`SELECT current_setting('marfa.tenant_id', true) AS setting`,
      )) as unknown as readonly { setting: string | null }[];
      expect(midRole[0]?.current_user).toBe("myme_app");
      expect(midTenant[0]?.setting).toBe(tenantId);

      await ctx.release();

      // After release: the parent client picks up the recycled
      // connection. Role must be back to the pool's default owner
      // (not myme_app), and the tenant GUC must be empty.
      const postRole = await client<
        { current_user: string }[]
      >`SELECT current_user::text`;
      const postTenant = await client<
        { setting: string | null }[]
      >`SELECT current_setting('marfa.tenant_id', true) AS setting`;
      expect(postRole[0]?.current_user).not.toBe("myme_app");
      expect(postTenant[0]?.setting ?? "").toBe("");
    } finally {
      await client.end();
    }
  });
});
