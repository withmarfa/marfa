/**
 * A lookup of active items of one type is answered from an index on `type`.
 *
 * SQLite has no statistics for a store nobody analyzed, and without them it
 * takes `state = 'active'` to narrow a lookup as much as `type = ?` does, so
 * it read every active item in the store to find a handful of one type. The
 * plans are read from the statements the store really sends, not from a copy
 * of their SQL, and on a store where nearly every item is of another type.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type ResultSet,
} from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";
import { listActiveAppGrants } from "../../auth/grant-lifecycle.js";

type Storage = Awaited<ReturnType<typeof createSqliteStorage>>;

const NOTES = 3_000;
const GRANTS = 5;
const NOW = "2026-01-01T00:00:00.000Z";

let directory: string;
let path: string;
let storage: Storage;
let reader: Client;
let sent: { sql: string; args: InArgs }[] | null = null;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "marfa-type-index-"));
  path = join(directory, "test.db");
  storage = await createSqliteStorage(path);
  await seed();
  reader = createClient({ url: `file:${path}` });
  // Every connection the store opens is an instance of this class.
  const driver = Object.getPrototypeOf(createClient({ url: ":memory:" })) as {
    execute: (
      this: Client,
      statement: InStatement | string,
      args?: InArgs,
    ) => Promise<ResultSet>;
  };
  const execute = driver.execute;
  vi.spyOn(driver, "execute").mockImplementation(function (
    this: Client,
    statement,
    args,
  ) {
    if (sent) {
      sent.push(
        typeof statement === "string"
          ? { sql: statement, args: args ?? [] }
          : { sql: statement.sql, args: statement.args ?? [] },
      );
    }
    return execute.call(this, statement, args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  sent = null;
  reader.close();
  await storage.close();
  await rm(directory, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  await storage.__sqliteRun(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version)
     SELECT 'note-' || i, 'core.note', 'active', 'library', jsonb('{}'), ?, ?, ?, 1 FROM n`,
    [NOTES, NOW, NOW, NOW],
  );
  await storage.__sqliteRun(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version)
     SELECT 'grant-' || i, 'system.connection', 'active', 'library',
            jsonb('{"kind":"app","status":"active","client_id":"client-' || i || '","user_id":"user-1","granted_at":"2026-01-01T00:00:00.000Z"}'),
            ?, ?, ?, 1 FROM n`,
    [GRANTS, NOW, NOW, NOW],
  );
  await storage.__sqliteRun(
    `INSERT INTO auth_oauth_device_code (id, device_code, user_code, user_id, expires_at, status, client_id)
     VALUES ('code-1', 'digest-1', 'user-code-1', 'user-1', 4102444800, 'approved', 'client-1')`,
    [],
  );
}

/** The plan of every statement `call` sends that reads `items`. */
async function planOf(call: () => Promise<unknown>): Promise<string[]> {
  sent = [];
  await call();
  const statements = sent.filter(({ sql }) =>
    /(?:from|join)\s+["`]?items["`]?[\s,]/i.test(sql),
  );
  sent = null;
  expect(statements.length).toBeGreaterThan(0);
  const plans: string[] = [];
  for (const { sql, args } of statements) {
    const rows = await reader.execute({
      sql: `EXPLAIN QUERY PLAN ${sql}`,
      args,
    });
    plans.push(rows.rows.map((row) => row.detail as string).join(" | "));
  }
  return plans;
}

function oauth() {
  if (!storage.oauthProvider) throw new Error("storage.oauthProvider missing");
  return storage.oauthProvider;
}

const lookups: Record<string, () => Promise<unknown>> = {
  findGrantItemId: () =>
    oauth().findGrantItemId({
      clientId: "client-1",
      authUserId: "user-1",
    }),
  findDeviceCodeGrantKey: () => oauth().findDeviceCodeGrantKey("digest-1"),
  listInactiveAppGrants: () =>
    storage.items.listInactiveAppGrants("2025-01-01T00:00:00.000Z"),
  "items.list with a type and a state": () =>
    storage.items.list({ type: "system.connection", state: "active" }),
  "items.list with a type and the default state": () =>
    storage.items.list({ type: "system.connection" }),
  listActiveAppGrants: () => listActiveAppGrants(storage),
};

describe("a lookup of active items of one type", () => {
  it.each(Object.keys(lookups))("%s searches the type index", async (name) => {
    const plans = await planOf(lookups[name]!);
    for (const plan of plans) {
      expect(plan).toMatch(/SEARCH \w+ USING INDEX idx_items_type/);
      expect(plan).not.toMatch(/idx_items_state/);
      expect(plan).not.toMatch(/SCAN/);
    }
  });

  it("finds the grants the plans above are about", async () => {
    expect(await listActiveAppGrants(storage)).toHaveLength(GRANTS);
    expect(
      await oauth().findGrantItemId({
        clientId: "client-1",
        authUserId: "user-1",
      }),
    ).toBe("grant-1");
  });

  it("goes back to the state index when the type and state index is removed", async () => {
    // The witness: the same lookups, on the same rows, with the one index
    // removed, go back to reading the store through the state index.
    await storage.__sqliteRun("DROP INDEX idx_items_type_state", []);
    reader.close();
    reader = createClient({ url: `file:${path}` });
    for (const name of ["findGrantItemId", "listInactiveAppGrants"]) {
      const plans = await planOf(lookups[name]!);
      expect(plans.join("\n")).toMatch(/USING INDEX idx_items_state/);
    }
  });

  it("holds on a store opened again after it grew", async () => {
    await storage.close();
    storage = await createSqliteStorage(path);
    for (const name of Object.keys(lookups)) {
      for (const plan of await planOf(lookups[name]!)) {
        expect(plan).toMatch(/USING INDEX idx_items_type/);
        expect(plan).not.toMatch(/idx_items_state/);
      }
    }
  });

  it("is added to a store written before the index existed", async () => {
    await storage.__sqliteRun("DROP INDEX idx_items_type_state", []);
    await storage.close();
    storage = await createSqliteStorage(path);
    const indexes = await storage.__sqliteAll(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_type_state'",
    );
    expect(indexes).toHaveLength(1);
    for (const plan of await planOf(lookups.findGrantItemId!)) {
      expect(plan).toMatch(/USING INDEX idx_items_type_state/);
    }
  });

  it("still lists a type and what is under it, and nothing named like it", async () => {
    const types = [
      "probe.root",
      "probe.root.child",
      "probe.root.child.leaf",
      "probe.rooted",
      "probe.root-other",
      "probe.root_other",
      "probe.roo",
      "probe.root/",
    ];
    for (const [i, type] of types.entries()) {
      await storage.__sqliteRun(
        `INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version)
         VALUES (?, ?, 'active', 'library', jsonb('{}'), ?, ?, ?, 1)`,
        [`probe-${String(i)}`, type, NOW, NOW, NOW],
      );
    }
    await storage.__sqliteRun(
      `INSERT INTO items (id, type, state, tier, properties, created_at, updated_at, occurred_at, version)
       VALUES ('probe-archived', 'probe.root.child', 'archived', 'library', jsonb('{}'), ?, ?, ?, 1)`,
      [NOW, NOW, NOW],
    );
    for (const filter of ["probe.root", "probe.root.*"]) {
      const page = await storage.items.list({ type: filter });
      expect(page.data.map((item) => item.type).sort()).toEqual([
        "probe.root",
        "probe.root.child",
        "probe.root.child.leaf",
      ]);
    }
    const archived = await storage.items.list({
      type: "probe.root",
      state: "archived",
    });
    expect(archived.data.map((item) => item.id)).toEqual(["probe-archived"]);
  });
});
