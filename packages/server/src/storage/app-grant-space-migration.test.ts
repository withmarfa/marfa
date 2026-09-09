/**
 * Where an OAuth grant projection ends up, on both dialects.
 *
 * A `system.connection { kind: "app" }` row is the Marfa half of a grant.
 * Every surface that reaches it -- the security page, the revoke door, the
 * re-consent update, the audit row naming a reused grant -- looks in exactly
 * one space, the one a sign-in resolves. The keys-mode space migration left
 * these rows in the space-less bucket deliberately, because a keys-mode
 * sign-in resolved no space; it resolves the instance's one space now, so the
 * rows have to follow or every one of those surfaces misses them silently.
 *
 * Nothing else in the repository can see this. The schema suites migrate an
 * empty database and compare structure, so a body that is one `UPDATE` is
 * never watched touching a row, and the journal test never opens a `.sql`
 * file. Every case below is one where a wrong answer is quiet: rows that do
 * not move leave a person with a security page listing nothing while their
 * app keeps working, and rows that move too eagerly put a grant in a space
 * nobody chose.
 *
 * Both dialects, because the predicate is spelled differently in each --
 * `properties->>'kind'` against `json_extract(properties, '$.kind')` -- and a
 * statement that behaves in one proves nothing about the other. The Postgres
 * half needs a database it can create, so it skips where the suite was not
 * given one.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import postgres from "postgres";
import {
  runPgMigrations,
  runPgMigrationsThrough,
  runSqliteMigrations,
  runSqliteMigrationsThrough,
} from "./migrate.js";

const isPg = (process.env.DB_DIALECT ?? "sqlite") === "pg";
const adminUrl = process.env.MARFA_TEST_PG_ADMIN_URL ?? "";

const DRIZZLE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

/** The migration under test, per dialect. */
const TAG = {
  sqlite: "0095_app_grants_join_the_sole_space",
  pg: "0109_app_grants_join_the_sole_space",
} as const;

/**
 * The entry immediately before the migration, read from the journal rather
 * than spelled out again: renumbering something earlier should not need an
 * edit here, while the migration's own tag is what this test is about.
 */
function tagBefore(dialect: "pg" | "sqlite"): string {
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE_ROOT, dialect, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === TAG[dialect]);
  expect(at, `${TAG[dialect]} is in the ${dialect} journal`).toBeGreaterThan(0);
  return journal.entries[at - 1]!.tag;
}

const NOW = "2026-01-02T03:04:05.000Z";
const SOLE = "01996d00-0000-7000-8000-0000000000aa";
const OTHER = "01996d00-0000-7000-8000-0000000000bb";

/** A grant projection as the consent path writes one. */
function grantProps(clientId: string, userId: string): string {
  return JSON.stringify({
    kind: "app",
    status: "active",
    client_id: clientId,
    user_id: userId,
    scopes: ["core.note:read"],
    granted_at: NOW,
  });
}

describe.skipIf(isPg)("the SQLite app-grant space migration", () => {
  const workDir = mkdtempSync(join(tmpdir(), "marfa-app-grant-space-"));
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /**
   * A database migrated to the statement before this one, so every row seeded
   * into it predates the migration -- which is the only shape that can
   * observe what the migration does.
   */
  async function seeded(
    name: string,
    seed: (c: ReturnType<typeof createClient>) => Promise<void>,
  ): Promise<ReturnType<typeof createClient>> {
    const dbPath = join(workDir, `${name}.db`);
    await runSqliteMigrationsThrough(dbPath, tagBefore("sqlite"));
    const client = createClient({ url: `file:${dbPath}` });
    await seed(client);
    await runSqliteMigrations(dbPath);
    return client;
  }

  async function insertSpace(
    client: ReturnType<typeof createClient>,
    id: string,
  ): Promise<void> {
    await client.execute({
      sql: `INSERT INTO spaces (id, name, created_at, status) VALUES (?, ?, ?, 'active')`,
      args: [id, id.slice(-2), NOW],
    });
  }

  async function insertItem(
    client: ReturnType<typeof createClient>,
    row: {
      id: string;
      space_id: string | null;
      type: string;
      properties: string;
      state?: string;
    },
  ): Promise<void> {
    await client.execute({
      sql: `INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.id,
        row.space_id,
        row.type,
        row.state ?? "active",
        row.properties,
        NOW,
        NOW,
        NOW,
      ],
    });
  }

  const spaceOf = async (
    client: ReturnType<typeof createClient>,
    id: string,
  ): Promise<string | null> => {
    const res = await client.execute({
      sql: "SELECT space_id FROM items WHERE id = ?",
      args: [id],
    });
    return (res.rows[0]!.space_id as string | null) ?? null;
  };

  it("moves a space-less grant into the instance's one space", async () => {
    // The case the migration exists for: a keys-mode instance whose grants
    // were all written space-less, and whose sign-ins now resolve the one
    // space it has. Without the move the security page lists nothing, the
    // revoke door 404s, and the next consent inserts a duplicate beside a row
    // nobody can see.
    const client = await seeded("keys-mode-grant", async (c) => {
      await insertSpace(c, SOLE);
      await insertItem(c, {
        id: "grant",
        space_id: null,
        type: "system.connection",
        properties: grantProps("app-1", "user-1"),
      });
    });
    expect(await spaceOf(client, "grant")).toBe(SOLE);
  });

  it("leaves the manifest catalogue where it is", async () => {
    // The other space-less `items` row, and the one that is space-less on
    // purpose: a `system.integration` row is read through the deliberate
    // "this space or none" widening so one registration is visible
    // everywhere. A predicate keyed on the type alone would sweep it up.
    const client = await seeded("catalogue", async (c) => {
      await insertSpace(c, SOLE);
      await insertItem(c, {
        id: "catalogue",
        space_id: null,
        type: "system.integration",
        properties: "{}",
      });
    });
    expect(await spaceOf(client, "catalogue")).toBeNull();
  });

  it("moves nothing on an instance holding more than one space", async () => {
    // Two spaces is the state issuance itself declines to answer, because
    // choosing between them means binding somebody's grant to whichever row
    // came back first. A migration is in no better position.
    const client = await seeded("two-spaces", async (c) => {
      await insertSpace(c, SOLE);
      await insertSpace(c, OTHER);
      await insertItem(c, {
        id: "grant",
        space_id: null,
        type: "system.connection",
        properties: grantProps("app-1", "user-1"),
      });
    });
    expect(await spaceOf(client, "grant")).toBeNull();
  });

  it("moves nothing on an instance with no space at all", async () => {
    const client = await seeded("no-space", async (c) => {
      await insertItem(c, {
        id: "grant",
        space_id: null,
        type: "system.connection",
        properties: grantProps("app-1", "user-1"),
      });
    });
    expect(await spaceOf(client, "grant")).toBeNull();
  });

  it("leaves a stale grant where a standing one for the same app and person already sits", async () => {
    // Reachable where somebody consented before their account had a space and
    // again afterwards. Two active projections for one grant in one space
    // would leave the lookup taking whichever came first, so a revoke could
    // end the record the person is not looking at. The stale row confers
    // nothing -- its tokens carry no space and are refused on every request.
    const client = await seeded("duplicate", async (c) => {
      await insertSpace(c, SOLE);
      await insertItem(c, {
        id: "standing",
        space_id: SOLE,
        type: "system.connection",
        properties: grantProps("app-1", "user-1"),
      });
      await insertItem(c, {
        id: "stale",
        space_id: null,
        type: "system.connection",
        properties: grantProps("app-1", "user-1"),
      });
      // A different person's grant to the same app is not the same grant, so
      // it moves. Seeded alongside so the exclusion cannot be a blanket one.
      await insertItem(c, {
        id: "other-person",
        space_id: null,
        type: "system.connection",
        properties: grantProps("app-1", "user-2"),
      });
    });
    expect(await spaceOf(client, "stale")).toBeNull();
    expect(await spaceOf(client, "standing")).toBe(SOLE);
    expect(await spaceOf(client, "other-person")).toBe(SOLE);
  });
});

describe.skipIf(!isPg || !adminUrl)(
  "the Postgres app-grant space migration",
  () => {
    const dbName = `marfa_app_grant_space_${Math.random().toString(36).slice(2, 10)}`;
    let admin: postgres.Sql | null = null;
    const created: string[] = [];

    afterAll(async () => {
      if (!admin) return;
      for (const name of created) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
      await admin.end({ timeout: 5 });
    });

    /** A fresh database migrated to the statement before this one. */
    async function freshUrl(suffix: string): Promise<string> {
      admin ??= postgres(adminUrl, { max: 1, onnotice: () => undefined });
      const name = `${dbName}_${suffix}`;
      created.push(name);
      await admin.unsafe(`CREATE DATABASE ${name}`);
      const url = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
      await runPgMigrationsThrough(url, tagBefore("pg"));
      return url;
    }

    async function withDb(
      suffix: string,
      body: (sql: postgres.Sql, url: string) => Promise<void>,
    ): Promise<void> {
      const url = await freshUrl(suffix);
      const sql = postgres(url, { max: 2, onnotice: () => undefined });
      try {
        await body(sql, url);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }

    const spaceOf = async (
      sql: postgres.Sql,
      id: string,
    ): Promise<string | null> => {
      const rows = await sql<{ space_id: string | null }[]>`
        SELECT space_id FROM items WHERE id = ${id}
      `;
      return rows[0]!.space_id;
    };

    it("moves a space-less grant into the instance's one space", async () => {
      await withDb("keys-mode-grant", async (sql, url) => {
        await sql`INSERT INTO spaces (id, name, created_at, status) VALUES (${SOLE}, 'sole', ${NOW}, 'active')`;
        await sql`
          INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
          VALUES ('grant', NULL, 'system.connection', 'active',
                  ${grantProps("app-1", "user-1")}::jsonb, ${NOW}, ${NOW}, ${NOW})
        `;
        await runPgMigrations(url);
        expect(await spaceOf(sql, "grant")).toBe(SOLE);
      });
    });

    it("leaves the manifest catalogue where it is", async () => {
      await withDb("catalogue", async (sql, url) => {
        await sql`INSERT INTO spaces (id, name, created_at, status) VALUES (${SOLE}, 'sole', ${NOW}, 'active')`;
        await sql`
          INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
          VALUES ('catalogue', NULL, 'system.integration', 'active', '{}'::jsonb, ${NOW}, ${NOW}, ${NOW})
        `;
        await runPgMigrations(url);
        expect(await spaceOf(sql, "catalogue")).toBeNull();
      });
    });

    it("moves nothing on an instance holding more than one space", async () => {
      await withDb("two-spaces", async (sql, url) => {
        await sql`INSERT INTO spaces (id, name, created_at, status) VALUES (${SOLE}, 'sole', ${NOW}, 'active')`;
        await sql`INSERT INTO spaces (id, name, created_at, status) VALUES (${OTHER}, 'other', ${NOW}, 'active')`;
        await sql`
          INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
          VALUES ('grant', NULL, 'system.connection', 'active',
                  ${grantProps("app-1", "user-1")}::jsonb, ${NOW}, ${NOW}, ${NOW})
        `;
        await runPgMigrations(url);
        expect(await spaceOf(sql, "grant")).toBeNull();
      });
    });

    it("moves nothing on an instance with no space at all", async () => {
      await withDb("no-space", async (sql, url) => {
        await sql`
          INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
          VALUES ('grant', NULL, 'system.connection', 'active',
                  ${grantProps("app-1", "user-1")}::jsonb, ${NOW}, ${NOW}, ${NOW})
        `;
        await runPgMigrations(url);
        expect(await spaceOf(sql, "grant")).toBeNull();
      });
    });

    it("leaves a stale grant where a standing one for the same app and person already sits", async () => {
      await withDb("duplicate", async (sql, url) => {
        await sql`INSERT INTO spaces (id, name, created_at, status) VALUES (${SOLE}, 'sole', ${NOW}, 'active')`;
        await sql`
          INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
          VALUES ('standing', ${SOLE}, 'system.connection', 'active',
                  ${grantProps("app-1", "user-1")}::jsonb, ${NOW}, ${NOW}, ${NOW})
        `;
        await sql`
          INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
          VALUES ('stale', NULL, 'system.connection', 'active',
                  ${grantProps("app-1", "user-1")}::jsonb, ${NOW}, ${NOW}, ${NOW})
        `;
        await sql`
          INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
          VALUES ('other-person', NULL, 'system.connection', 'active',
                  ${grantProps("app-1", "user-2")}::jsonb, ${NOW}, ${NOW}, ${NOW})
        `;
        await runPgMigrations(url);
        expect(await spaceOf(sql, "stale")).toBeNull();
        expect(await spaceOf(sql, "standing")).toBe(SOLE);
        expect(await spaceOf(sql, "other-person")).toBe(SOLE);
      });
    });
  },
);
