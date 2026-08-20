import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createConnection } from "./connection.js";

// Postgres-only — runs under `pnpm test:pg` which spins up a throw-away
// pg17 container and sets DB_DIALECT=pg + DATABASE_URL.
const isPg = process.env.DB_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!isPg || !url)("pg connection", () => {
  // The schema scaffold creates RLS policies on 19 space-scoped tables:
  // items, edges, versions, metadata, api_keys, blobs, custom_types,
  // custom_edge_types, outbound_webhooks, audit_log, event_log,
  // inbound_webhooks, connection_oauth_tokens, connection_leased_tokens,
  // bulk_action_jobs, users, space_quotas, outbound_webhook_deliveries,
  // and inbound_webhook_events. Each carries a `_space_isolation` policy +
  // CRUD grants for the `marfa_app` role.
  //
  // Two more tables carry RLS without a `_space_isolation` policy, so the
  // space-isolation count stays 19 while the number of RLS-enabled tables
  // is 21:
  //   - auth_user — an `auth_user_self` self-policy so /profile/me can read
  //     its email mirror under marfa_app.
  //   - spaces — a `spaces_self_isolation` policy keyed on the primary
  //     key rather than a `space_id` column, since the row IS the space.
  it("creates the RLS scaffold on space tables (19 policies)", async () => {
    const { close } = await createConnection(url);
    const client = postgres(url, { max: 1 });
    try {
      const policies = await client<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname LIKE '%_space_isolation'
      `;
      expect(policies[0]?.count).toBe("19");

      const enabled = await client<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM pg_class
        WHERE relkind = 'r'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
          AND relrowsecurity = true
      `;
      // 19 space-scoped tables + auth_user + spaces = 21.
      expect(enabled[0]?.count).toBe("21");
    } finally {
      await client.end();
      await close();
    }
  });
});

/**
 * Fail-closed guard on the streaming-RLS endpoint. Needs no database: the
 * check runs before any client is constructed, precisely so a misconfigured
 * deployment dies at boot rather than at the first stream.
 */
describe("createConnection pool-mode guard", () => {
  const POOLED = "postgres://user:pw@pooler.invalid:6432/marfa";
  const DIRECT = "postgres://user:pw@direct.invalid:5432/marfa";

  it("rejects a transaction-mode pool with no direct endpoint, naming the variable", async () => {
    // Streaming issues a session-level SET ROLE. Reusing the pooled client for
    // it strands that role on a shared PgBouncer backend, where an unrelated
    // later query inherits it — so "no direct endpoint" cannot silently mean
    // "reuse the pooled one".
    await expect(
      createConnection(POOLED, { poolMode: "transaction" }),
    ).rejects.toThrow(/MARFA_DATABASE_URL_DIRECT/);
  });

  it("rejects a direct endpoint that is only whitespace", async () => {
    await expect(
      createConnection(POOLED, {
        poolMode: "transaction",
        directConnectionString: "   ",
      }),
    ).rejects.toThrow(/MARFA_DATABASE_URL_DIRECT/);
  });

  it("rejects a direct endpoint that is the pooled one again", async () => {
    // Verified against PgBouncer 1.25.2 in pool_mode = transaction: this shape
    // builds a second, distinct pool, satisfies every presence check, logs
    // itself as `direct`, and then turns 20 consecutive owner reads of an
    // auth table into 20 SQLSTATE 42501s for the duration of a stream. A
    // genuinely direct endpoint leaves all 20 clean. "Set" is not "direct".
    await expect(
      createConnection(POOLED, {
        poolMode: "transaction",
        directConnectionString: POOLED,
      }),
    ).rejects.toThrow(/same endpoint as DATABASE_URL/);
  });

  it("rejects the pooled endpoint wearing different credentials", async () => {
    // Which user, database and TLS mode the URL asks for changes nothing about
    // which listener answers, so neither can be allowed to disguise it.
    await expect(
      createConnection(POOLED, {
        poolMode: "transaction",
        directConnectionString:
          "postgresql://other:secret@pooler.invalid:6432/other?sslmode=require",
      }),
    ).rejects.toThrow(/same endpoint as DATABASE_URL/);
  });

  it("accepts a genuinely separate endpoint and gives streaming its own pool", async () => {
    // No connection is opened: postgres.js is lazy and bootstrap is skipped.
    const conn = await createConnection(POOLED, {
      poolMode: "transaction",
      directConnectionString: DIRECT,
      skipBootstrap: true,
    });
    expect(conn.sessionClient).not.toBe(conn.client);
    await conn.close();
  });

  it("disables prepared statements on the pooled client in transaction mode", async () => {
    // The pool mode used to be validated by the guards above and then
    // discarded before this constructor, leaving the driver's
    // prepare-by-default live against a pooler that cannot support it.
    // The direct clients own their backends and keep preparation.
    const conn = await createConnection(POOLED, {
      poolMode: "transaction",
      directConnectionString: DIRECT,
      skipBootstrap: true,
    });
    try {
      const prepareOf = (c: unknown): boolean =>
        (c as { options: { prepare: boolean } }).options.prepare;
      expect(prepareOf(conn.client)).toBe(false);
      expect(prepareOf(conn.sessionClient)).toBe(true);
      expect(prepareOf(conn.jobHolderClient)).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it("keeps prepared statements on a session-mode (direct) endpoint", async () => {
    const conn = await createConnection(DIRECT, {
      poolMode: "session",
      skipBootstrap: true,
    });
    try {
      expect(
        (conn.client as unknown as { options: { prepare: boolean } }).options
          .prepare,
      ).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it("closes idle connections and recycles long-lived ones, on both pools", async () => {
    // postgres.js never closes an idle connection by default, so the pool holds
    // its sockets for the life of the process. A serverless Postgres only
    // scales to zero when it has no connections at all, which turns an idle
    // deployment into a continuous bill: measured, one instance spent 403 of
    // its billing hours awake while holding four OAuth grants and no items.
    // Both pools need this — the streaming one sits idle between streams.
    const conn = await createConnection(POOLED, {
      poolMode: "transaction",
      directConnectionString: DIRECT,
      skipBootstrap: true,
    });
    try {
      for (const client of [conn.client, conn.sessionClient]) {
        const { idle_timeout: idleTimeout, max_lifetime: maxLifetime } = (
          client as unknown as {
            options: { idle_timeout: number; max_lifetime: number };
          }
        ).options;
        expect(idleTimeout).toBeGreaterThan(0);
        // Has to clear the provider's own idle timer (300s on Neon) with room
        // to spare, or the sockets close too late for a suspend to ever engage.
        expect(idleTimeout).toBeLessThanOrEqual(60);
        expect(maxLifetime).toBeGreaterThan(idleTimeout);
      }
    } finally {
      await conn.close();
    }
  });

  it("accepts a pooler and a Postgres sharing a host on different ports", async () => {
    // PgBouncer beside Postgres on one machine is the standard self-hosted
    // shape. Comparing hosts alone would refuse to start a correct deployment.
    const conn = await createConnection(
      "postgres://user:pw@localhost:6432/marfa",
      {
        poolMode: "transaction",
        directConnectionString: "postgres://user:pw@localhost:5432/marfa",
        skipBootstrap: true,
      },
    );
    expect(conn.sessionClient).not.toBe(conn.client);
    await conn.close();
  });
});
