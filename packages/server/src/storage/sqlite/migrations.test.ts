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
    expect(copies[0]).toMatch(
      new RegExp(
        `^marfa\\.db\\.backup-schema-1-to-${String(SCHEMA_VERSION)}-\\d{8}T\\d{9}Z$`,
      ),
    );
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

/** A file at schema version 2, holding `types` and `type_icons` rows. */
async function versionTwo(
  path: string,
  types: Record<string, unknown>,
  icons: Record<string, string>,
): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  await client.executeMultiple(BASELINE_SQL);
  await MIGRATIONS[0]?.apply(client);
  const at = "2026-10-01T00:00:00.000Z";
  for (const [id, schema] of Object.entries(types)) {
    await client.execute({
      sql: "INSERT INTO types (id, schema, origin, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)",
      args: [
        id,
        typeof schema === "string" ? schema : JSON.stringify(schema),
        at,
        at,
      ],
    });
  }
  for (const [id, icon] of Object.entries(icons)) {
    await client.execute({
      sql: "INSERT INTO type_icons (type_id, icon, updated_at) VALUES (?, ?, ?)",
      args: [id, icon, at],
    });
  }
  await client.execute("PRAGMA user_version = 2");
  client.close();
}

describe("starting on a database at schema version 2", () => {
  it("writes each stored icon as a Lucide icon ID, follows a renamed one and drops one Lucide does not have", async () => {
    const path = scratch();
    const fields = { name: { type: "string" } };
    const definition = (display_hints?: Record<string, string>) => ({
      id: "user.x",
      version: 1,
      fields,
      ...(display_hints && { display_hints }),
    });
    await versionTwo(
      path,
      {
        "user.bare": definition({ title_field: "name", icon: "star" }),
        "user.gone": definition({ title_field: "name", icon: "no-such-icon" }),
        "user.only": definition({ icon: "github" }),
        "user.renamed": definition({ icon: "archive-restore" }),
        "user.hidden": definition({ icon: "album" }),
        "user.hiddenalias": definition({ icon: "indent" }),
        "user.second": definition(),
        "user.prefixed": definition({ icon: "simple-icons:github" }),
        "user.plain": definition(),
        "user.damaged": "not json",
      },
      {
        "user.bare": "heart",
        "user.gone": "Heart",
        "user.renamed": "bold",
        "user.hidden": "album",
        "user.hiddenalias": "indent",
        "user.second": "circle-parking-off",
        "user.prefixed": "lucide:moon",
      },
    );

    await open(path);

    const client = createClient({ url: `file:${path}` });
    const types = Object.fromEntries(
      (
        await client.execute("SELECT id, schema, updated_at FROM types")
      ).rows.map((row) => [row.id as string, row]),
    );
    const icons = Object.fromEntries(
      (await client.execute("SELECT type_id, icon FROM type_icons")).rows.map(
        (row) => [row.type_id as string, row.icon],
      ),
    );
    const version = await client.execute("PRAGMA user_version");
    client.close();
    const hints = (id: string) =>
      (JSON.parse(types[id]?.schema as string) as { display_hints?: unknown })
        .display_hints;

    expect(version.rows[0]?.user_version).toBe(SCHEMA_VERSION);
    expect(hints("user.bare")).toEqual({
      title_field: "name",
      icon: "lucide:star",
    });
    expect(hints("user.gone")).toEqual({ title_field: "name" });
    expect(hints("user.renamed")).toEqual({ icon: "lucide:archive-arrow-up" });
    expect(hints("user.hidden")).toBeUndefined();
    expect(hints("user.hiddenalias")).toBeUndefined();
    expect(hints("user.only")).toBeUndefined();
    expect(types["user.only"]?.schema).toBe(JSON.stringify(definition()));
    expect(hints("user.prefixed")).toEqual({ icon: "simple-icons:github" });
    expect(types["user.plain"]?.schema).toBe(JSON.stringify(definition()));
    expect(types["user.damaged"]?.schema).toBe("not json");
    expect(types["user.bare"]?.updated_at).toBe("2026-10-01T00:00:00.000Z");
    expect(icons).toEqual({
      "user.bare": "lucide:heart",
      "user.renamed": "lucide:letter-b",
      "user.second": "lucide:circle-letter-p-off",
      "user.prefixed": "lucide:moon",
    });
  });
});

const WRITTEN_AT = "2026-10-01T00:00:00.000Z";
const TRASHED_AT = "2026-10-02T00:00:00.000Z";

/**
 * The types a file at schema version 3 holds, by their parents and their
 * fields. A type Marfa ships is stored with the fields it inherits as well as
 * its own; one registered through `POST /types` with its own alone.
 */
const ENTITY_FIELDS = {
  name: { type: "string" },
  email: { type: "email" },
  phone: { type: "string" },
  place: { type: "string" },
};
const STORED_TYPES: Record<
  string,
  {
    parent?: string;
    origin: "platform" | "user";
    fields: Record<string, unknown>;
  }
> = {
  "core.entity": { origin: "platform", fields: ENTITY_FIELDS },
  "core.entity.person": {
    parent: "core.entity",
    origin: "platform",
    fields: { ...ENTITY_FIELDS, given_name: { type: "string" } },
  },
  "core.entity.place": {
    parent: "core.entity",
    origin: "platform",
    fields: { ...ENTITY_FIELDS, street_address: { type: "string" } },
  },
  "core.note": { origin: "platform", fields: { body: { type: "string" } } },
  "user.contact": {
    parent: "core.entity",
    origin: "user",
    fields: { email: { type: "string" } },
  },
  "user.contact.work": {
    parent: "user.contact",
    origin: "user",
    fields: {},
  },
  "user.registered": {
    parent: "core.entity",
    origin: "user",
    fields: { email: ENTITY_FIELDS.email },
  },
  "user.loop": { parent: "user.loop.back", origin: "user", fields: {} },
  "user.loop.back": { parent: "user.loop", origin: "user", fields: {} },
};

/** A file at schema version 3, holding each item as `[type, properties JSON]`. */
async function versionThree(
  path: string,
  items: Record<string, [string, string]>,
): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  await client.executeMultiple(BASELINE_SQL);
  for (const migration of MIGRATIONS.filter((m) => m.to <= 3))
    await migration.apply(client);
  for (const [id, { parent, origin, fields }] of Object.entries(STORED_TYPES)) {
    const schema = {
      id,
      version: 1,
      ...(parent !== undefined && { parent }),
      fields,
    };
    await client.execute({
      sql: "INSERT INTO types (id, schema, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      args: [id, JSON.stringify(schema), origin, WRITTEN_AT, WRITTEN_AT],
    });
  }
  for (const [id, [type, properties]] of Object.entries(items)) {
    await client.execute({
      sql:
        "INSERT INTO items (id, type, state, properties, created_at, updated_at, occurred_at, source, writer_kind, writer_id, writer_name, trashed_at) " +
        "VALUES (?, ?, ?, jsonb(?), ?, ?, ?, 'fixture', 'key', 'k1', 'A key', ?)",
      args: [
        id,
        type,
        id === "trashed" ? "trashed" : "active",
        properties,
        WRITTEN_AT,
        WRITTEN_AT,
        WRITTEN_AT,
        id === "trashed" ? TRASHED_AT : null,
      ],
    });
  }
  await client.execute(
    "INSERT INTO metadata (item_id, tags, extensions) VALUES ('moved', '[\"kept\"]', '{}')",
  );
  await client.execute("PRAGMA user_version = 3");
  client.close();
}

const BEFORE_CONTACT_LISTS: Record<string, [string, string]> = {
  moved: [
    "core.entity.person",
    '{"name":"Moved","email":"a@example.com","phone":"+44 20 7946 0000","place":"1 High Street"}',
  ],
  empty: [
    "core.entity",
    '{"name":"Empty","email":"","phone":" \\t\\n\\u00a0","place":null}',
  ],
  odd: [
    "core.entity",
    '{"name":"Odd","email":["a@example.com"],"phone":42,"place":{"street":"x"}}',
  ],
  invalid: ["core.entity.person", '{"email":"not an email"}'],
  held: [
    "core.entity",
    '{"email":"a@example.com","emails":[{"value":"b@example.com"},{"value":"a@example.com","label":"work"}],' +
      '"phone":"+1 555 0100","phones":[{"value":"+1 555 0100"}],' +
      '"place":"1 High Street","addresses":[{"street_address":"1 High Street","locality":"Town"}]}',
  ],
  "held-refused": [
    "core.entity",
    '{"email":"not an email","emails":[{"value":"not an email","label":"old"}]}',
  ],
  beside: [
    "core.entity",
    '{"email":"b@example.com","emails":[{"value":"a@example.com"}],"phone":"+1 555 0100","phones":"+1 555 0199"}',
  ],
  trashed: ["core.entity.place", '{"name":"Binned","place":"2 Low Road"}'],
  declares: ["user.contact", '{"email":"c@example.com","phone":"+1 555 0100"}'],
  inherits: ["user.contact.work", '{"email":"c@example.com"}'],
  registered: [
    "user.registered",
    '{"email":"r@example.com","phone":"+1 555 0102"}',
  ],
  loop: ["user.loop", '{"email":"c@example.com"}'],
  note: ["core.note", '{"body":"x","email":"d@example.com"}'],
  exact: [
    "core.entity",
    '{"email":"e@example.com","count":12345678901234567890,"ratio":1.50}',
  ],
  scalar: ["core.entity", '"not an object"'],
};

/** Each item's properties, version and writer, and every version and event. */
async function contactState(path: string) {
  const client = createClient({ url: `file:${path}` });
  try {
    const items = await client.execute(
      "SELECT id, json(properties) AS properties, version, updated_at, writer_kind FROM items",
    );
    const versions = await client.execute(
      "SELECT item_id, version, properties, created_at, writer_kind, writer_id, writer_name FROM versions ORDER BY item_id",
    );
    const events = await client.execute(
      "SELECT event_type, item_id, payload, enable_fanout FROM event_log ORDER BY id",
    );
    return {
      items: Object.fromEntries(
        items.rows.map((row) => [row.id as string, { ...row }]),
      ),
      versions: versions.rows.map((row) => ({ ...row })),
      events: events.rows.map((row) => ({ ...row })),
    };
  } finally {
    client.close();
  }
}

describe("starting on a database at schema version 3", () => {
  const properties = (
    state: Awaited<ReturnType<typeof contactState>>,
    id: string,
  ) => JSON.parse(state.items[id]?.properties as string) as unknown;

  it("moves an entity's email, phone and place into one-entry lists, and leaves what it cannot move", async () => {
    const path = scratch();
    await versionThree(path, BEFORE_CONTACT_LISTS);

    await open(path);

    const state = await contactState(path);
    expect(properties(state, "moved")).toEqual({
      name: "Moved",
      emails: [{ value: "a@example.com" }],
      phones: [{ value: "+44 20 7946 0000" }],
      addresses: [{ street_address: "1 High Street" }],
    });
    expect(properties(state, "empty")).toEqual({ name: "Empty" });
    expect(properties(state, "trashed")).toEqual({
      name: "Binned",
      addresses: [{ street_address: "2 Low Road" }],
    });
    // The type declares `email` itself, and its subtype inherits it; every
    // other type holds the field as `core.entity` declares it.
    expect(properties(state, "declares")).toEqual({
      email: "c@example.com",
      phones: [{ value: "+1 555 0100" }],
    });
    expect(properties(state, "inherits")).toEqual({ email: "c@example.com" });
    expect(state.items.exact?.properties).toBe(
      '{"count":12345678901234567890,"ratio":1.50,"emails":[{"value":"e@example.com"}]}',
    );
    for (const id of ["odd", "invalid", "beside", "loop", "note", "scalar"]) {
      expect(state.items[id]?.properties, id).toBe(
        JSON.stringify(JSON.parse(BEFORE_CONTACT_LISTS[id]![1])),
      );
      expect(state.items[id]?.version, id).toBe(1);
    }
  });

  it("removes an old field whose value its list already holds, and leaves the list as it was", async () => {
    const path = scratch();
    await versionThree(path, BEFORE_CONTACT_LISTS);

    await open(path);

    const state = await contactState(path);
    expect(properties(state, "held")).toEqual({
      emails: [
        { value: "b@example.com" },
        { value: "a@example.com", label: "work" },
      ],
      phones: [{ value: "+1 555 0100" }],
      addresses: [{ street_address: "1 High Street", locality: "Town" }],
    });
    // The list holds the value already, so removing the field loses nothing,
    // even though the `value` member would refuse it as a new entry.
    expect(properties(state, "held-refused")).toEqual({
      emails: [{ value: "not an email", label: "old" }],
    });
  });

  it("keeps the value of a field a registered type declares, even word for word as core.entity did", async () => {
    const path = scratch();
    await versionThree(path, BEFORE_CONTACT_LISTS);

    await open(path);

    const state = await contactState(path);
    expect(properties(state, "registered")).toEqual({
      email: "r@example.com",
      phones: [{ value: "+1 555 0102" }],
    });
  });

  it("gives each changed item its next version, with no writer, the old version in its history and an item.updated event", async () => {
    const path = scratch();
    await versionThree(path, BEFORE_CONTACT_LISTS);

    await open(path);

    const state = await contactState(path);
    const moved = [
      "declares",
      "empty",
      "exact",
      "held",
      "held-refused",
      "moved",
      "registered",
      "trashed",
    ];
    expect(
      Object.values(state.items)
        .filter((item) => item.version === 2)
        .map((item) => item.id)
        .sort(),
    ).toEqual(moved);
    for (const id of moved) {
      expect(state.items[id]?.writer_kind, id).toBeNull();
      expect(state.items[id]?.updated_at, id).not.toBe(WRITTEN_AT);
    }
    expect(state.versions.map((version) => version.item_id)).toEqual(moved);
    expect(state.versions.find((v) => v.item_id === "moved")).toMatchObject({
      version: 1,
      properties: JSON.stringify(JSON.parse(BEFORE_CONTACT_LISTS.moved![1])),
      created_at: state.items.moved?.updated_at,
      writer_kind: "key",
      writer_id: "k1",
      writer_name: "A key",
    });

    expect(state.events.map((event) => event.item_id).sort()).toEqual(moved);
    const event = state.events.find((e) => e.item_id === "moved");
    expect(event).toMatchObject({ event_type: "updated", enable_fanout: 1 });
    expect(JSON.parse(event?.payload as string)).toMatchObject({
      event_type: "item.updated",
      item: {
        id: "moved",
        type: "core.entity.person",
        state: "active",
        version: 2,
        updated_at: state.items.moved?.updated_at,
        properties: properties(state, "moved"),
      },
      metadata: { item_id: "moved", tags: ["kept"], extensions: {} },
    });
    expect(
      JSON.parse(
        state.events.find((e) => e.item_id === "trashed")?.payload as string,
      ),
    ).toMatchObject({
      item: { state: "trashed", trashed_at: TRASHED_AT },
      metadata: { item_id: "trashed", tags: [], extensions: {} },
    });
  });

  it("changes nothing when it runs again", async () => {
    const path = scratch();
    await versionThree(path, BEFORE_CONTACT_LISTS);
    await open(path);
    const once = await contents(path);

    const client = createClient({ url: `file:${path}` });
    await MIGRATIONS.find((m) => m.to === 4)?.apply(client);
    client.close();

    expect(await contents(path)).toEqual(once);
  });
});

describe("starting on an unstamped database", () => {
  it("updates an unstamped one from the last version a build left unstamped", async () => {
    // Schema versions 3 and 4 changed rows and not tables, version 5 adds
    // one index and versions 6 and 7 one table each, so an unstamped file of
    // this shape without them is at version 2: every build since stamps what
    // it writes.
    expect(Math.max(...UNSTAMPED_VERSIONS)).toBe(2);
    const path = scratch();
    const client = createClient({ url: `file:${path}` });
    await client.executeMultiple(SCHEMA_SQL);
    await client.executeMultiple(CREATE_FTS);
    await client.execute("DROP INDEX idx_items_state_binned_at");
    await client.execute("DROP TABLE source_names");
    await fill(client);
    await client.execute("DROP TABLE trash_with_hosts");
    client.close();
    // The fixture's icons are bare names no icon set has, which the update
    // to version 3 removes; every other row stays.
    const tables = ownTables(await currentShape()).filter(
      (table) =>
        table !== "type_icons" &&
        table !== "source_names" &&
        table !== "trash_with_hosts",
    );
    const before = await rowsOf(path, tables);

    await open(path);

    const check = createClient({ url: `file:${path}` });
    const version = await check.execute("PRAGMA user_version");
    const icons = await check.execute("SELECT * FROM type_icons");
    check.close();
    expect(version.rows[0]?.user_version).toBe(SCHEMA_VERSION);
    expect(await rowsOf(path, tables)).toEqual(before);
    expect(icons.rows).toEqual([]);
    expect(backups(path)).toHaveLength(1);
    expect(backups(path)[0]).toContain(
      `-schema-2-to-${String(SCHEMA_VERSION)}-`,
    );
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

    await migrateInPlace(path, 1, {}, remake, replayedShape(2));

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
        `${path}.backup-schema-1-to-${String(SCHEMA_VERSION)}-20261027T101500123Z`,
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
