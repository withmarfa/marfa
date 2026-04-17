import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { createConnection } from "./connection.js";

// Postgres-only — runs under `pnpm test:pg` which spins up a throw-away
// pg17 container and sets STORAGE_DIALECT=pg + DATABASE_URL.
const isPg = process.env.STORAGE_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!isPg || !url)("pg connection", () => {
  it("creates no Row Level Security policies on tenant tables", async () => {
    // Bootstrap a fresh connection so SCHEMA_SQL has been applied.
    const { close } = await createConnection(url);

    // Use a separate query client so we can assert against pg_policies.
    const client = postgres(url, { max: 1 });
    try {
      const policies = await client<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM pg_policies
        WHERE schemaname = 'public'
      `;
      expect(policies[0]?.count).toBe("0");

      const enabled = await client<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM pg_class
        WHERE relkind = 'r'
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
          AND relrowsecurity = true
      `;
      expect(enabled[0]?.count).toBe("0");
    } finally {
      await client.end();
      await close();
    }
  });
});
