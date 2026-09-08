import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Replays the one-model migration against rows written under the old one.
 *
 * **The property under test is that no credential loses reach it had.** A key
 * whose role admitted it past its permission maps was reaching everything in
 * its space whatever those maps said, so the maps on exactly those rows are
 * decorative and the migration has to read the role rather than the maps to
 * know what the key could do. The case that makes the difference visible is
 * `partial-maps`: it holds the wildcard on types and nothing on the other
 * three, and a criterion of "stamp the keys whose lists are empty" would leave
 * it unstamped and silently narrow it.
 *
 * The three kinds of credential outside the stamp are each here too, because
 * each is outside it for a different reason and a rule that caught one of them
 * by accident would look identical on a suite that only tested the other two.
 */
const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/sqlite/0090_one_permission_set_per_credential.sql",
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

const WILDCARD = '{"*":"write"}';
const EMPTY = "{}";

/** libsql column values are a union including objects and buffers, so a bare
 *  `String(...)` on one is both a lint error and a way to compare against
 *  `[object Object]`. */
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`expected a text column value, got ${typeof value}`);
  }
  return value;
}

interface Seed {
  id: string;
  space: string | null;
  role: string;
  platform: 0 | 1;
  runtime: 0 | 1;
  scopeEnforced: 0 | 1;
  types: string;
  edges: string;
  revoked: string | null;
}

const SEEDS: Seed[] = [
  // The classic case: a space admin with nothing on its row, reaching
  // everything through the bypass.
  {
    id: "empty-maps",
    space: "s1",
    role: "space_admin",
    platform: 0,
    runtime: 0,
    scopeEnforced: 0,
    types: EMPTY,
    edges: EMPTY,
    revoked: null,
  },
  // The case the criterion was corrected for. Types only, and the bypass makes
  // the other three decorative.
  {
    id: "partial-maps",
    space: "s1",
    role: "space_admin",
    platform: 0,
    runtime: 0,
    scopeEnforced: 0,
    types: WILDCARD,
    edges: EMPTY,
    revoked: null,
  },
  // Outside the stamp: manifest-bounded, and those bounds are the whole of what
  // it should reach.
  {
    id: "runtime",
    space: "s1",
    role: "member",
    platform: 0,
    runtime: 1,
    scopeEnforced: 0,
    types: '{"core.note":"write"}',
    edges: EMPTY,
    revoked: null,
  },
  // Outside the stamp: minted through a sign-in, already held to its maps.
  {
    id: "from-session",
    space: "s1",
    role: "space_admin",
    platform: 0,
    runtime: 0,
    scopeEnforced: 1,
    types: '{"core.note":"read"}',
    edges: EMPTY,
    revoked: null,
  },
  // Outside the stamp: the instance tier is fenced off the model.
  {
    id: "operator",
    space: null,
    role: "instance_admin",
    platform: 1,
    runtime: 0,
    scopeEnforced: 0,
    types: EMPTY,
    edges: EMPTY,
    revoked: null,
  },
  // A keys-mode instance's working key: space-less because nothing there is
  // bound to a space, and admitted past its maps by the bypass exactly as a
  // space-bound one was. It is stamped, and the criterion has to test the
  // operator flag rather than the space binding to reach it.
  {
    id: "keys-mode-admin",
    space: null,
    role: "space_admin",
    platform: 0,
    runtime: 0,
    scopeEnforced: 0,
    types: EMPTY,
    edges: EMPTY,
    revoked: null,
  },
  // Space-less and not an operator key. Every credential on a keys-mode
  // instance has this shape, so it survives.
  {
    id: "revoked-keys-mode",
    space: null,
    role: "member",
    platform: 0,
    runtime: 0,
    scopeEnforced: 0,
    types: EMPTY,
    edges: EMPTY,
    revoked: "2026-01-01T00:00:00.000Z",
  },
  // Space-bound and claiming the instance tier: the shape the constraint
  // refuses, so the migration clears it rather than failing on it.
  {
    id: "revoked-escalate",
    space: "s1",
    role: "instance_admin",
    platform: 1,
    runtime: 0,
    scopeEnforced: 0,
    types: EMPTY,
    edges: EMPTY,
    revoked: "2026-01-01T00:00:00.000Z",
  },
  // A revoked key whose shape is sound; it survives.
  {
    id: "revoked-sound",
    space: "s1",
    role: "space_admin",
    platform: 0,
    runtime: 0,
    scopeEnforced: 0,
    types: EMPTY,
    edges: EMPTY,
    revoked: "2026-01-01T00:00:00.000Z",
  },
];

async function seed(db: Client): Promise<void> {
  await db.execute(`CREATE TABLE api_keys (
    id text PRIMARY KEY NOT NULL,
    space_id text,
    key_hash text NOT NULL,
    label text NOT NULL,
    role text NOT NULL DEFAULT 'member',
    source text NOT NULL DEFAULT '',
    default_tier text NOT NULL DEFAULT 'library',
    is_platform integer NOT NULL DEFAULT 0,
    is_runtime_credential integer NOT NULL DEFAULT 0,
    scope_enforced integer NOT NULL DEFAULT 0,
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
  )`);
  await db.execute(
    `CREATE TABLE users (id text PRIMARY KEY, space_id text NOT NULL, role text NOT NULL DEFAULT 'member')`,
  );
  await db.execute({
    sql: `INSERT INTO users VALUES ('u1', 's1', 'space_admin')`,
    args: [],
  });
  for (const s of SEEDS) {
    await db.execute({
      sql: `INSERT INTO api_keys
        (id, space_id, key_hash, label, role, source, is_platform,
         is_runtime_credential, scope_enforced, type_permissions,
         edge_permissions, created_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
      args: [
        s.id,
        s.space,
        `hash-${s.id}`,
        s.id,
        s.role,
        s.id,
        s.platform,
        s.runtime,
        s.scopeEnforced,
        s.types,
        s.edges,
        s.revoked,
      ],
    });
  }
}

async function run(db: Client): Promise<void> {
  for (const statement of MIGRATION.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await db.execute(trimmed);
  }
}

describe.skipIf((process.env.DB_DIALECT ?? "sqlite") === "pg")(
  "0090 one permission set per credential",
  () => {
    it("stamps every key the role bypass admitted, and only those", async () => {
      const db = createClient({ url: ":memory:" });
      try {
        await seed(db);
        await run(db);
        const { rows } = await db.execute(
          `SELECT id, space_permissions, type_permissions, edge_permissions,
                  metadata_permissions, extension_permissions, profile_permissions
             FROM api_keys ORDER BY id`,
        );
        const byId = new Map(rows.map((r) => [text(r.id), r]));

        for (const id of ["empty-maps", "partial-maps"]) {
          const row = byId.get(id);
          expect(JSON.parse(text(row?.space_permissions)), id).toEqual(ELEVEN);
          for (const map of [
            "type_permissions",
            "edge_permissions",
            "metadata_permissions",
            "extension_permissions",
            "profile_permissions",
          ]) {
            expect(text(row?.[map]), `${id}.${map}`).toBe(WILDCARD);
          }
        }

        // A runtime credential keeps exactly its manifest bounds and holds no
        // space permission: its whole reach is what the manifest declared.
        const runtime = byId.get("runtime");
        expect(text(runtime?.type_permissions)).toBe('{"core.note":"write"}');
        expect(JSON.parse(text(runtime?.space_permissions))).toEqual([]);

        // A key minted through a sign-in was already held to its maps, so it
        // has nothing to be given back.
        const session = byId.get("from-session");
        expect(text(session?.type_permissions)).toBe('{"core.note":"read"}');
        expect(JSON.parse(text(session?.space_permissions))).toEqual([]);

        // The operator key takes nothing: running the instance is fenced
        // outside the permission model rather than expressed inside it.
        const operator = byId.get("operator");
        expect(text(operator?.type_permissions)).toBe(EMPTY);
        expect(JSON.parse(text(operator?.space_permissions))).toEqual([]);

        // **A keys-mode working key is stamped, and the pair above is what
        // makes that assertion mean something.** Both rows are space-less;
        // only the operator flag separates them, so a criterion keyed on the
        // space binding would have stamped neither and left such an instance
        // with no credential that reaches anything.
        const keysMode = byId.get("keys-mode-admin");
        expect(JSON.parse(text(keysMode?.space_permissions))).toEqual(ELEVEN);
        expect(text(keysMode?.type_permissions)).toBe(WILDCARD);
      } finally {
        db.close();
      }
    });

    it("clears only the revoked rows the constraint would refuse", async () => {
      const db = createClient({ url: ":memory:" });
      try {
        await seed(db);
        await run(db);
        const { rows } = await db.execute(
          `SELECT id FROM api_keys ORDER BY id`,
        );
        const ids = rows.map((r) => text(r.id));
        expect(ids).not.toContain("revoked-escalate");
        expect(ids).toContain("revoked-sound");
        expect(ids).toContain("revoked-keys-mode");
        // A revoked row is not stamped, because it can never authenticate.
        const { rows: kept } = await db.execute(
          `SELECT space_permissions FROM api_keys WHERE id = 'revoked-sound'`,
        );
        expect(JSON.parse(text(kept[0]?.space_permissions))).toEqual([]);
      } finally {
        db.close();
      }
    });

    it("makes the escalation shape unrepresentable, and leaves keys mode alone", async () => {
      const db = createClient({ url: ":memory:" });
      try {
        await seed(db);
        await run(db);
        const insert = (id: string, space: string | null, operator: 0 | 1) =>
          db.execute({
            sql: `INSERT INTO api_keys (id, space_id, key_hash, label, source, is_operator, created_at)
                  VALUES (?, ?, ?, 'l', 'p', ?, '2026-01-01T00:00:00.000Z')`,
            args: [id, space, id, operator],
          });
        // Space-bound and claiming the instance tier: judged by both rules at
        // once, which is the shape the constraint exists to refuse.
        await expect(insert("probe-bound-operator", "s1", 1)).rejects.toThrow();
        await expect(insert("probe-operator", null, 1)).resolves.toBeDefined();
        await expect(
          insert("probe-space-bound", "s1", 0),
        ).resolves.toBeDefined();
        // Keys mode binds nothing to a space and its credentials are not
        // operator keys, so the equivalence waits for the change that gives it
        // a real one.
        await expect(insert("probe-keys-mode", null, 0)).resolves.toBeDefined();
      } finally {
        db.close();
      }
    });

    it("leaves no role or scope_enforced column behind", async () => {
      const db = createClient({ url: ":memory:" });
      try {
        await seed(db);
        await run(db);
        const keyCols = (
          await db.execute(`PRAGMA table_info(api_keys)`)
        ).rows.map((r) => text(r.name));
        expect(keyCols).not.toContain("role");
        expect(keyCols).not.toContain("scope_enforced");
        expect(keyCols).not.toContain("is_platform");
        expect(keyCols).toContain("is_operator");
        expect(keyCols).toContain("space_permissions");
        expect(keyCols).toContain("oauth_client_id");
        expect(keyCols).toContain("profile_permissions");

        const userCols = (
          await db.execute(`PRAGMA table_info(users)`)
        ).rows.map((r) => text(r.name));
        expect(userCols).not.toContain("role");
      } finally {
        db.close();
      }
    });
  },
);
