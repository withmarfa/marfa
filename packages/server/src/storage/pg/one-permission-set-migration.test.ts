/**
 * The Postgres half of the one-model migration (0104).
 *
 * This is the dialect the deployments run, and the two halves are shaped
 * differently enough that one proves nothing about the other: Postgres alters
 * the table in place and adds the constraint with `ALTER TABLE`, while SQLite
 * rebuilds the table and carries the stamp inside the copying `SELECT`. Both
 * are replayed against a real database.
 *
 * **The property under test is that no credential loses reach it had.** A key
 * whose role admitted it past its permission maps was reaching everything in
 * its space whatever those maps said, so the criterion is the role rather than
 * the maps. `partial-maps` is the row that makes the difference visible.
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
  join(
    __dirname,
    "../../../drizzle/pg/0104_one_permission_set_per_credential.sql",
  ),
  "utf8",
);

const ELEVEN = [
  "space.webhooks",
  "space.connections",
  "space.schema",
  "space.usage",
  "space.settings",
  "space.audit_read",
  "space.item_purge",
  "space.upstream_access",
  "space.credentials",
  "space.keys",
  "space.app_grants",
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

describe.skipIf(!isPg)("0104 one permission set per credential", () => {
  const db = (): PgDb => ctx.storage.pgDb as PgDb;

  /** The live schema has already run 0104, so the replay needs the shape the
   *  migration expects to meet. Rebuilt on a schema of its own rather than
   *  against `public`, so the suite's own tables are untouched. */
  const rebuildPreMigrationShape = async () => {
    await db().execute(
      sql.raw(`
      DROP SCHEMA IF EXISTS replay CASCADE;
      CREATE SCHEMA replay;
      CREATE TABLE replay.api_keys (
        id text PRIMARY KEY,
        space_id text,
        key_hash text NOT NULL,
        label text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        source text NOT NULL DEFAULT '',
        default_tier text NOT NULL DEFAULT 'library',
        is_platform boolean NOT NULL DEFAULT false,
        is_runtime_credential boolean NOT NULL DEFAULT false,
        scope_enforced boolean NOT NULL DEFAULT false,
        connection_id text,
        item_source text,
        type_permissions text NOT NULL DEFAULT '{"*":"write"}',
        extension_permissions text NOT NULL DEFAULT '{}',
        edge_permissions text NOT NULL DEFAULT '{}',
        metadata_permissions text NOT NULL DEFAULT '{}',
        created_at text NOT NULL,
        expires_at text,
        revoked_at text,
        last_used_at text
      );
      CREATE TABLE replay.users (
        id text PRIMARY KEY, space_id text NOT NULL, role text NOT NULL DEFAULT 'member'
      );
      INSERT INTO replay.users VALUES ('u1', 's1', 'space_admin');
      INSERT INTO replay.api_keys
        (id, space_id, key_hash, label, role, source, is_platform,
         is_runtime_credential, scope_enforced, type_permissions,
         edge_permissions, created_at, revoked_at)
      VALUES
        ('empty-maps',        's1',  'h1', 'l', 'space_admin',    'empty-maps',   false, false, false, '{}',                    '{}', '2026-01-01T00:00:00.000Z', NULL),
        ('partial-maps',      's1',  'h2', 'l', 'space_admin',    'partial-maps', false, false, false, '{"*":"write"}',         '{}', '2026-01-01T00:00:00.000Z', NULL),
        ('runtime',           's1',  'h3', 'l', 'member',         'runtime',      false, true,  false, '{"core.note":"write"}', '{}', '2026-01-01T00:00:00.000Z', NULL),
        ('from-session',      's1',  'h4', 'l', 'space_admin',    'from-session', false, false, true,  '{"core.note":"read"}',  '{}', '2026-01-01T00:00:00.000Z', NULL),
        ('operator',          NULL,  'h5', 'l', 'instance_admin', 'operator',     true,  false, false, '{}',                    '{}', '2026-01-01T00:00:00.000Z', NULL),
        ('keys-mode-admin',   NULL,  'h9', 'l', 'space_admin',    'keys-mode',    false, false, false, '{}',                    '{}', '2026-01-01T00:00:00.000Z', NULL),
        ('revoked-keys-mode', NULL,  'h6', 'l', 'member',         'revoked-keys', false, false, false, '{}',                    '{}', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
        ('revoked-escalate',  's1',  'h8', 'l', 'instance_admin', 'revoked-esc',  true,  false, false, '{}',                    '{}', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
        ('revoked-sound',     's1',  'h7', 'l', 'space_admin',    'revoked-ok',   false, false, false, '{}',                    '{}', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    `),
    );
  };

  /** Statement by statement, stripping comments, with the table names pointed
   *  at the replay schema so the live ones are never touched. */
  const replay = async () => {
    for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
      const s = stmt
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .trim()
        .replace(/"api_keys"/g, "replay.api_keys")
        .replace(/"users"/g, "replay.users")
        .replace(/\bFROM api_keys\b/g, "FROM replay.api_keys");
      if (s.length > 0) await db().execute(sql.raw(s));
    }
  };

  const rows = async (query: string): Promise<Record<string, unknown>[]> =>
    await db().execute(sql.raw(query));

  beforeAll(async () => {
    if (!isPg) return;
    await rebuildPreMigrationShape();
    await replay();
  });

  it("stamps every key the role bypass admitted, and only those", async () => {
    const all = await rows(
      `SELECT id, space_permissions, type_permissions, edge_permissions,
              metadata_permissions, extension_permissions, profile_permissions
         FROM replay.api_keys ORDER BY id`,
    );
    const byId = new Map(all.map((r) => [String(r.id), r]));

    for (const id of ["empty-maps", "partial-maps"]) {
      const row = byId.get(id);
      expect(JSON.parse(String(row?.space_permissions)), id).toEqual(ELEVEN);
      for (const map of [
        "type_permissions",
        "edge_permissions",
        "metadata_permissions",
        "extension_permissions",
        "profile_permissions",
      ]) {
        expect(row?.[map], `${id}.${map}`).toBe('{"*":"write"}');
      }
    }

    // A runtime credential keeps exactly its manifest bounds and holds no
    // space permission: its whole reach is what the manifest declared.
    expect(byId.get("runtime")?.type_permissions).toBe('{"core.note":"write"}');
    expect(JSON.parse(String(byId.get("runtime")?.space_permissions))).toEqual(
      [],
    );
    // A key minted through a sign-in was already held to its maps.
    expect(byId.get("from-session")?.type_permissions).toBe(
      '{"core.note":"read"}',
    );
    expect(
      JSON.parse(String(byId.get("from-session")?.space_permissions)),
    ).toEqual([]);
    // The operator key takes nothing: the instance tier is fenced off the model.
    expect(byId.get("operator")?.type_permissions).toBe("{}");
    expect(JSON.parse(String(byId.get("operator")?.space_permissions))).toEqual(
      [],
    );

    // **A keys-mode working key is stamped, and the pair above is what makes
    // that mean something.** Both rows are space-less; only the operator flag
    // separates them, so a criterion keyed on the space binding would have
    // stamped neither and left such an instance reaching nothing.
    expect(byId.get("keys-mode-admin")?.type_permissions).toBe('{"*":"write"}');
    expect(
      JSON.parse(String(byId.get("keys-mode-admin")?.space_permissions)),
    ).toEqual(ELEVEN);
  });

  it("clears only the revoked rows the constraint would refuse", async () => {
    const ids = (await rows(`SELECT id FROM replay.api_keys ORDER BY id`)).map(
      (r) => String(r.id),
    );
    // Space-bound and claiming the instance tier, so the constraint below
    // would refuse it and the migration would fail on it.
    expect(ids).not.toContain("revoked-escalate");
    expect(ids).toContain("revoked-sound");
    // Space-less and not an operator key: every credential on a keys-mode
    // instance has this shape, so a wider delete would take that instance's
    // whole revoked-key history.
    expect(ids).toContain("revoked-keys-mode");
  });

  it("makes the escalation shape unrepresentable, and leaves keys mode alone", async () => {
    const insert = (id: string, space: string | null, operator: boolean) =>
      db().execute(sql`
        INSERT INTO replay.api_keys (id, space_id, key_hash, label, source, is_operator, created_at)
        VALUES (${id}, ${space}, ${id}, 'l', 'probe', ${operator}, '2026-01-01T00:00:00.000Z')
      `);
    // The instance tier is the absence of a space binding, so a key claiming
    // it while bound to a space asks to be judged by both rules at once.
    await expect(insert("probe-bound-operator", "s1", true)).rejects.toThrow();
    await expect(insert("probe-operator", null, true)).resolves.toBeDefined();
    await expect(
      insert("probe-space-bound", "s1", false),
    ).resolves.toBeDefined();
    // Keys mode binds nothing to a space and its credentials are not operator
    // keys, so the equivalence waits for the change that gives it a real one.
    await expect(insert("probe-keys-mode", null, false)).resolves.toBeDefined();
  });

  it("leaves no role or scope_enforced column behind", async () => {
    const cols = async (table: string) =>
      (
        await rows(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'replay' AND table_name = '${table}'`,
        )
      ).map((r) => String(r.column_name));
    const keyCols = await cols("api_keys");
    expect(keyCols).not.toContain("role");
    expect(keyCols).not.toContain("scope_enforced");
    expect(keyCols).not.toContain("is_platform");
    expect(keyCols).toContain("is_operator");
    expect(keyCols).toContain("space_permissions");
    expect(keyCols).toContain("oauth_client_id");
    expect(keyCols).toContain("profile_permissions");
    expect(await cols("users")).not.toContain("role");
  });
});
