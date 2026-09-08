/**
 * The Postgres half of the scope rename (migration 0103).
 *
 * This is the dialect the deployments run, and it is where the two halves
 * differ most: five of the eight columns are native `text[]` here and JSON
 * text in SQLite, and `items.properties` is native `jsonb` rather than
 * SQLite's binary encoding. A statement that behaves in one dialect proves
 * nothing about the other, so both are replayed against a real database.
 *
 * Rows go in raw. Nothing in the current build can write a `capability.*`
 * literal — the code no longer holds one — which is the whole reason a
 * database can carry rows this migration has to reach.
 *
 * SQLite skips the suite; its sibling covers that dialect.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestContext, type TestContext } from "../../test-utils.js";
import type { PgDb } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";

const MIGRATION = readFileSync(
  join(__dirname, "../../../drizzle/pg/0103_space_permission_scope_rename.sql"),
  "utf8",
);

const OLD_SET = [
  "core.note:read",
  "capability.keys",
  "capability.space_settings",
  "capability.space_usage",
  "capability.item_purge",
];

const NEW_SET = [
  "core.note:read",
  "space.keys",
  "space.settings",
  "space.usage",
  "space.item_purge",
];

let ctx: TestContext;

beforeAll(async () => {
  if (!isPg) return;
  ctx = await createTestContext();
});

afterAll(async () => {
  if (!isPg) return;
  await ctx.cleanup();
});

describe.skipIf(!isPg)(
  "0103 space permission scopes take the space root",
  () => {
    const db = (): PgDb => ctx.storage.pgDb as PgDb;

    /** Statement by statement, stripping comments, exactly as the sibling
     *  migration tests do — a file that grows another statement must not have
     *  it silently dropped here. */
    const replay = async () => {
      for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
        const s = stmt
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("--"))
          .join("\n")
          .trim();
        if (s.length > 0) await db().execute(sql.raw(s));
      }
    };

    /** A `text[]` literal. Drizzle's `sql` tag spreads a JS array into one
     *  parameter per element, which Postgres reads as a record rather than an
     *  array, so the array is built into the statement instead. Every value
     *  here is a fixed scope literal declared in this file. */
    const textArray = (values: readonly string[]) =>
      sql.raw(`ARRAY[${values.map((v) => `'${v}'`).join(", ")}]::text[]`);

    const seed = async (suffix: string) => {
      const userId = `u-${suffix}`;
      const clientId = `c-${suffix}`;
      await db().execute(sql`
      INSERT INTO auth_user (id, name, email, created_at, updated_at)
      VALUES (${userId}, ${suffix}, ${`${suffix}@test.marfa.so`}, now(), now())
    `);
      await db().execute(sql`
      INSERT INTO auth_oauth_client (id, client_id, redirect_uris, scopes, user_id)
      VALUES (${clientId}, ${clientId}, ARRAY[]::text[], ${textArray(OLD_SET)}, ${userId})
    `);
      await db().execute(sql`
      INSERT INTO auth_oauth_refresh_token (id, token, client_id, user_id, scopes)
      VALUES (${`rt-${suffix}`}, ${`tok-${suffix}`}, ${clientId}, ${userId}, ${textArray(OLD_SET)})
    `);
      await db().execute(sql`
      INSERT INTO auth_oauth_access_token (id, token, client_id, user_id, scopes)
      VALUES (${`at-${suffix}`}, ${`atok-${suffix}`}, ${clientId}, ${userId}, ${textArray(OLD_SET)})
    `);
      await db().execute(sql`
      INSERT INTO auth_oauth_consent (id, client_id, user_id, scopes)
      VALUES (${`cs-${suffix}`}, ${clientId}, ${userId}, ${textArray(OLD_SET)})
    `);
      await db().execute(sql`
      INSERT INTO oauth_device_codes
        (id, device_code_hash, user_code, client_id, scope, expires_at, created_at)
      VALUES
        (${`dc-${suffix}`}, ${`h-${suffix}`}, ${`UC-${suffix}`}, ${clientId},
         'openid core.note:read capability.space_usage capability.webhooks',
         '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        (${`dc2-${suffix}`}, ${`h2-${suffix}`}, ${`UC2-${suffix}`}, ${clientId},
         'openid core.note:read',
         '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `);
      // A pending authorization code, and beside it the shape the same table
      // holds for an email verification: a bare token, not JSON.
      await db().execute(sql`
      INSERT INTO auth_verification (id, identifier, value, expires_at, created_at, updated_at)
      VALUES
        (${`v-code-${suffix}`}, ${`code-${suffix}`},
         ${JSON.stringify({
           type: "authorization_code",
           query: {
             client_id: clientId,
             scope: "openid capability.keys capability.space_settings",
           },
         })}, now(), now(), now()),
        (${`v-mail-${suffix}`}, ${`mail-${suffix}`},
         'a-plain-verification-token', now(), now(), now())
    `);
      // A live grant, a revoked one — `revokeProjectedGrant` leaves the scope
      // list verbatim on the row it flips — and an integration connection whose
      // manifest capability must not move.
      await db().execute(sql`
      INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, "timestamp")
      VALUES
        (${`grant-live-${suffix}`}, NULL, 'system.connection', 'active',
         ${JSON.stringify({ kind: "app", client_id: clientId, scopes: OLD_SET })}::jsonb,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        (${`grant-revoked-${suffix}`}, NULL, 'system.connection', 'revoked',
         ${JSON.stringify({ kind: "app", client_id: "gone", scopes: ["capability.audit_read"] })}::jsonb,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        (${`conn-${suffix}`}, NULL, 'system.connection', 'active',
         ${JSON.stringify({
           kind: "integration",
           manifest: {
             oauth_requirements: { "capability.drive.upload": "leased" },
           },
         })}::jsonb,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `);
      return { userId, clientId };
    };

    const scalar = async (query: ReturnType<typeof sql>): Promise<unknown> => {
      const rows = (await db().execute(query)) as unknown as Record<
        string,
        unknown
      >[];
      return rows[0] ? Object.values(rows[0])[0] : undefined;
    };

    it("moves every stored place, and drops the prefix on the two that stutter", async () => {
      const { clientId } = await seed("moves");

      await replay();

      for (const [table, id] of [
        ["auth_oauth_client", clientId],
        ["auth_oauth_access_token", "at-moves"],
        ["auth_oauth_refresh_token", "rt-moves"],
        ["auth_oauth_consent", "cs-moves"],
      ] as const) {
        expect(
          await scalar(
            sql`SELECT scopes FROM ${sql.identifier(table)} WHERE id = ${id}`,
          ),
          table,
        ).toEqual(NEW_SET);
      }

      expect(
        await scalar(
          sql`SELECT scope FROM oauth_device_codes WHERE id = 'dc-moves'`,
        ),
      ).toBe("openid core.note:read space.usage space.webhooks");
      expect(
        await scalar(
          sql`SELECT scope FROM oauth_device_codes WHERE id = 'dc2-moves'`,
        ),
      ).toBe("openid core.note:read");

      expect(
        await scalar(
          sql`SELECT value::jsonb->'query'->>'scope' FROM auth_verification WHERE id = 'v-code-moves'`,
        ),
      ).toBe("openid space.keys space.settings");
      // The non-JSON row in the same table is untouched, which is why the
      // rewrite goes through text rather than the JSON functions.
      expect(
        await scalar(
          sql`SELECT value FROM auth_verification WHERE id = 'v-mail-moves'`,
        ),
      ).toBe("a-plain-verification-token");

      expect(
        await scalar(
          sql`SELECT properties->'scopes' FROM items WHERE id = 'grant-live-moves'`,
        ),
      ).toEqual(NEW_SET);
      // A revoked projection still holds a scope list, and the surfaces that
      // render its history read the same names as the live ones.
      expect(
        await scalar(
          sql`SELECT properties->'scopes' FROM items WHERE id = 'grant-revoked-moves'`,
        ),
      ).toEqual(["space.audit_read"]);
    });

    it("leaves an integration manifest's capability alone", async () => {
      await seed("manifest");
      await replay();
      expect(
        await scalar(
          sql`SELECT properties->'manifest'->'oauth_requirements' FROM items WHERE id = 'conn-manifest'`,
        ),
      ).toEqual({ "capability.drive.upload": "leased" });
    });

    it("stays put on a second run", async () => {
      await seed("idempotent");
      await replay();
      await replay();
      expect(
        await scalar(
          sql`SELECT scopes FROM auth_oauth_consent WHERE id = 'cs-idempotent'`,
        ),
      ).toEqual(NEW_SET);
    });
  },
);
