/**
 * Postgres RLS connection-pool enforcement.
 *
 * Verifies the request-level wiring actually filters cross-space data via
 * DB-layer RLS, not just the application-layer scoping.
 *
 * Two test surfaces:
 *
 *   1. **Direct DB-layer.** Open a Drizzle transaction, run `SET LOCAL
 *      ROLE marfa_app; SELECT set_config('marfa.space_id', spaceA, true)`,
 *      then issue an *unscoped* `SELECT * FROM items` (no WHERE clause).
 *      RLS must filter to space A's rows. This proves the policies bite the
 *      role even when the application layer would have leaked.
 *
 *   2. **End-to-end via the middleware.** Boot the test context with
 *      `rlsEnforce: true`, mint a space-bound key, request
 *      `/items/<other-space-item>` as space A → 404 (RLS denies the row,
 *      the route's `get(id, spaceId)` returns nothing). The middleware
 *      activates the role-switch wrapper.
 *
 * SQLite skips — RLS is Postgres-only.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestContext,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../../test-utils.js";
import { hashApiKey } from "../../middleware/auth.js";
import type { PgDb } from "./connection.js";
import { Hono } from "hono";
import type { ApiKey } from "@withmarfa/shared";
import type { AppEnv } from "../../middleware/auth.js";
import { rlsSpaceContextMiddleware } from "../../middleware/rls-space-context.js";

const dialect = process.env.DB_DIALECT ?? "sqlite";
const isPg = dialect === "pg";

describe.skipIf(!isPg)("Postgres RLS enforcement", () => {
  describe("direct DB-layer", () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await createTestContext({ rlsEnforce: true });
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("filters cross-space SELECT under SET LOCAL ROLE marfa_app", async () => {
      const spaceA = `space-a-${Math.random().toString(36).slice(2, 8)}`;
      const spaceB = `space-b-${Math.random().toString(36).slice(2, 8)}`;

      // Create one item per space as the owner (RLS bypassed at this level).
      const itemA = await ctx.storage.items.create(
        { type: "core.note", properties: { body: "space A item" } },
        spaceA,
      );
      const itemB = await ctx.storage.items.create(
        { type: "core.note", properties: { body: "space B item" } },
        spaceB,
      );

      // Run as marfa_app with space_id = spaceA. Unscoped SELECT must
      // return only space A's rows — proves RLS bites at the DB layer
      // independent of application WHERE clauses.
      const pgDb = (ctx.storage as unknown as { pgDb: PgDb }).pgDb;
      const seenIdsForA = await pgDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('marfa.space_id', ${spaceA}, true)`,
        );
        await tx.execute(sql`SET LOCAL ROLE marfa_app`);
        const rows = await tx.execute<{ id: string; space_id: string }>(
          sql`SELECT id, space_id FROM items WHERE id IN (${itemA.id}, ${itemB.id})`,
        );
        return new Set(rows.map((r) => r.id));
      });

      expect(seenIdsForA.has(itemA.id)).toBe(true);
      expect(seenIdsForA.has(itemB.id)).toBe(false);

      const seenIdsForB = await pgDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('marfa.space_id', ${spaceB}, true)`,
        );
        await tx.execute(sql`SET LOCAL ROLE marfa_app`);
        const rows = await tx.execute<{ id: string; space_id: string }>(
          sql`SELECT id, space_id FROM items WHERE id IN (${itemA.id}, ${itemB.id})`,
        );
        return new Set(rows.map((r) => r.id));
      });

      expect(seenIdsForB.has(itemA.id)).toBe(false);
      expect(seenIdsForB.has(itemB.id)).toBe(true);
    });

    it("returns to owner role after the transaction commits", async () => {
      const pgDb = (ctx.storage as unknown as { pgDb: PgDb }).pgDb;

      await pgDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('marfa.space_id', 'x', true)`);
        await tx.execute(sql`SET LOCAL ROLE marfa_app`);
      });

      const rows = await pgDb.execute<{ role: string; space: string }>(
        sql`SELECT current_user::text AS role, current_setting('marfa.space_id', true) AS space`,
      );
      expect(rows[0]?.role).not.toBe("marfa_app");
      // SET LOCAL cleared on commit — GUC is empty outside the transaction.
      expect(rows[0]?.space ?? "").toBe("");
    });
  });

  describe("end-to-end via the RLS middleware", () => {
    let ctx: TestContext;
    let spaceAKey: string;
    let spaceBKey: string;
    const spaceA = `space-e2e-a-${Math.random().toString(36).slice(2, 8)}`;
    const spaceB = `space-e2e-b-${Math.random().toString(36).slice(2, 8)}`;

    beforeAll(async () => {
      ctx = await createTestContext({ rlsEnforce: true });

      const mintKey = async (space: string) => {
        const suffix = Math.random().toString(36).slice(2, 10);
        const raw = `marfa_k1_${space}_${suffix}`;
        await ctx.storage.keys.create(
          {
            label: `${space}-admin`,
            source: `${space}-source-${suffix}`,
            // The maps carry the whole of the reach, so the wildcard is what
            // lets this key write items in its own space.
            type_permissions: { "*": "write" },
            default_tier: "library",
          },
          hashApiKey(raw, TEST_API_KEY_SALT),
          space,
        );
        return raw;
      };

      spaceAKey = await mintKey(spaceA);
      spaceBKey = await mintKey(spaceB);
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("denies cross-space GET /items/:id at the route level (404)", async () => {
      // Create an item as space B.
      const createRes = await ctx.app.request("/items", {
        method: "POST",
        headers: {
          authorization: `Bearer ${spaceBKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "core.note",
          properties: { body: "space B secret" },
        }),
      });
      expect(createRes.status).toBe(201);
      // POST /items returns `{ item: {...}, metadata: {...} }`.
      const created = (await createRes.json()) as { item: { id: string } };

      // Space A requests space B's item — RLS blocks it at the DB layer.
      const probeRes = await ctx.app.request(`/items/${created.item.id}`, {
        headers: { authorization: `Bearer ${spaceAKey}` },
      });
      expect(probeRes.status).toBe(404);

      const ownRes = await ctx.app.request(`/items/${created.item.id}`, {
        headers: { authorization: `Bearer ${spaceBKey}` },
      });
      expect(ownRes.status).toBe(200);
    });

    it("actually switches the connection to marfa_app inside a space-bounded request", async () => {
      // Every other case in this file would still pass if the middleware
      // stopped switching roles: the application-layer space fence
      // produces the same 404s on its own. This is the one assertion
      // that regresses if the role flip breaks — a probe route behind
      // the real middleware reading current_user through the
      // request-context proxy.
      const probe = new Hono<AppEnv>();
      probe.use("*", async (c, next) => {
        c.set("apiKey", {
          id: "rls-probe-key",
          space_id: spaceA,
        } as unknown as ApiKey);
        await next();
      });
      probe.use(
        "*",
        rlsSpaceContextMiddleware({
          rlsEnforce: true,
          db: ctx.storage.pgDb as PgDb,
        }),
      );
      probe.get("/whoami", async (c) => {
        const db = ctx.storage.pgDb as PgDb;
        const rows = (await db.execute(
          sql`SELECT current_user AS who, current_setting('marfa.space_id', true) AS space`,
        )) as unknown as { who: string; space: string }[];
        return c.json(rows[0]);
      });
      const res = await probe.request("/whoami");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { who: string; space: string };
      expect(body.who).toBe("marfa_app");
      expect(body.space).toBe(spaceA);
    });
  });
});
