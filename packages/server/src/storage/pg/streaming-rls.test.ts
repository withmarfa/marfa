/**
 * Regression guard: the streaming-RLS cleanup must scope its reset to the
 * role + tenant GUC only, NOT use `DISCARD ALL`.
 *
 * Using `DISCARD ALL` on stream release deallocates every server-side
 * prepared statement on the recycled connection. postgres.js retains a
 * client-side `statements` cache keyed per physical connection, so the
 * next query that bound to a cached statement name surfaces
 * `prepared statement "<name>" does not exist` (SQLSTATE 26000).
 * Under concurrent SSE + writes the retry window races against in-flight
 * pipelined queries and caused ~20% POST /items 500s.
 *
 * The correct reset scopes to exactly what the cleanup invariant requires:
 *
 *   - `RESET ROLE` — drop the `marfa_app` elevation.
 *   - `set_config('marfa.tenant_id', '', false)` — clear the GUC the
 *     RLS policies read.
 *
 * Prepared statements survive untouched. RLS policies consult
 * `current_setting('marfa.tenant_id')` at execute time, so a statement
 * compiled while the GUC held tenant A executes safely once the GUC flips
 * to tenant B (or clears) — the cache is value-agnostic.
 *
 * Two assertions:
 *
 *   1. **Server-side prepared statements survive release.** A session-level
 *      prepared statement created before the streaming reservation must
 *      still exist after `ctx.release()`. Under `DISCARD ALL` it would be
 *      deallocated; under the scoped reset it persists.
 *   2. **Role + tenant GUC are cleared on release.** A connection returned
 *      to the pool cannot carry the `marfa_app` role or a leaked
 *      `marfa.tenant_id`.
 *
 * Postgres-only — RLS is a PG feature.
 */

import { describe, it, expect } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { acquireStreamRls } from "./streaming-rls.js";

const isPg = process.env.DB_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!isPg || !url)("streaming-rls cleanup", () => {
  it("preserves server-side prepared statements across release (no DISCARD ALL)", async () => {
    // max: 1 ensures the streaming `reserve()` and the post-release
    // queries land on the same physical connection — deterministic
    // reproduction of the recycled-connection path.
    const client = postgres(url, {
      max: 1,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      onnotice: () => {},
    });
    const stmtName = `marfa_rls_test_${Math.random().toString(36).slice(2, 10)}`;
    const tenantId = "streaming-rls-cache-test";
    try {
      // PREPARE is server-side; lives until DEALLOCATE, DISCARD, or session close.
      await client.unsafe(`PREPARE ${stmtName} AS SELECT 1 AS one`);

      const pre = await client<
        { name: string }[]
      >`SELECT name FROM pg_prepared_statements WHERE name = ${stmtName}`;
      expect(pre.length).toBe(1);

      const ctx = await acquireStreamRls(client, tenantId);
      await ctx.release();

      // DISCARD ALL would nuke this; scoped reset must leave it intact.
      const post = await client<
        { name: string }[]
      >`SELECT name FROM pg_prepared_statements WHERE name = ${stmtName}`;
      expect(post.length).toBe(1);
    } finally {
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
    const tenantId = "streaming-rls-invariant-test";
    try {
      const ctx = await acquireStreamRls(client, tenantId);
      const midRole = (await ctx.streamDb.execute(
        sql`SELECT current_user::text AS current_user`,
      )) as unknown as readonly { current_user: string }[];
      const midTenant = (await ctx.streamDb.execute(
        sql`SELECT current_setting('marfa.tenant_id', true) AS setting`,
      )) as unknown as readonly { setting: string | null }[];
      expect(midRole[0]?.current_user).toBe("marfa_app");
      expect(midTenant[0]?.setting).toBe(tenantId);

      await ctx.release();

      // After release: recycled connection must have role reset and GUC cleared.
      const postRole = await client<
        { current_user: string }[]
      >`SELECT current_user::text`;
      const postTenant = await client<
        { setting: string | null }[]
      >`SELECT current_setting('marfa.tenant_id', true) AS setting`;
      expect(postRole[0]?.current_user).not.toBe("marfa_app");
      expect(postTenant[0]?.setting ?? "").toBe("");
    } finally {
      await client.end();
    }
  });
});
