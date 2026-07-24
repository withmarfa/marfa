import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createConnection } from "./connection.js";

// Postgres-only — runs under `pnpm test:pg` which spins up a throw-away
// pg17 container and sets DB_DIALECT=pg + DATABASE_URL.
const isPg = process.env.DB_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!isPg || !url)("pg connection", () => {
  // The schema scaffold creates RLS policies on 19 tenant-scoped tables:
  // items, edges, versions, metadata, api_keys, blobs, custom_types,
  // custom_edge_types, outbound_webhooks, audit_log, event_log,
  // inbound_webhooks, connection_oauth_tokens, connection_leased_tokens,
  // bulk_action_jobs, users, tenant_quotas, outbound_webhook_deliveries,
  // and inbound_webhook_events. Each carries a `_tenant_isolation` policy +
  // CRUD grants for the `marfa_app` role.
  //
  // Two more tables carry RLS without a `_tenant_isolation` policy, so the
  // tenant-isolation count stays 19 while the number of RLS-enabled tables
  // is 21:
  //   - auth_user — an `auth_user_self` self-policy so /profile/me can read
  //     its email mirror under marfa_app.
  //   - tenants — a `tenants_self_isolation` policy keyed on the primary
  //     key rather than a `tenant_id` column, since the row IS the tenant.
  it("creates the RLS scaffold on tenant tables (19 policies)", async () => {
    const { close } = await createConnection(url);
    const client = postgres(url, { max: 1 });
    try {
      const policies = await client<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname LIKE '%_tenant_isolation'
      `;
      expect(policies[0]?.count).toBe("19");

      const enabled = await client<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM pg_class
        WHERE relkind = 'r'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
          AND relrowsecurity = true
      `;
      // 19 tenant-scoped tables + auth_user + tenants = 21.
      expect(enabled[0]?.count).toBe("21");
    } finally {
      await client.end();
      await close();
    }
  });
});
