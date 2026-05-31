import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createConnection } from "./connection.js";

// Postgres-only — runs under `pnpm test:pg` which spins up a throw-away
// pg17 container and sets DB_DIALECT=pg + DATABASE_URL.
const isPg = process.env.DB_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!isPg || !url)("pg connection", () => {
  // T-025 part 1 (Wave B): the schema scaffold creates 11 RLS policies on
  // tenant-scoped tables (items, edges, versions, metadata, api_keys, blobs,
  // custom_types, custom_edge_types, outbound_webhooks, audit_log, event_log).
  // Wave B Part 4 follow-on extends the policy block to three more direct-
  // tenant_id tables (inbound_webhooks, connection_oauth_tokens,
  // connection_leased_tokens) — total 14. T-218 adds bulk_action_jobs as the
  // 15th tenant-scoped table with the same _tenant_isolation policy + grants
  // shape. RLS is enabled on the same set. Policies have no effect until the
  // connection-pool wiring lands in T-025 part 2 (the application connects
  // as the table owner today).
  //
  // T-271 enables RLS on auth_user too, with a self-policy (`auth_user_self`)
  // exposing only the caller's own identity row so /profile/me can read its
  // email mirror under marfa_app. That policy is NOT a `_tenant_isolation`
  // policy, so the tenant-isolation count stays 15 — but the number of
  // RLS-enabled tables rises to 16.
  it("creates the T-025 RLS scaffold on tenant tables (15 policies)", async () => {
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
      // 15 tenant-scoped tables + auth_user (T-271) = 16.
      expect(enabled[0]?.count).toBe("16");
    } finally {
      await client.end();
      await close();
    }
  });
});
