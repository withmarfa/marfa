import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
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
import { listened, refusalText } from "../../utils/refused-boot.js";
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
 * **The first test is the witness for the rest.** The file starts, takes
 * requests and answers every read as v0.0.90 did, so a refusal below is the
 * alteration's doing and not a file this build cannot upgrade.
 */

const DUMP = join(import.meta.dirname, "fixtures", "database-v0.0.90.sql");
/** The salt the release generated for its keys, which a key is valid only against. */
const KEY_SALT =
  "7cfda7f179b0d70e6efd313c6557d3373939fa041fcfd865246abbc0b87c02c7";

/** The working key v0.0.90 minted for the dump, which holds only its hash. */
const WORKING_KEY =
  "marfa_k1_e44eeff0eb91f8df57ecbe088e4a903dde5a66a38f2e3231feeae41ebe0a477a";
const SOURCE = "upgrade-fixture";
const ITEM_IDS = [
  "01f00000-0000-7000-8000-000000000001",
  "01f00000-0000-7000-8000-000000000002",
  "01f00000-0000-7000-8000-000000000003",
] as const;
const EDGE_ID = "01f00000-0000-7000-8000-0000000000e1";
const TYPE_ID = "user.upgrade_witness";
const COPY = "marfa.db.before-upgrade";
/** The schema version v0.0.90 wrote. */
const OLD_SCHEMA = 3;
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

/**
 * Writes the dump into `sqlitePath` as the release left it: a file in
 * write-ahead mode with no log beside it. Foreign keys are off for `alter`, so
 * a row can refer to what the file does not hold. The dump writes the schema of
 * two full-text tables, which a connection refuses while it is defensive.
 */
function loadDump(sqlitePath: string, alter?: (db: Database) => void): void {
  const db = new DatabaseSync(sqlitePath, {
    defensive: false,
    enableForeignKeyConstraints: false,
  });
  try {
    db.exec(readFileSync(DUMP, "utf8"));
    db.exec("PRAGMA journal_mode = WAL");
    alter?.(db);
  } finally {
    db.close();
  }
}

/** Every file beside the database that holds a copy from before an upgrade. */
function copiesBeside(state: string): string[] {
  return readdirSync(state).filter((name) => name.startsWith(COPY));
}

function userVersion(db: Database): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version);
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

const EMPTY_FILE = createHash("sha256").update("").digest("hex");

/**
 * The database file is byte for byte what it was, and the log beside it holds
 * nothing: opening a database in write-ahead mode makes an empty log and an
 * index of it even when the open is refused, and neither is a change to what
 * the database holds.
 */
function expectDatabaseUnchanged(refused: RefusedBoot): void {
  expect(refused.after.db).toBe(refused.before.db);
  expect(["absent", EMPTY_FILE]).toContain(refused.after.wal);
}

describe("starting on a database an earlier release wrote", () => {
  it(
    "upgrades the database v0.0.90 wrote and answers every read as that release did",
    async () => {
      await startedOn(async ({ url, client }) => {
        expect((await fetch(`${url}/health`)).status).toBe(200);
        for (const [id, recorded] of [
          [ITEM_IDS[0], ITEM1],
          [ITEM_IDS[1], ITEM2],
          [ITEM_IDS[2], ITEM3],
        ] as const) {
          const read = await client.getItem(id);
          expect(read.ok, JSON.stringify(read.error)).toBe(true);
          expect(read.data, id).toEqual(recorded);
        }
        const type = await client.getType(TYPE_ID);
        expect(type.ok, JSON.stringify(type.error)).toBe(true);
        // The type is read as the build now declares it: a shipped parent may
        // have gained fields, and the origin "user" is now named "registered".
        // What the owner registered, and who registered it, is as it was.
        expect(type.data).toMatchObject({
          id: TYPE.id,
          parent: TYPE.parent,
          label: TYPE.label,
          plural: TYPE.plural,
          fields: {
            priority: TYPE.fields.priority,
            stars: TYPE.fields.stars,
            body: TYPE.fields.body,
          },
          provenance: {
            origin: "registered",
            created_by: TYPE.provenance.created_by,
          },
        });
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
    "leaves a copy of the database as v0.0.90 wrote it beside the file the start upgraded",
    async () => {
      await startedOn(async ({ state, sqlitePath }) => {
        expect(copiesBeside(state)).toEqual([COPY]);
        withInstanceDatabase(sqlitePath, (db) => {
          expect(userVersion(db)).toBeGreaterThan(OLD_SCHEMA);
        });
        withInstanceDatabase(join(state, COPY), (db) => {
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
      });
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
          expect(refused.after.shm).toBe(refused.before.shm);
          expect(copiesBeside(refused.stateDir)).toEqual([]);
          expect(refusalText(refused)).toContain(refused.sqlitePath);
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
            // Nothing a migration made is left behind.
            expect(
              db
                .prepare(
                  "SELECT name FROM sqlite_schema WHERE name IN ('types_next', 'plugins')",
                )
                .all(),
            ).toEqual([]);
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
          expect(refused.after.shm).toBe(refused.before.shm);
          expect(refusalText(refused)).toContain("edges");
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
