/**
 * Updating a database written at an earlier schema version in place.
 *
 * Each fixture is a file at schema version 1, made from `schema-1.sql` as the
 * releases at that version made it, with rows in every table, so a check is
 * against every row the owner had and not against the few a test thought of.
 */
import { createClient, type Client } from "@libsql/client";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "./connection.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  UNSTAMPED_VERSIONS,
  migrateInPlace,
  replayedShape,
  type Migration,
} from "./migrations.js";
import { RefusedDatabaseError } from "./refused-database.js";
import {
  currentShape,
  ownTables,
  SCHEMA_SQL,
  CREATE_FTS,
} from "./schema-shape.js";

const BASELINE_SQL = readFileSync(
  new URL("./schema-1.sql", import.meta.url),
  "utf8",
);

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-migrate-"));
  dirs.push(dir);
  return join(dir, "marfa.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Values a CHECK constraint holds a column to. */
const CHOSEN: Record<string, Record<string, string>> = {
  folder_status: { sign_in_kind: "'key'" },
  outbound_webhooks: { key_id: "'x1'" },
};

/**
 * Two rows in every table the database declares, every value one that
 * refers to the other tables' rows, so no reference is broken.
 */
async function fill(client: Client): Promise<void> {
  // Off while filling, since the rows go in table by table in name order.
  await client.execute("PRAGMA foreign_keys = OFF");
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'items_fts_%'",
  );
  for (const row of tables.rows) {
    const table = row.name as string;
    if (table === "items_fts") {
      for (const n of [1, 2]) {
        await client.execute(
          `INSERT INTO items_fts (rowid, title, body, description, name, extra, tags) VALUES (${String(n)}, 'title ${String(n)}', 'body', '', '', '', '')`,
        );
      }
      continue;
    }
    const columns = await client.execute(`PRAGMA table_info(\`${table}\`)`);
    for (const n of [1, 2]) {
      const names: string[] = [];
      const values: string[] = [];
      for (const column of columns.rows) {
        const name = column.name as string;
        const type = (column.type as string).toLowerCase();
        const chosen = CHOSEN[table]?.[name];
        if (chosen === undefined && Number(column.notnull) === 0) continue;
        names.push(`\`${name}\``);
        values.push(
          chosen ??
            (type.includes("int")
              ? String(n)
              : type.includes("real")
                ? String(n + 0.5)
                : type.includes("blob")
                  ? `x'0${String(n)}'`
                  : `'x${String(n)}'`),
        );
      }
      await client.execute(
        `INSERT OR IGNORE INTO \`${table}\` (${names.join(", ")}) VALUES (${values.join(", ")})`,
      );
    }
  }
  const broken = await client.execute("PRAGMA foreign_key_check");
  if (broken.rows.length > 0) {
    throw new Error(
      `the fixture breaks ${String(broken.rows.length)} references`,
    );
  }
}

/** A file at schema version 1 as a release at that version left it. */
async function versionOne(
  path: string,
  { stamped = true, alter = "" }: { stamped?: boolean; alter?: string } = {},
): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.executeMultiple(BASELINE_SQL);
  await fill(client);
  if (alter !== "") await client.executeMultiple(alter);
  if (stamped) await client.execute("PRAGMA user_version = 1");
  client.close();
}

/** Every row, the schema and the version, as one comparable value. */
async function contents(path: string): Promise<unknown> {
  const client = createClient({ url: `file:${path}` });
  try {
    const out: Record<string, unknown> = {};
    const version = await client.execute("PRAGMA user_version");
    out.user_version = version.rows[0]?.user_version;
    const objects = await client.execute(
      "SELECT type, name, sql FROM sqlite_master ORDER BY name",
    );
    out.schema = objects.rows.map((row) => [row.type, row.name, row.sql]);
    for (const row of objects.rows) {
      if (row.type !== "table" || (row.name as string).startsWith("sqlite_"))
        continue;
      // Some of the full-text table's shadow tables have no rowid.
      const rows = await client.execute(
        `SELECT * FROM \`${row.name as string}\``,
      );
      out[row.name as string] = rows.rows
        .map((r) =>
          JSON.stringify({ ...r }, (_, v: unknown) =>
            v instanceof ArrayBuffer ? Buffer.from(v).toString("hex") : v,
          ),
        )
        .sort();
    }
    return out;
  } finally {
    client.close();
  }
}

/** The rows of every table at schema version 1, for the tables both hold. */
async function rowsOf(
  path: string,
  tables: readonly string[],
): Promise<unknown> {
  const client = createClient({ url: `file:${path}` });
  try {
    const out: Record<string, unknown> = {};
    for (const table of tables) {
      const rows = await client.execute(
        `SELECT * FROM \`${table}\` ORDER BY rowid`,
      );
      out[table] = rows.rows.map((r) => ({ ...r }));
    }
    return out;
  } finally {
    client.close();
  }
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function backups(path: string): string[] {
  const dir = join(path, "..");
  return readdirSync(dir).filter((name) => name.includes(".backup-schema-"));
}

async function open(path: string, hooks = {}): Promise<void> {
  const connection = await createConnection(path, hooks);
  await connection.close();
}

async function versionOneTables(): Promise<string[]> {
  return ownTables(await replayedShape(1));
}

describe("the migrations", () => {
  it("replayed onto schema version 1 give exactly the schema this build creates", async () => {
    const replayed = await replayedShape(SCHEMA_VERSION);
    const current = await currentShape();
    const text = (shape: typeof current) =>
      [...shape.objects].map(([name, o]) => [name, o.type, o.sql]).sort();
    expect(text(replayed)).toEqual(text(current));
  });

  it("are numbered one after another from schema version 2", () => {
    expect(MIGRATIONS.map((m) => m.to)).toEqual(
      MIGRATIONS.map((_, i) => i + 2),
    );
  });

  it("give every unstamped version a schema no other version has", async () => {
    const shapes = await Promise.all(
      UNSTAMPED_VERSIONS.map((v) => replayedShape(v)),
    );
    const keys = shapes.map((shape) =>
      JSON.stringify([...shape.objects].map(([n, o]) => [n, o.sql]).sort()),
    );
    expect(new Set(keys).size).toBe(UNSTAMPED_VERSIONS.length);
  });

  it("do not hold this build's schema, which a change to it without a migration would break", () => {
    // A witness that the first test can fail: the schema this build creates
    // is not the baseline's.
    expect(SCHEMA_SQL + CREATE_FTS).not.toEqual(BASELINE_SQL);
  });
});

describe("starting on a database at schema version 1", () => {
  it("updates it in place, keeping every row, after taking a copy of it", async () => {
    const path = scratch();
    await versionOne(path);
    const tables = await versionOneTables();
    const before = await rowsOf(path, tables);
    const found = await contents(path);

    await open(path);

    const client = createClient({ url: `file:${path}` });
    const version = await client.execute("PRAGMA user_version");
    const icons = await client.execute(
      "SELECT name FROM sqlite_master WHERE name = 'type_icons'",
    );
    client.close();
    expect(version.rows[0]?.user_version).toBe(SCHEMA_VERSION);
    expect(icons.rows).toHaveLength(1);
    expect(await rowsOf(path, tables)).toEqual(before);

    const copies = backups(path);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^marfa\.db\.backup-schema-1-to-2-\d{8}T\d{9}Z$/);
    expect(await contents(join(path, "..", copies[0] ?? ""))).toEqual(found);
  });

  it("updates one no build stamped, from the schema it has", async () => {
    const path = scratch();
    await versionOne(path, { stamped: false });
    const tables = await versionOneTables();
    const before = await rowsOf(path, tables);

    await open(path);

    const client = createClient({ url: `file:${path}` });
    const version = await client.execute("PRAGMA user_version");
    client.close();
    expect(version.rows[0]?.user_version).toBe(SCHEMA_VERSION);
    expect(await rowsOf(path, tables)).toEqual(before);
    expect(backups(path)).toHaveLength(1);
  });

  it("takes no second copy and changes nothing on the next start", async () => {
    const path = scratch();
    await versionOne(path);
    await open(path);
    const after = await contents(path);

    await open(path);

    expect(backups(path)).toHaveLength(1);
    expect(await contents(path)).toEqual(after);
  });

  for (const [fault, says] of [
    ["change-shape", "the settings table has stray"],
    ["lose-row", "rows and would hold"],
  ] as const) {
    it(`rolls back an update that ${fault === "lose-row" ? "loses a row" : "leaves another schema"}, and leaves the file as it was`, async () => {
      const path = scratch();
      await versionOne(path);
      const was = hash(path);

      const refusal = await open(path, { fault }).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(RefusedDatabaseError);
      expect(String(refusal)).toContain(says);
      expect(String(refusal)).toContain("the update was rolled back");
      expect(String(refusal)).toContain(
        join(path, "..", backups(path)[0] ?? ""),
      );
      expect(hash(path)).toBe(was);
      // Witness: the same file without the fault is updated.
      await open(path);
      expect(hash(path)).not.toBe(was);
    });
  }

  it("refuses without space for the copy and the update, before writing anything", async () => {
    const path = scratch();
    await versionOne(path);
    const was = hash(path);

    const refusal = await open(path, { freeDiskBytes: 1024 }).catch(
      (e: unknown) => e,
    );

    expect(refusal).toBeInstanceOf(RefusedDatabaseError);
    expect(String(refusal)).toContain("bytes free beside it");
    expect(hash(path)).toBe(was);
    expect(backups(path)).toEqual([]);
  });

  it("refuses one whose schema is not the one its version names", async () => {
    const path = scratch();
    await versionOne(path, {
      alter: "ALTER TABLE `settings` ADD COLUMN `stray` text;",
    });
    const was = hash(path);

    const refusal = await open(path).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RefusedDatabaseError);
    expect(String(refusal)).toContain("schema version 1 has");
    expect(String(refusal)).toContain("the settings table has stray");
    expect(hash(path)).toBe(was);
    expect(backups(path)).toEqual([]);
  });

  it("refuses an unstamped one whose schema no version has", async () => {
    const path = scratch();
    await versionOne(path, {
      stamped: false,
      alter: "ALTER TABLE `settings` ADD COLUMN `stray` text;",
    });
    const was = hash(path);

    const refusal = await open(path).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RefusedDatabaseError);
    expect(hash(path)).toBe(was);
    expect(backups(path)).toEqual([]);
  });
});

describe("starting on a database at this build's schema version", () => {
  it("stamps an unstamped one without a copy or an update", async () => {
    const path = scratch();
    const client = createClient({ url: `file:${path}` });
    await client.executeMultiple(SCHEMA_SQL);
    await client.executeMultiple(CREATE_FTS);
    await fill(client);
    client.close();
    const tables = ownTables(await currentShape());
    const before = await rowsOf(path, tables);

    await open(path);

    const check = createClient({ url: `file:${path}` });
    const version = await check.execute("PRAGMA user_version");
    check.close();
    expect(version.rows[0]?.user_version).toBe(SCHEMA_VERSION);
    expect(await rowsOf(path, tables)).toEqual(before);
    expect(backups(path)).toEqual([]);
  });
});

describe("starting on a database a newer build wrote", () => {
  it("refuses it and leaves it as it was", async () => {
    const path = scratch();
    await open(path);
    const client = createClient({ url: `file:${path}` });
    await client.execute(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`);
    client.close();
    const was = hash(path);

    const refusal = await open(path).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RefusedDatabaseError);
    expect(String(refusal)).toContain("which a newer build wrote");
    expect(hash(path)).toBe(was);
  });
});

describe("a migration", () => {
  it("that fails partway is rolled back whole", async () => {
    const path = scratch();
    await versionOne(path);
    const was = hash(path);
    const failing: Migration[] = [
      {
        to: 2,
        changes: ["type_icons"],
        apply: async (db) => {
          await MIGRATIONS[0]?.apply(db);
          await db.execute("DELETE FROM `settings`");
          throw new Error("stopped partway");
        },
      },
    ];

    const refusal = await migrateInPlace(path, 1, {}, failing).catch(
      (e: unknown) => e,
    );

    expect(refusal).toBeInstanceOf(RefusedDatabaseError);
    expect(String(refusal)).toContain("stopped partway");
    expect(hash(path)).toBe(was);
  });

  it("that remakes a table others refer to keeps the rows that refer to it", async () => {
    const path = scratch();
    await versionOne(path);
    const tables = await versionOneTables();
    const before = await rowsOf(path, tables);
    const userTable =
      /CREATE TABLE IF NOT EXISTS `auth_user` \([\s\S]*?\n\);/.exec(
        BASELINE_SQL,
      )?.[0];
    if (userTable === undefined) throw new Error("no auth_user table");
    const remake: Migration[] = [
      {
        to: 2,
        changes: ["type_icons"],
        apply: async (db) => {
          await db.executeMultiple(
            "CREATE TABLE `auth_user_was` AS SELECT * FROM `auth_user`; DROP TABLE `auth_user`;",
          );
          await db.executeMultiple(userTable);
          await db.executeMultiple(
            "INSERT INTO `auth_user` SELECT * FROM `auth_user_was`; DROP TABLE `auth_user_was`;",
          );
          await MIGRATIONS[0]?.apply(db);
        },
      },
    ];

    await migrateInPlace(path, 1, {}, remake);

    expect(await rowsOf(path, tables)).toEqual(before);
  });
});

describe("starting on a file URL with an authority", () => {
  for (const suffix of ["", "?tls=0"]) {
    it(`updates the file the driver opens${suffix === "" ? "" : ", with a query"}`, async () => {
      const path = scratch();
      const folder = join(path, "..", "my data");
      mkdirSync(folder);
      const spaced = join(folder, "marfa.db");
      await versionOne(spaced);
      const url = `file://localhost${spaced.replaceAll(" ", "%20")}${suffix}`;

      await open(url);

      const client = createClient({ url });
      const version = await client.execute("PRAGMA user_version");
      client.close();
      expect(version.rows[0]?.user_version).toBe(SCHEMA_VERSION);
      expect(backups(spaced)).toHaveLength(1);
    });
  }
});

describe("an update that cannot reach the file or the copy", () => {
  it("refuses, naming the copy, when another process holds the write lock past the wait", async () => {
    const path = scratch();
    await versionOne(path);
    const was = await contents(path);
    const holder = createClient({ url: `file:${path}` });
    await holder.execute("PRAGMA busy_timeout = 0");
    const held = await holder.transaction("write");
    try {
      const refusal = await migrateInPlace(path, 1, {
        busyTimeoutMs: 50,
      }).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(RefusedDatabaseError);
      expect(String(refusal)).toContain("Nothing was changed");
      expect(String(refusal)).toContain(
        join(path, "..", backups(path)[0] ?? "no copy"),
      );
      expect(backups(path)).toHaveLength(1);
    } finally {
      await held.rollback();
      held.close();
      holder.close();
    }
    expect(await contents(path)).toEqual(was);
    expect(await contents(path)).toMatchObject({ user_version: 1 });
    // Witness: with the lock released the same file is updated.
    await migrateInPlace(path, 1, { busyTimeoutMs: 50 });
    expect(await contents(path)).toMatchObject({
      user_version: SCHEMA_VERSION,
    });
  });

  it("refuses, naming nothing taken, when the copy cannot be made", async () => {
    const path = scratch();
    await versionOne(path);
    const was = hash(path);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-27T10:15:00.123Z"));
      writeFileSync(
        `${path}.backup-schema-1-to-2-20261027T101500123Z`,
        "in the way",
      );

      const refusal = await migrateInPlace(path, 1).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(RefusedDatabaseError);
      expect(String(refusal)).toContain("already exists");
      expect(String(refusal)).toContain("Nothing was changed");
      expect(hash(path)).toBe(was);
    } finally {
      vi.useRealTimers();
    }
  });
});
