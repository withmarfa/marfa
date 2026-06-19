/**
 * Owner-assertion guard for auth/tenant provisioning writes.
 *
 * Regression for the hosted sign-up failure: the owner write began running as
 * the restricted `marfa_app` role — a streaming session-level `SET ROLE`
 * stranded on a shared pooled connection and was inherited by the sign-up
 * write — so it hit RLS and `auth_user`/`users`/`tenant` never got created.
 * The root fix routes streaming off the pooled endpoint; `withOwnerRole` is
 * the defense-in-depth layer that forces the owner role for the provisioning
 * writes regardless, via a transaction-scoped `SET LOCAL ROLE NONE`.
 *
 * `withOwnerRole`'s end-to-end wiring (drizzle transaction + request-context
 * ALS + storage writes) is already exercised by the sign-up-under-RLS happy
 * path in `rls-ungated-tables.test.ts`. This suite proves the SECURITY
 * property that test can't: that `SET LOCAL ROLE NONE` actually NEUTRALIZES a
 * stranded `marfa_app`. It poisons a connection exactly as the bug did, shows
 * the write is denied under the stranded role, then shows the same write
 * succeeds once the role is reset inside a transaction.
 *
 * SQLite skips — RLS + roles are Postgres-only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, type TestContext } from "../../test-utils.js";
import type { PgClient } from "./connection.js";

const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";
const rand = (): string => Math.random().toString(36).slice(2, 10);

const INSERT_USER = `INSERT INTO users (id, name, provider, provider_id, tenant_id, created_at, updated_at)
   VALUES ($1, $2, 'test', $1, $3, $4, $4)`;

describe.skipIf(!isPg)(
  "owner-role assertion over a stranded session role",
  () => {
    let ctx: TestContext;
    let client: PgClient;

    beforeAll(async () => {
      ctx = await createTestContext({ rlsEnforce: true, authMode: "hosted" });
      client = (ctx.storage as unknown as { pgClient: PgClient }).pgClient;
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("SET LOCAL ROLE NONE neutralizes a stranded marfa_app for a users write", async () => {
      if (!ctx.storage.tenants || !ctx.storage.users) {
        throw new Error("hosted storage expected");
      }
      // FK target, created as owner via the normal pooled connection.
      const tenant = await ctx.storage.tenants.create(`owner-role-${rand()}`);
      const now = new Date().toISOString();

      const reserved = await client.reserve();
      try {
        // Poison the connection exactly as the streaming bug did: a
        // SESSION-level role switch that persists for the connection's life.
        await reserved.unsafe("SET ROLE marfa_app");
        const who = await reserved<{ u: string }[]>`SELECT current_user AS u`;
        expect(who[0]?.u).toBe("marfa_app");

        // Control: a `users` write under the stranded role is denied —
        // proving `marfa_app` genuinely cannot perform this write.
        await expect(
          reserved.unsafe(INSERT_USER, [
            `ctl-${rand()}`,
            "ctl",
            tenant.id,
            now,
          ]),
        ).rejects.toThrow();

        // Treatment: inside a transaction, `SET LOCAL ROLE NONE` resets to the
        // owner (exactly what `withOwnerRole` issues), so the same write
        // succeeds via owner RLS-bypass.
        const okId = `ok-${rand()}`;
        await reserved.unsafe("BEGIN");
        try {
          await reserved.unsafe("SET LOCAL ROLE NONE");
          const within = await reserved<
            { u: string }[]
          >`SELECT current_user AS u`;
          expect(within[0]?.u).not.toBe("marfa_app");
          await reserved.unsafe(INSERT_USER, [okId, "ok", tenant.id, now]);
          await reserved.unsafe("COMMIT");
        } catch (err) {
          await reserved.unsafe("ROLLBACK");
          throw err;
        }

        // The reset was transaction-scoped: after COMMIT the connection is
        // back under the stranded role (confirms SET LOCAL, not a leak).
        const after = await reserved<{ u: string }[]>`SELECT current_user AS u`;
        expect(after[0]?.u).toBe("marfa_app");

        // The owner write actually persisted (owner read via the pool).
        const owner = (
          ctx.storage as unknown as {
            __pgClient: (
              q: string,
              p?: unknown[],
            ) => Promise<{ tenant_id: string }[]>;
          }
        ).__pgClient;
        const rows = await owner(`SELECT tenant_id FROM users WHERE id = $1`, [
          okId,
        ]);
        expect(rows[0]?.tenant_id).toBe(tenant.id);
      } finally {
        // Reset the poison before returning the connection to the pool.
        try {
          await reserved.unsafe("RESET ROLE");
        } catch {
          // Best-effort — the pool is torn down in afterAll regardless.
        }
        reserved.release();
      }
    });
  },
);
