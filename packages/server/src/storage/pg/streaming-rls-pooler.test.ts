/**
 * The property the existing `streaming-rls.test.ts` cannot observe: a stream
 * must not leak its session-level `SET ROLE marfa_app` onto connections it does
 * not own.
 *
 * `streaming-rls.test.ts` asserts state on the *reserved* connection — that
 * prepared statements survive release, and that the role and tenant GUC are
 * cleared on the way out. Both hold on a direct endpoint and neither can see a
 * role stranded on a *sibling* backend, so they pass cleanly while the app pool
 * is being poisoned underneath them.
 *
 * Over a transaction-mode pooler the reserved link is not a backend. PgBouncer
 * hands out a server connection per transaction, so a session-level `SET ROLE`
 * issued outside a transaction lands on whichever backend served that statement
 * and stays there, to be inherited by an unrelated later query. `RESET ROLE` on
 * release is routed the same way and need not reach the same backend. The
 * consequence is not theoretical: `auth_session` carries no grant to
 * `marfa_app`, so Better Auth's session read on a poisoned backend fails with
 * SQLSTATE 42501 and the request 500s.
 *
 * Opt-in. Ordinary CI has no PgBouncer, so the suite skips unless both URLs are
 * present. To run it, put a PgBouncer in `pool_mode = transaction` in front of a
 * Postgres instance and point the two variables at the pooled and unpooled
 * endpoints of the same database:
 *
 *   MARFA_TEST_PGBOUNCER_URL=postgres://…@pooler-host:6432/db
 *   MARFA_TEST_PGBOUNCER_DIRECT_URL=postgres://…@pg-host:5432/db
 *
 * A small `default_pool_size` makes any leak land on a backend the probe is
 * certain to reach. The connecting role must be able to `CREATE ROLE`, since
 * the fixture below builds the `marfa_app` / ungranted-table pair the real
 * schema has.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createConnection } from "./connection.js";
import { acquireStreamRls } from "./streaming-rls.js";

const pooledUrl = process.env.MARFA_TEST_PGBOUNCER_URL ?? "";
const directUrl = process.env.MARFA_TEST_PGBOUNCER_DIRECT_URL ?? "";
const enabled = pooledUrl !== "" && directUrl !== "";

const TENANT_ID = "streaming-rls-pooler-test";

/** Single-connection client on the unpooled endpoint, for fixture DDL. */
const adminClient = (): ReturnType<typeof postgres> =>
  postgres(directUrl, {
    max: 1,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onnotice: () => {},
  });

describe.skipIf(!enabled)(
  "streaming RLS over a transaction-mode pooler",
  () => {
    beforeAll(async () => {
      // Mirrors the shape that matters in the real schema: a `marfa_app` role the
      // owner can assume, and an auth table it holds no grant on.
      const admin = adminClient();
      try {
        await admin.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marfa_app') THEN
            CREATE ROLE marfa_app NOLOGIN;
          END IF;
        END
        $$;
        GRANT marfa_app TO CURRENT_USER;
        CREATE TABLE IF NOT EXISTS auth_session (
          id text PRIMARY KEY,
          token text
        );
        REVOKE ALL ON auth_session FROM marfa_app;
      `);
      } finally {
        await admin.end();
      }
    });

    afterAll(async () => {
      const admin = adminClient();
      try {
        await admin.unsafe(`DROP TABLE IF EXISTS auth_session`);
      } finally {
        await admin.end();
      }
    });

    /**
     * The read Better Auth makes on every signed-in request, as the database
     * owner. Resolves to the SQLSTATE when the backend it lands on is poisoned.
     */
    async function readAuthSessionAsOwner(
      client: ReturnType<typeof postgres>,
      attempts: number,
    ): Promise<string[]> {
      const codes: string[] = [];
      for (let i = 0; i < attempts; i += 1) {
        try {
          await client`SELECT count(*) FROM auth_session`;
          codes.push("ok");
        } catch (err) {
          codes.push((err as { code?: string }).code ?? "unknown");
        }
      }
      return codes;
    }

    it("refuses to build a transaction-mode connection with no direct endpoint", async () => {
      // The escape hatch is only an escape hatch if its absence is loud. Falling
      // back to the pooled client here is what turned one unforwarded env var
      // into intermittent 500s across every signed-in surface.
      await expect(
        createConnection(pooledUrl, {
          poolMode: "transaction",
          skipBootstrap: true,
        }),
      ).rejects.toThrow(/MARFA_DATABASE_URL_DIRECT/);
    });

    it("keeps the app pool readable as owner across a stream's whole lifetime", async () => {
      const conn = await createConnection(pooledUrl, {
        poolMode: "transaction",
        directConnectionString: directUrl,
        skipBootstrap: true,
        maxPoolSize: 3,
      });
      expect(conn.streamClient).not.toBe(conn.client);

      try {
        const before = await readAuthSessionAsOwner(conn.client, 10);
        expect(new Set(before)).toEqual(new Set(["ok"]));

        const ctx = await acquireStreamRls(conn.streamClient, TENANT_ID);
        try {
          // The assertion the reserved-connection tests structurally cannot make:
          // the stream is live, and the app pool is unaffected by it.
          const during = await readAuthSessionAsOwner(conn.client, 20);
          expect(new Set(during)).toEqual(new Set(["ok"]));
        } finally {
          await ctx.release();
        }

        const after = await readAuthSessionAsOwner(conn.client, 10);
        expect(new Set(after)).toEqual(new Set(["ok"]));
      } finally {
        await conn.close();
      }
    });
  },
);
