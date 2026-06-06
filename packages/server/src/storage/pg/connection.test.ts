import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createConnection } from "./connection.js";

// Postgres-only — runs under `pnpm test:pg` which spins up a throw-away
// pg17 container and sets DB_DIALECT=pg + DATABASE_URL.
const isPg = process.env.DB_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!isPg || !url)("pg connection", () => {
  // The schema scaffold creates RLS policies on 15 tenant-scoped tables:
  // items, edges, versions, metadata, api_keys, blobs, custom_types,
  // custom_edge_types, outbound_webhooks, audit_log, event_log,
  // inbound_webhooks, connection_oauth_tokens, connection_leased_tokens,
  // and bulk_action_jobs. Each carries a `_tenant_isolation` policy + CRUD
  // grants for the `marfa_app` role.
  //
  // auth_user also has RLS enabled (a `auth_user_self` self-policy so
  // /profile/me can read its email mirror under marfa_app), but its policy
  // is NOT a `_tenant_isolation` policy — the tenant-isolation count stays
  // 15 while the number of RLS-enabled tables is 16.
  it("creates the RLS scaffold on tenant tables (15 policies)", async () => {
    const { close } = await createConnection(url);
    const client = postgres(url, { max: 1 });
    try {
      const policies = await client<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname LIKE '%_tenant_isolation'
      `;
      expect(policies[0]?.count).toBe("15");

      const enabled = await client<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM pg_class
        WHERE relkind = 'r'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
          AND relrowsecurity = true
      `;
      // 15 tenant-scoped tables + auth_user = 16.
      expect(enabled[0]?.count).toBe("16");
    } finally {
      await client.end();
      await close();
    }
  });
});
