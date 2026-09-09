/**
 * What the keys-mode space migration does to rows, on both dialects.
 *
 * The migration provisions a space where an instance has none but has data
 * that needs one, moves fifteen tables onto it, drops revoked space-less
 * ordinary keys, and tightens the `api_keys` constraint from an implication
 * to an equivalence. Nothing else in the repository can observe any of that:
 * the schema suites apply every migration to an empty database and compare
 * structure, so a body of `UPDATE ... WHERE space_id IS NULL` is never seen
 * touching anything, and the journal test never opens a `.sql` file.
 *
 * The cases below are the ones where a wrong answer is silent. A gate that
 * misses an instance leaves its registered types stranded in the space-less
 * bucket, where they stop resolving for a caller that now holds a space id —
 * green everywhere, and an unknown-type error on the first write afterwards.
 * A gate that fires on a row the move then skips provisions a Default space
 * with nothing in it. A collision on a unique index aborts the whole
 * transaction with a message naming an index, which is not something a
 * self-hoster can act on. And the constraint has to refuse the one row it is
 * for — a live space-less ordinary credential — rather than quietly keeping
 * it.
 *
 * Both dialects, because both carry the statements and more than the quoting
 * differs: the SQLite half additionally collapses duplicate space-less bulk
 * jobs, which Postgres cannot hold. The Postgres half needs a database it can
 * create, so it skips where the suite was not given one.
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
  sqlite: "0091_keys_mode_gets_a_space",
  pg: "0105_keys_mode_gets_a_space",
} as const;

/** The id the migration provisions at, spelled out in both `.sql` bodies. */
const PROVISIONED = "01996d00-0000-7000-8000-000000000001";

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

describe.skipIf(isPg)("the SQLite keys-mode space migration", () => {
  const workDir = mkdtempSync(join(tmpdir(), "marfa-keys-mode-space-"));
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /**
   * A database migrated to the statement before this one, so every row
   * seeded into it predates the migration — which is the only shape that can
   * observe what the migration does.
   */
  async function seeded(
    name: string,
    seed: (c: ReturnType<typeof createClient>) => Promise<void>,
  ): Promise<ReturnType<typeof createClient>> {
    const dbPath = join(workDir, `${name}.db`);
    await runSqliteMigrationsThrough(dbPath, tagBefore("sqlite"));
    const client = createClient({ url: `file:${dbPath}` });
    // The premise: no space yet, so "a space appeared" means this migration
    // put it there. Without it the test would pass against a chain that had
    // already run.
    const before = await client.execute("SELECT COUNT(*) AS n FROM spaces");
    expect(Number(before.rows[0]!.n)).toBe(0);
    await seed(client);
    await runSqliteMigrations(dbPath);
    return client;
  }

  async function insertKey(
    client: ReturnType<typeof createClient>,
    row: {
      id: string;
      space_id: string | null;
      is_operator: 0 | 1;
      source: string;
      revoked_at?: string | null;
    },
  ): Promise<void> {
    await client.execute({
      sql: `INSERT INTO api_keys
              (id, space_id, key_hash, label, source, is_operator, created_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.id,
        row.space_id,
        `hash-${row.id}`,
        row.id,
        row.source,
        row.is_operator,
        NOW,
        row.revoked_at ?? null,
      ],
    });
  }

  it("provisions for an instance whose only data is its own registered types", async () => {
    // The case two signals missed. This instance never held an ordinary key
    // — the bootstrap key admitted itself past every map under the old model
    // — and its only space-less items are the manifest catalogue, which the
    // move deliberately leaves alone. Its registered types are real data and
    // stop resolving the moment a caller holds a space id.
    const client = await seeded("registered-types-only", async (c) => {
      await insertKey(c, {
        id: "operator",
        space_id: null,
        is_operator: 1,
        source: "bootstrap",
      });
      await c.execute({
        sql: `INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
              VALUES ('catalogue', NULL, 'system.integration', 'active', '{}', ?, ?, ?)`,
        args: [NOW, NOW, NOW],
      });
      await c.execute({
        sql: `INSERT INTO custom_types (space_id, id, schema, origin, created_at, updated_at)
              VALUES ('', 'my.recipe', '{}', 'user', ?, ?)`,
        args: [NOW, NOW],
      });
    });

    const spaces = await client.execute("SELECT id FROM spaces");
    expect(spaces.rows.map((r) => r.id as string)).toEqual([PROVISIONED]);

    const types = await client.execute(
      "SELECT space_id FROM custom_types WHERE id = 'my.recipe'",
    );
    expect(types.rows[0]!.space_id).toBe(PROVISIONED);

    // The catalogue row is the discriminator, and it stays where it is: one
    // registration is meant to be visible from every space.
    const catalogue = await client.execute(
      "SELECT space_id FROM items WHERE id = 'catalogue'",
    );
    expect(catalogue.rows[0]!.space_id).toBeNull();
  });

  it("does not provision for an instance holding only an OAuth grant projection", async () => {
    // A `system.connection` with `kind = 'app'` is a grant projection, and
    // this migration's move excludes it. The gate has to exclude it too:
    // firing on a row the move then skips would create a Default space and
    // put nothing in it. A projection is not by itself a reason to invent a
    // space -- the later `app_grants_join_the_sole_space` moves one into a
    // space that already exists, and moves nothing where there is none.
    const client = await seeded("grant-projection-only", async (c) => {
      await insertKey(c, {
        id: "operator",
        space_id: null,
        is_operator: 1,
        source: "bootstrap",
      });
      await c.execute({
        sql: `INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
              VALUES ('grant', NULL, 'system.connection', 'active', '{"kind":"app"}', ?, ?, ?)`,
        args: [NOW, NOW, NOW],
      });
    });

    const spaces = await client.execute("SELECT COUNT(*) AS n FROM spaces");
    expect(Number(spaces.rows[0]!.n)).toBe(0);
    const grant = await client.execute(
      "SELECT space_id FROM items WHERE id = 'grant'",
    );
    expect(grant.rows[0]!.space_id).toBeNull();
  });

  /**
   * One row in one table, per arm of the provision gate.
   *
   * Each arm is a whole class of instance that would otherwise get no space,
   * and a table-driven case per arm is what makes dropping any single one
   * redden. A test seeding two arms at once passes with either removed.
   */
  const GATE_ARMS: { name: string; seed: string; args?: string[] }[] = [
    {
      name: "a registered type of its own",
      seed: `INSERT INTO custom_types (space_id, id, schema, origin, created_at, updated_at)
             VALUES ('', 'my.recipe', '{}', 'user', ?, ?)`,
      args: [NOW, NOW],
    },
    {
      name: "a custom edge type",
      seed: `INSERT INTO custom_edge_types (space_id, id, schema, created_at, updated_at)
             VALUES ('', 'my.cites', '{}', ?, ?)`,
      args: [NOW, NOW],
    },
    {
      name: "an outbound webhook",
      seed: `INSERT INTO outbound_webhooks (id, space_id, url, secret, events, created_at, updated_at)
             VALUES ('w1', NULL, 'https://example.test/hook', 's', '[]', ?, ?)`,
      args: [NOW, NOW],
    },
    {
      name: "an item of its own",
      seed: `INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
             VALUES ('note', NULL, 'core.note', 'active', '{}', ?, ?, ?)`,
      args: [NOW, NOW, NOW],
    },
    {
      name: "a live ordinary key",
      seed: `INSERT INTO api_keys (id, space_id, key_hash, label, source, is_operator, created_at)
             VALUES ('working', NULL, 'h', 'working', 'cli', 0, ?)`,
      args: [NOW],
    },
  ];

  for (const arm of GATE_ARMS) {
    it(`provisions for an instance holding ${arm.name}`, async () => {
      const client = await seeded(
        `arm-${arm.name.replace(/\W+/g, "-")}`,
        async (c) => {
          await insertKey(c, {
            id: "operator",
            space_id: null,
            is_operator: 1,
            source: "bootstrap",
          });
          await c.execute({ sql: arm.seed, args: arm.args ?? [] });
        },
      );
      const spaces = await client.execute("SELECT id FROM spaces");
      expect(spaces.rows.map((r) => r.id as string)).toEqual([PROVISIONED]);
    });
  }

  it("leaves the bulk-job history of an instance it is not moving alone", async () => {
    // The dedupe is the one destructive statement here, and a hosted instance
    // gets no space and no move — so it must get no delete either. Without
    // the guard this ran anywhere, on rows nothing was about to collide.
    const dbPath = join(workDir, "hosted-bulk.db");
    await runSqliteMigrationsThrough(dbPath, tagBefore("sqlite"));
    const client = createClient({ url: `file:${dbPath}` });
    await client.execute({
      sql: `INSERT INTO spaces (id, name, created_at) VALUES ('space-a', 'A', ?)`,
      args: [NOW],
    });
    for (const [id, created] of [
      ["hosted-first", "2026-01-01T00:00:00.000Z"],
      ["hosted-replay", "2026-01-01T00:00:01.000Z"],
    ] as [string, string][]) {
      await client.execute({
        sql: `INSERT INTO bulk_action_jobs
                (id, space_id, status, action, input, matched_ids, idempotency_key, created_at)
              VALUES (?, NULL, 'queued', 'tag', '{}', '[]', 'retry-42', ?)`,
        args: [id, created],
      });
    }

    await runSqliteMigrations(dbPath);

    const jobs = await client.execute(
      "SELECT id FROM bulk_action_jobs ORDER BY id",
    );
    expect(jobs.rows.map((r) => r.id as string)).toEqual([
      "hosted-first",
      "hosted-replay",
    ]);
  });

  it("collapses duplicate space-less bulk jobs rather than aborting on the index", async () => {
    // `idx_bulk_action_jobs_idempotency` is UNIQUE on (space_id,
    // idempotency_key) with NULLs distinct, and the upsert's conflict target
    // therefore never matches while every job is space-less — so two replays
    // of one key are representable here in a way Postgres has not allowed
    // since 0061. Moving them onto one space is what makes them collide.
    const client = await seeded("bulk-replays", async (c) => {
      await insertKey(c, {
        id: "worker",
        space_id: null,
        is_operator: 0,
        source: "worker",
      });
      const replays: [string, string][] = [
        ["job-first", "2026-01-01T00:00:00.000Z"],
        ["job-replay", "2026-01-01T00:00:01.000Z"],
      ];
      for (const [id, created] of replays) {
        await c.execute({
          sql: `INSERT INTO bulk_action_jobs
                  (id, space_id, status, action, input, matched_ids, idempotency_key, created_at)
                VALUES (?, NULL, 'queued', 'tag', '{}', '[]', 'retry-42', ?)`,
          args: [id, created],
        });
      }
    });

    const jobs = await client.execute(
      "SELECT id, space_id FROM bulk_action_jobs ORDER BY id",
    );
    // The newest survives, because it is the one a caller replaying the key
    // would have been served.
    expect(jobs.rows.map((r) => r.id as string)).toEqual(["job-replay"]);
    expect(jobs.rows[0]!.space_id).toBe(PROVISIONED);
  });

  it("keeps one row per key on a tie, and leaves a keyless job alone", async () => {
    // Two things the happy case cannot see. Two replays in the same
    // millisecond are ordinary for a retry loop, and both surviving would
    // abort the migration on the index this collapse exists to clear. A job
    // with no `Idempotency-Key` is outside that index entirely and is a
    // duplicate of nothing.
    //
    // A space-bound row sharing a key with a space-less one is deliberately
    // not covered, because it cannot be built: the collapse runs only where a
    // space was just provisioned, which requires the instance to have had
    // none, so every job in the table at that moment is space-less. The
    // `space_id IS NULL` clause is belt and braces over a guard that already
    // holds.
    const client = await seeded("bulk-edges", async (c) => {
      await insertKey(c, {
        id: "worker",
        space_id: null,
        is_operator: 0,
        source: "worker",
      });
      const rows: [string, string | null, string][] = [
        ["tie-a", "retry-1", "2026-01-01T00:00:00.000Z"],
        ["tie-b", "retry-1", "2026-01-01T00:00:00.000Z"],
        ["tie-c", "retry-1", "2026-01-01T00:00:00.000Z"],
        ["keyless-a", null, NOW],
        ["keyless-b", null, NOW],
      ];
      for (const [id, key, created] of rows) {
        await c.execute({
          sql: `INSERT INTO bulk_action_jobs
                  (id, space_id, status, action, input, matched_ids, idempotency_key, created_at)
                VALUES (?, NULL, 'queued', 'tag', '{}', '[]', ?, ?)`,
          args: [id, key, created],
        });
      }
    });

    const jobs = await client.execute(
      "SELECT id, space_id FROM bulk_action_jobs ORDER BY id",
    );
    const ids = jobs.rows.map((r) => r.id as string);
    expect(ids).toContain("keyless-a");
    expect(ids).toContain("keyless-b");
    expect(ids.filter((id) => id.startsWith("tie-"))).toHaveLength(1);
    expect(ids).toHaveLength(3);
    // Everything that survived moved.
    expect(jobs.rows.every((r) => r.space_id === PROVISIONED)).toBe(true);
  });

  it("moves a keys-mode instance's rows, revoked ones included, and keeps only the operator key space-less", async () => {
    const client = await seeded("keys-mode", async (c) => {
      await insertKey(c, {
        id: "operator",
        space_id: null,
        is_operator: 1,
        source: "bootstrap",
      });
      await insertKey(c, {
        id: "working",
        space_id: null,
        is_operator: 0,
        source: "cli",
      });
      await insertKey(c, {
        id: "retired",
        space_id: null,
        is_operator: 0,
        source: "old-cli",
        revoked_at: NOW,
      });
      await c.execute({
        sql: `INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
              VALUES ('note', NULL, 'core.note', 'active', '{}', ?, ?, ?)`,
        args: [NOW, NOW, NOW],
      });
    });

    const keys = await client.execute(
      "SELECT id, space_id, is_operator FROM api_keys ORDER BY id",
    );
    expect(
      keys.rows.map((r) => [r.id, r.space_id, Number(r.is_operator)]),
    ).toEqual([
      ["operator", null, 1],
      // The revoked one moves rather than being dropped, and the two halves
      // of that are one rule: a space-less ordinary key is deleted only where
      // its space cannot be known. Here it can — the instance has exactly one
      // and this row belongs to it — so the delete's guard is the absence of
      // the provisioned space, and the hosted case below is where it bites.
      ["retired", PROVISIONED, 0],
      ["working", PROVISIONED, 0],
    ]);

    const note = await client.execute(
      "SELECT space_id FROM items WHERE id = 'note'",
    );
    expect(note.rows[0]!.space_id).toBe(PROVISIONED);
  });

  it("refuses a hosted instance still holding a live space-less ordinary key", async () => {
    // The one shape a migration must not paper over: a credential somebody
    // may still be using, whose space cannot be guessed. Aborting is the
    // right answer, and it needs a person.
    const dbPath = join(workDir, "live-space-less.db");
    await runSqliteMigrationsThrough(dbPath, tagBefore("sqlite"));
    const client = createClient({ url: `file:${dbPath}` });
    await client.execute({
      sql: `INSERT INTO spaces (id, name, created_at) VALUES ('space-a', 'A', ?)`,
      args: [NOW],
    });
    await insertKey(client, {
      id: "stray",
      space_id: null,
      is_operator: 0,
      source: "stray",
    });

    await expect(runSqliteMigrations(dbPath)).rejects.toThrow();

    // The transaction rolled back, so the row is still there for whoever has
    // to decide what it belongs to.
    const after = await client.execute(
      "SELECT space_id FROM api_keys WHERE id = 'stray'",
    );
    expect(after.rows[0]!.space_id).toBeNull();
  });
});

describe.skipIf(!isPg || !adminUrl)(
  "the Postgres keys-mode space migration",
  () => {
    const dbName = `marfa_keys_mode_space_${Math.random().toString(36).slice(2, 10)}`;
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

    it("provisions for an instance whose only data is its own registered types", async () => {
      const url = await freshUrl("types");
      const sql = postgres(url, { max: 2, onnotice: () => undefined });
      try {
        const before = await sql<
          { n: string }[]
        >`SELECT COUNT(*)::text AS n FROM spaces`;
        expect(Number(before[0]!.n)).toBe(0);

        await sql`
        INSERT INTO api_keys (id, space_id, key_hash, label, source, is_operator, created_at)
        VALUES ('operator', NULL, 'h', 'operator', 'bootstrap', true, ${NOW})
      `;
        await sql`
        INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
        VALUES ('catalogue', NULL, 'system.integration', 'active', '{}'::jsonb, ${NOW}, ${NOW}, ${NOW})
      `;
        await sql`
        INSERT INTO custom_types (space_id, id, schema, origin, created_at, updated_at)
        VALUES ('', 'my.recipe', '{}'::jsonb, 'user', ${NOW}, ${NOW})
      `;

        await runPgMigrations(url);

        const spaces = await sql<{ id: string }[]>`SELECT id FROM spaces`;
        expect(spaces.map((r) => r.id)).toEqual([PROVISIONED]);
        const types = await sql<{ space_id: string }[]>`
        SELECT space_id FROM custom_types WHERE id = 'my.recipe'
      `;
        expect(types[0]!.space_id).toBe(PROVISIONED);
        const catalogue = await sql<{ space_id: string | null }[]>`
        SELECT space_id FROM items WHERE id = 'catalogue'
      `;
        expect(catalogue[0]!.space_id).toBeNull();
      } finally {
        await sql.end({ timeout: 5 });
      }
    });

    it("does not provision for an instance holding only an OAuth grant projection", async () => {
      const url = await freshUrl("grant");
      const sql = postgres(url, { max: 2, onnotice: () => undefined });
      try {
        await sql`
        INSERT INTO api_keys (id, space_id, key_hash, label, source, is_operator, created_at)
        VALUES ('operator', NULL, 'h', 'operator', 'bootstrap', true, ${NOW})
      `;
        await sql`
        INSERT INTO items (id, space_id, type, state, properties, created_at, updated_at, timestamp)
        VALUES ('grant', NULL, 'system.connection', 'active', '{"kind":"app"}'::jsonb, ${NOW}, ${NOW}, ${NOW})
      `;

        await runPgMigrations(url);

        const spaces = await sql<
          { n: string }[]
        >`SELECT COUNT(*)::text AS n FROM spaces`;
        expect(Number(spaces[0]!.n)).toBe(0);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });

    it("refuses a hosted instance still holding a live space-less ordinary key", async () => {
      const url = await freshUrl("stray");
      const sql = postgres(url, { max: 2, onnotice: () => undefined });
      try {
        await sql`INSERT INTO spaces (id, name, created_at) VALUES ('space-a', 'A', ${NOW})`;
        await sql`
        INSERT INTO api_keys (id, space_id, key_hash, label, source, is_operator, created_at)
        VALUES ('stray', NULL, 'h', 'stray', 'stray', false, ${NOW})
      `;

        await expect(runPgMigrations(url)).rejects.toThrow();

        const after = await sql<{ space_id: string | null }[]>`
        SELECT space_id FROM api_keys WHERE id = 'stray'
      `;
        expect(after[0]!.space_id).toBeNull();
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  },
);
