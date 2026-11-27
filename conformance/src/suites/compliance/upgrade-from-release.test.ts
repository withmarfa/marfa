import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  keepStatusLog,
  type RefusedBoot,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  expectDatabaseUnchanged,
  listened,
  stopServerAtCleanup,
} from "../../utils/refused-boot.js";
import {
  EDGE_ID,
  ITEM_IDS,
  KEY_SALT,
  loadDump,
  OLD_SCHEMA,
  SOURCE,
  TYPE_ID,
  WORKING_KEY,
} from "../../utils/release-dump.js";
import { tempFolder } from "../../utils/temp-folder.js";
import {
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";

/**
 * A server upgrading a database an earlier release wrote.
 *
 * The database is `fixtures/database-v0.0.90.sql`, a text dump of the file the
 * published v0.0.90 release wrote at schema version 3, frozen in the
 * repository. Its header says how it was made and what it holds. No operation
 * can make an earlier release's database, so it is loaded into a file of the
 * fixture's own before each start, and the server under test is started on it.
 * The fixture never reads a migration the server carries, so it follows no edit
 * to one.
 *
 * **The first tests are the witness for the rest.** The file starts, takes
 * requests and answers its reads as v0.0.90 did (the type's origin apart, which
 * v0.0.91 renamed), so a refusal below is the alteration's doing and not a file
 * this build cannot upgrade.
 */

const COPY = "marfa.db.before-upgrade";
/** The disk reserve setting's maximum, 1 TiB. The refusal it makes needs a volume with less than this free. */
const HUGE_RESERVE = String(2 ** 40);

/** What v0.0.90 answered to each read, recorded when the dump was made. */
const ITEM1 = {
  item: {
    id: "01f00000-0000-7000-8000-000000000001",
    type: "user.upgrade_witness",
    state: "active",
    tier: "library",
    created_at: "2026-11-22T22:12:37.378Z",
    updated_at: "2026-11-22T22:12:37.378Z",
    last_activity_at: "2026-11-22T22:12:37.378Z",
    occurred_at: "2026-11-22T22:12:37.378Z",
    source: "upgrade-fixture",
    version: 1,
    schema_version: 0,
    trashed_at: null,
    read_only: false,
    properties: {
      body: "first witness",
      priority: "high",
      stars: 3,
    },
    edges: {},
  },
  metadata: {
    item_id: "01f00000-0000-7000-8000-000000000001",
    tags: ["witness", "one"],
    extensions: {},
  },
};
const ITEM2 = {
  item: {
    id: "01f00000-0000-7000-8000-000000000002",
    type: "user.upgrade_witness",
    state: "active",
    tier: "library",
    created_at: "2026-11-22T22:12:37.394Z",
    updated_at: "2026-11-22T22:12:37.394Z",
    last_activity_at: "2026-11-22T22:12:37.394Z",
    occurred_at: "2026-11-22T22:12:37.394Z",
    source: "upgrade-fixture",
    version: 1,
    schema_version: 0,
    trashed_at: null,
    read_only: false,
    properties: {
      body: "second witness",
      priority: "low",
      stars: 1,
    },
    edges: {},
  },
  metadata: {
    item_id: "01f00000-0000-7000-8000-000000000002",
    tags: [],
    extensions: {},
  },
};
const ITEM3 = {
  item: {
    id: "01f00000-0000-7000-8000-000000000003",
    type: "core.note",
    state: "active",
    tier: "library",
    created_at: "2026-11-22T22:12:37.407Z",
    updated_at: "2026-11-22T22:12:37.407Z",
    last_activity_at: "2026-11-22T22:12:37.407Z",
    occurred_at: "2026-11-22T22:12:37.407Z",
    source: "upgrade-fixture",
    version: 1,
    schema_version: 0,
    trashed_at: null,
    read_only: false,
    properties: {
      body: "a core note",
    },
    edges: {
      about: {
        data: [
          {
            id: "01f00000-0000-7000-8000-0000000000e1",
            from_id: "01f00000-0000-7000-8000-000000000003",
            to_id: "01f00000-0000-7000-8000-000000000001",
            edge_type: "about",
            version: 1,
            created_at: "2026-11-22T22:12:37.419Z",
            updated_at: "2026-11-22T22:12:37.419Z",
            properties: {},
          },
        ],
        next_cursor: null,
      },
    },
  },
  metadata: {
    item_id: "01f00000-0000-7000-8000-000000000003",
    tags: [],
    extensions: {},
  },
};
const TYPE = {
  id: "user.upgrade_witness",
  version: 0,
  fields: {
    body: {
      type: "string",
      description: "The text of the note.",
      label: "Body",
    },
    title: {
      type: "string",
      description: "The note's heading.",
      label: "Title",
    },
    language: {
      type: "string",
      description: "BCP 47 language code",
      format: "bcp47",
      label: "Language",
    },
    notes: {
      type: "string",
      description: "Your own comments, kept apart from the note's text.",
      label: "Notes",
    },
    priority: {
      type: "string",
      label: "Priority",
    },
    stars: {
      type: "number",
      label: "Stars",
    },
  },
  parent: "core.note",
  label: "Upgrade Witness",
  plural: "Upgrade Witnesses",
  display_hints: {
    title_field: "title",
    body_field: "body",
    icon: "lucide:sticky-note",
  },
  merge_policy: {
    fields: {
      body: "keep_both_copies",
      notes: "keep_both_copies",
    },
    default: "last_writer_wins",
  },
  provenance: {
    origin: "user",
    created_by: {
      kind: "key",
      id: "01a20551-502b-763f-8813-6908e83cb77c",
      name: "upgrade-fixture",
    },
  },
};

type Database = DatabaseSync;

/** Every file beside the database that holds a copy from before an upgrade. */
function copiesBeside(state: string): string[] {
  return readdirSync(state).filter((name) => name.startsWith(COPY));
}

function userVersion(db: Database): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version);
}

interface Snapshot {
  userVersion: number;
  /** A hash of each table's rows, in an order that does not depend on how the file stores them. */
  tables: Record<string, string>;
}

/**
 * The schema version and what every table holds. The rows are hashed whole and
 * sorted, because a copy made with VACUUM INTO is a different file that may
 * number its rows differently. The full-text tables are skipped because they
 * are virtual: what they hold is in their shadow tables, which are included.
 */
function snapshot(db: Database): Snapshot {
  const tables: Record<string, string> = {};
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
  for (const name of names) {
    const rows = db
      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all()
      .map((row) =>
        JSON.stringify(row, (_key, value: unknown) =>
          value instanceof Uint8Array
            ? `blob:${Buffer.from(value).toString("hex")}`
            : typeof value === "bigint"
              ? `int:${String(value)}`
              : value,
        ),
      )
      .sort();
    tables[name] = createHash("sha256").update(rows.join("\n")).digest("hex");
  }
  return { userVersion: userVersion(db), tables };
}

function itemIds(db: Database): string[] {
  return db
    .prepare("SELECT id FROM items ORDER BY id")
    .all()
    .map((row) => String(row.id));
}

const states: string[] = [];

afterAll(async () => {
  for (const state of states.splice(0)) await stopServer({ state });
}, FRESH_SERVER_TIMEOUT_MS);

interface Started {
  state: string;
  sqlitePath: string;
  client: MarfaClient;
  url: string;
}

/**
 * Starts the server on a folder holding the dump (after `alter`), runs `use`
 * against it, and stops it, so the files are as they are once it has ended.
 */
async function startedOn<T>(
  use: (started: Started) => Promise<T>,
  options: {
    alter?: (db: Database) => void;
    env?: Record<string, string>;
    state?: string;
  } = {},
): Promise<T> {
  const state = options.state ?? tempFolder("marfa-upgrade-");
  const sqlitePath = join(state, "marfa.db");
  if (options.state === undefined) loadDump(sqlitePath, options.alter);
  states.push(state);
  const { url } = await bootUnclaimedServer({
    state,
    env: { MARFA_KEY_SALT: KEY_SALT, ...options.env },
  });
  stopServerAtCleanup(state);
  try {
    return await use({
      state,
      sqlitePath,
      url,
      client: new MarfaClient({ baseUrl: url, apiKey: WORKING_KEY }),
    });
  } finally {
    keepStatusLog(state);
    await stopServer({ state });
  }
}

/** A start that ended without listening. */
function expectRefusedWhole(refused: RefusedBoot): void {
  expect(refused.code).not.toBe(0);
  expect(listened(refused)).toBe(false);
}

describe("starting on a database an earlier release wrote", () => {
  it(
    "answers the items, the edge and the list after an upgrade as v0.0.90 did",
    async () => {
      await startedOn(async ({ url, client }) => {
        expect((await fetch(`${url}/health`)).status).toBe(200);
        const root = await client.root();
        expect(root.ok, JSON.stringify(root.error)).toBe(true);
        const port = new URL(url).port;
        const origin =
          port === "" || port === "80"
            ? "http://localhost"
            : `http://localhost:${port}`;
        for (const [id, recorded] of [
          [ITEM_IDS[0], ITEM1],
          [ITEM_IDS[1], ITEM2],
          [ITEM_IDS[2], ITEM3],
        ] as const) {
          const read = await client.getItem(id);
          expect(read.ok, JSON.stringify(read.error)).toBe(true);
          // The recorded body is what v0.0.90 answered. This build adds the two addresses.
          expect(read.data, id).toEqual({
            ...recorded,
            item: {
              ...recorded.item,
              web_url: `${origin}/i/${id}`,
              app_url: `marfa://${root.data.instance_id}/${id}`,
            },
          });
        }
        const edge = await client.getEdge(EDGE_ID);
        expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
        expect(edge.data.edge).toEqual(ITEM3.item.edges.about.data[0]);
        const listed = await client.listItems({ source: SOURCE });
        expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
        expect(listed.data.data.map((item) => item.id).sort()).toEqual([
          ...ITEM_IDS,
        ]);
      });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "answers no state writer for an item v0.0.90 wrote, and names the sign-in that moves it after the upgrade",
    async () => {
      await startedOn(async ({ url, client }) => {
        const stateWriter = async (id: string) => {
          const answer = await fetch(`${url}/items/${id}?include=writer`, {
            headers: { authorization: `Bearer ${WORKING_KEY}` },
          });
          expect(answer.status).toBe(200);
          return (
            (await answer.json()) as {
              item: { state_writer?: unknown };
            }
          ).item.state_writer;
        };
        const id = ITEM_IDS[0];
        expect(await stateWriter(id)).toBeNull();
        const moved = await client.transitionItem(id, "archived");
        expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
        expect(await stateWriter(id)).toEqual({
          kind: "key",
          id: expect.any(String),
          name: expect.any(String),
        });
      });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "upgrades the database v0.0.90 wrote to the schema version this build makes, and answers its type as before but for the origin v0.0.91 renamed",
    async () => {
      // The version a database this build makes from nothing has.
      const empty = tempFolder("marfa-upgrade-empty-");
      await startedOn(async () => undefined, { state: empty });
      const made = withInstanceDatabase(join(empty, "marfa.db"), userVersion);
      expect(made).toBeGreaterThan(OLD_SCHEMA);

      let sqlitePath = "";
      await startedOn(async (started) => {
        sqlitePath = started.sqlitePath;
        const type = await started.client.getType(TYPE_ID);
        expect(type.ok, JSON.stringify(type.error)).toBe(true);
        // The one difference in what the type holds is the origin "user", named
        // "registered" since v0.0.91. A shipped parent may have gained fields,
        // so the fields are read as a superset. The read also carries two
        // members v0.0.90 did not have: `ancestor_guidance`, `revision` and
        // `provenance.plugin`, which is null for a type the owner registered.
        expect(type.data).toEqual({
          ...TYPE,
          fields: expect.objectContaining(TYPE.fields),
          ancestor_guidance: expect.any(Array),
          revision: expect.stringMatching(/^[0-9a-f]{64}$/),
          provenance: {
            ...TYPE.provenance,
            origin: "registered",
            plugin: null,
          },
        });
      });
      expect(withInstanceDatabase(sqlitePath, userVersion)).toBe(made);
    },
    FRESH_SERVER_TIMEOUT_MS * 2,
  );

  it(
    "leaves a copy of the database as v0.0.90 wrote it beside the file the start upgraded",
    async () => {
      let loaded: Snapshot | undefined;
      await startedOn(
        async ({ state, sqlitePath }) => {
          expect(copiesBeside(state)).toEqual([COPY]);
          withInstanceDatabase(sqlitePath, (db) => {
            expect(userVersion(db)).toBeGreaterThan(OLD_SCHEMA);
          });
          withInstanceDatabase(join(state, COPY), (db) => {
            // The copy holds what the file held before the start, row for row.
            expect(snapshot(db)).toEqual(loaded);
            expect(userVersion(db)).toBe(OLD_SCHEMA);
            expect(itemIds(db)).toEqual([...ITEM_IDS]);
            // A shape only the schema this build left behind no longer has.
            expect(
              db.prepare("SELECT origin FROM types WHERE id = ?").get(TYPE_ID)
                ?.origin,
            ).toBe("user");
            expect(
              db
                .prepare("SELECT id FROM edges")
                .all()
                .map((row) => row.id),
            ).toEqual([EDGE_ID]);
          });
        },
        {
          alter: (db) => {
            loaded = snapshot(db);
            expect(loaded.userVersion).toBe(OLD_SCHEMA);
            expect(Object.keys(loaded.tables).length).toBeGreaterThan(10);
          },
        },
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps only the copy from before the last upgrade",
    async () => {
      const state = tempFolder("marfa-upgrade-last-");
      const sqlitePath = join(state, "marfa.db");
      loadDump(sqlitePath, (db) =>
        db.exec("INSERT INTO instance (key, value) VALUES ('marker', 'first')"),
      );
      await startedOn(
        async () => {
          expect(copiesBeside(state)).toEqual([COPY]);
        },
        { state },
      );
      withInstanceDatabase(join(state, COPY), (db) => {
        expect(
          db.prepare("SELECT value FROM instance WHERE key = 'marker'").get()
            ?.value,
        ).toBe("first");
      });

      // The file an earlier release wrote, put back, with another marker.
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(sqlitePath + suffix, { force: true });
      }
      loadDump(sqlitePath, (db) =>
        db.exec(
          "INSERT INTO instance (key, value) VALUES ('marker', 'second')",
        ),
      );
      await startedOn(
        async () => {
          expect(copiesBeside(state)).toEqual([COPY]);
        },
        { state },
      );
      withInstanceDatabase(join(state, COPY), (db) => {
        expect(userVersion(db)).toBe(OLD_SCHEMA);
        expect(
          db.prepare("SELECT value FROM instance WHERE key = 'marker'").get()
            ?.value,
        ).toBe("second");
      });
    },
    FRESH_SERVER_TIMEOUT_MS * 2,
  );
});

describe("refusing to start on a database an earlier release wrote", () => {
  /** Boots a refused start on the dump after `alter`, and removes its state. */
  async function refusedOn(
    alter: (db: Database) => void,
    check: (refused: RefusedBoot) => void | Promise<void>,
    extraEnv: Record<string, string> = {},
  ): Promise<void> {
    const refused = await bootRefused("upgrade-refused", {
      prepare: (sqlitePath) => loadDump(sqlitePath, alter),
      extraEnv: { MARFA_KEY_SALT: KEY_SALT, ...extraEnv },
    });
    try {
      await check(refused);
    } finally {
      await refused.stop();
    }
  }

  it(
    "refuses to start when the copy would leave less free space than the disk reserve, and changes nothing",
    async () => {
      // The witness: under no reserve the same file starts and is copied.
      await startedOn(
        async ({ state }) => {
          expect(copiesBeside(state)).toEqual([COPY]);
        },
        { env: { MARFA_DISK_RESERVE_BYTES: "0" } },
      );

      await refusedOn(
        () => undefined,
        (refused) => {
          expectRefusedWhole(refused);
          expectDatabaseUnchanged(refused);
          expect(copiesBeside(refused.stateDir)).toEqual([]);
          withInstanceDatabase(refused.sqlitePath, (db) => {
            expect(userVersion(db)).toBe(OLD_SCHEMA);
            expect(itemIds(db)).toEqual([...ITEM_IDS]);
          });
        },
        { MARFA_DISK_RESERVE_BYTES: HUGE_RESERVE },
      );
    },
    FRESH_SERVER_TIMEOUT_MS * 2,
  );

  it(
    "refuses to start when the copy cannot be written, and changes nothing",
    async () => {
      // The witness: the same file, with nothing in the copy's way, starts and
      // is copied.
      await startedOn(async ({ state }) => {
        expect(copiesBeside(state)).toEqual([COPY]);
      });

      // A directory, holding a file, at the path the copy must take.
      const inTheWay = COPY;
      const refused = await bootRefused("upgrade-copy-unwritable", {
        prepare: (sqlitePath, state) => {
          loadDump(sqlitePath);
          mkdirSync(join(state, inTheWay));
          writeFileSync(join(state, inTheWay, "kept"), "");
        },
        extraEnv: { MARFA_KEY_SALT: KEY_SALT },
      });
      try {
        expectRefusedWhole(refused);
        expectDatabaseUnchanged(refused);
        expect(copiesBeside(refused.stateDir)).toEqual([inTheWay]);
        expect(statSync(join(refused.stateDir, inTheWay)).isDirectory()).toBe(
          true,
        );
        withInstanceDatabase(refused.sqlitePath, (db) => {
          expect(userVersion(db)).toBe(OLD_SCHEMA);
        });
      } finally {
        await refused.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS * 2,
  );

  it(
    "refuses to start when a migration fails, and leaves the database at the version it was with its rows",
    async () => {
      await refusedOn(
        (db) => {
          // A type origin no migration can carry over, written past the check
          // that guards it, so the rebuild of the types table fails.
          db.exec("PRAGMA ignore_check_constraints = ON");
          db.exec(
            `UPDATE types SET origin = 'unknown' WHERE id = '${TYPE_ID}'`,
          );
        },
        (refused) => {
          expectRefusedWhole(refused);
          // The upgrade began, and the copy shows it, before it failed.
          expect(copiesBeside(refused.stateDir)).toEqual([COPY]);
          withInstanceDatabase(refused.sqlitePath, (db) => {
            expect(userVersion(db)).toBe(OLD_SCHEMA);
            expect(itemIds(db)).toEqual([...ITEM_IDS]);
            expect(
              db.prepare("SELECT origin FROM types WHERE id = ?").get(TYPE_ID)
                ?.origin,
            ).toBe("unknown");
            expect(
              db
                .prepare("SELECT id FROM edges")
                .all()
                .map((row) => row.id),
            ).toEqual([EDGE_ID]);
          });
        },
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses to start when the upgrade would leave a row referring to one the database does not hold, and changes nothing",
    async () => {
      await refusedOn(
        (db) => {
          db.exec(
            `INSERT INTO edges (id, from_id, to_id, edge_type, properties, version, created_at, updated_at)
             VALUES ('01f00000-0000-7000-8000-0000000000e2', '01f00000-0000-7000-8000-00000000ffff',
                     '${ITEM_IDS[0]}', 'about', x'7b7d', 1, '2026-11-22T22:12:37.419Z', '2026-11-22T22:12:37.419Z')`,
          );
        },
        (refused) => {
          expectRefusedWhole(refused);
          expectDatabaseUnchanged(refused);
          expect(refused.code).toBe(78);
          withInstanceDatabase(refused.sqlitePath, (db) => {
            expect(userVersion(db)).toBe(OLD_SCHEMA);
            // The row is the one the check can see, and the file still has it.
            expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(
              1,
            );
          });
        },
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
