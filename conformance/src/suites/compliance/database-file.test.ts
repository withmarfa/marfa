import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { controlRequest } from "../../utils/control-request.js";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
  type RefusedBoot,
  type ServerExit,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { listened, refusalText } from "../../utils/refused-boot.js";
import { parseEnvFile, TEST_OWNER } from "../../utils/target.js";
import {
  bootServer,
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";

const NOTE = "core.note";

/** Writes `count` notes and answers their ids. A fresh server's working key
 *  writes under the label it was booted with. */
async function writeNotes(
  server: FreshServer,
  source: string,
  count: number,
  tag = "",
): Promise<string[]> {
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const note = await client.createItem({
      type: NOTE,
      source,
      properties: { body: `${tag} ${String(i)}` },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    ids.push(note.data.item.id);
  }
  return ids;
}

/** The ids of every item the database file holds, read from a copy of it
 *  with no log beside it, so what the file alone holds is all that is read. */
function itemIdsInFileAlone(sqlitePath: string): Set<string> {
  const copy = mkdtempSync(join(tmpdir(), "marfa-file-alone-"));
  try {
    cpSync(sqlitePath, join(copy, "marfa.db"));
    return withInstanceDatabase(
      join(copy, "marfa.db"),
      (db) =>
        new Set(
          db
            .prepare("SELECT id FROM items")
            .all()
            .map((row) => String(row.id)),
        ),
    );
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function logBytes(sqlitePath: string): number {
  const log = `${sqlitePath}-wal`;
  return existsSync(log) ? statSync(log).size : 0;
}

/**
 * A process that holds a read transaction on the database until it is killed,
 * so the log cannot be moved past the point that transaction reads. Killed
 * rather than closed: closing the last connection would move the log itself.
 */
class HeldReader {
  private constructor(private readonly child: ChildProcess) {}

  static async take(sqlitePath: string): Promise<HeldReader> {
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { DatabaseSync } = require("node:sqlite");',
          "const db = new DatabaseSync(process.env.HELD_DATABASE);",
          'db.exec("BEGIN");',
          'db.prepare("SELECT count(*) FROM items").get();',
          'process.stdout.write("held\\n");',
          "setInterval(() => undefined, 1000);",
        ].join("\n"),
      ],
      {
        env: { ...process.env, HELD_DATABASE: sqlitePath },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const reader = new HeldReader(child);
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("held\n")) resolve();
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        reject(new Error(`the reader could not take its snapshot: ${chunk}`));
      });
      child.once("close", () =>
        reject(new Error("the reader ended before it held a snapshot")),
      );
    });
    return reader;
  }

  async release(): Promise<void> {
    const closed = new Promise<void>((resolve) =>
      this.child.once("close", () => resolve()),
    );
    this.child.kill("SIGKILL");
    await closed;
  }
}

describe("stopping the instance on SIGTERM or SIGINT leaves its writes in the database file", () => {
  let server: FreshServer;

  beforeAll(async () => {
    server = await bootFreshServer("lifecycle-stop");
  }, FRESH_SERVER_TIMEOUT_MS);

  it.each(["SIGTERM", "SIGINT"] as const)(
    "moves every acknowledged write into the database file when stopped on %s",
    async (signal) => {
      const ids = await writeNotes(server, "lifecycle-stop", 20, signal);
      // The witness: the log holds these writes while the server runs, so a
      // copy of the file alone is missing them, and the move is the stop's.
      const whileRunning = itemIdsInFileAlone(server.sqlitePath);
      expect(ids.some((id) => !whileRunning.has(id))).toBe(true);
      expect(logBytes(server.sqlitePath)).toBeGreaterThan(0);

      let logAfterStop = -1;
      let inFileAlone = new Set<string>();
      const stopped = await server.restart({
        signal,
        whileStopped: () => {
          logAfterStop = logBytes(server.sqlitePath);
          inFileAlone = itemIdsInFileAlone(server.sqlitePath);
        },
      });

      expect(stopped).toMatchObject({ code: 0, signal: null });
      expect(logAfterStop).toBe(0);
      for (const id of ids) expect(inFileAlone.has(id)).toBe(true);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "leaves the writes in the log while another connection holds a snapshot, and the next start answers every one of them",
    async () => {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        const before = await writeNotes(
          server,
          "lifecycle-stop",
          10,
          `before the snapshot, ${signal}`,
        );
        const reader = await HeldReader.take(server.sqlitePath);
        let after: string[];
        let stopped: ServerExit;
        let logAfterStop = -1;
        let inFileAlone = new Set<string>();
        try {
          // Written after the reader's snapshot began, so the log cannot be
          // moved past them while the reader holds it.
          after = await writeNotes(
            server,
            "lifecycle-stop",
            10,
            `after the snapshot, ${signal}`,
          );
          stopped = await server.restart({
            signal,
            whileStopped: () => {
              logAfterStop = logBytes(server.sqlitePath);
              inFileAlone = itemIdsInFileAlone(server.sqlitePath);
            },
          });
        } finally {
          await reader.release();
        }

        // The witness that the log was kept: it holds bytes, and the file
        // alone lacks writes the log holds.
        expect(logAfterStop, signal).toBeGreaterThan(0);
        expect(
          after.some((id) => !inFileAlone.has(id)),
          signal,
        ).toBe(true);
        expect(stopped.code, signal).toBe(0);

        // Applied by the start that followed, with the reader gone.
        const client = new MarfaClient({
          baseUrl: server.apiUrl,
          apiKey: server.workingKey,
        });
        for (const id of [...before, ...after]) {
          const item = await client.getItem(id);
          expect(item.status, `${signal} ${id}`).toBe(200);
        }
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});

/** The salt in the log's header. A checkpoint that has moved the whole log
 *  into the database file makes the next write start the log over under a
 *  new one, so a change of salt shows that the log's early writes are gone. */
function logSalt(sqlitePath: string): string {
  const log = `${sqlitePath}-wal`;
  if (!existsSync(log)) return "";
  const header = Buffer.alloc(24);
  const fd = openSync(log, "r");
  try {
    readSync(fd, header, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  return header.subarray(16, 24).toString("hex");
}

interface Written {
  id: string;
  hash: string;
  bytes: Uint8Array;
}

/** The size of the text each note carries beyond its blob, so that the log
 *  outgrows its automatic checkpoint within a few dozen writes. */
const NOTE_PADDING_BYTES = 60_000;

/** Writes a note naming a fresh blob, again and again, until stopped. */
function writeUntilStopped(client: MarfaClient): {
  acknowledged: Written[];
  /** The bytes of padding the acknowledged notes carry. */
  written: () => number;
  stop: () => Promise<void>;
} {
  const acknowledged: Written[] = [];
  let padded = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const bytes = randomBytes(2_000 + acknowledged.length);
      const upload = await client.uploadBlob(bytes, "application/octet-stream");
      if (!upload.ok) {
        throw new Error(`upload refused: ${JSON.stringify(upload)}`);
      }
      const padding = randomBytes(NOTE_PADDING_BYTES / 2).toString("hex");
      const note = await client.createItem({
        type: NOTE,
        source: "lifecycle-copy",
        properties: { body: `![bytes](${upload.data.hash}) ${padding}` },
      });
      if (!note.ok) throw new Error(`note refused: ${JSON.stringify(note)}`);
      acknowledged.push({
        id: note.data.item.id,
        hash: upload.data.hash,
        bytes,
      });
      padded += NOTE_PADDING_BYTES;
    }
  })();
  return {
    acknowledged,
    written: () => padded,
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

describe("copying the data directory one file after another while the instance writes", () => {
  let server: FreshServer;
  const states: string[] = [];

  beforeAll(async () => {
    server = await bootFreshServer("lifecycle-copy");
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    for (const state of states.splice(0)) {
      await stopServer({ state });
      rmSync(state, { recursive: true, force: true });
    }
  }, FRESH_SERVER_TIMEOUT_MS);

  async function until(
    what: string,
    done: () => boolean,
    budgetMs = 60_000,
  ): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`never reached: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Boots a server on `image` and reads it back as the original's client. */
  async function bootImage(image: string): Promise<MarfaClient | undefined> {
    try {
      await bootServer({ state: image });
    } catch {
      return undefined;
    }
    const env = parseEnvFile(readFileSync(join(image, "env"), "utf8"));
    expect(env.MARFA_API_URL).toBeTruthy();
    return new MarfaClient({
      baseUrl: env.MARFA_API_URL ?? "",
      apiKey: server.workingKey,
    });
  }

  it(
    "restores every write acknowledged before the first read from a copy taken file by file under a held read transaction, and loses writes from the same copy without one",
    async () => {
      const writer = writeUntilStopped(
        new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey }),
      );
      await until("a log with writes in it", () => {
        return writer.acknowledged.length >= 10;
      });

      /** The database file, then the log, then the blobs, each copied after
       *  `between` has let the writer run on. */
      async function copyOneAfterAnother(
        between: (copied: string) => Promise<void>,
      ): Promise<{ image: string; before: Written[]; after: Written[] }> {
        const image = mkdtempSync(join(tmpdir(), "marfa-copy-image-"));
        states.push(image);
        cpSync(server.stateDir, image, {
          recursive: true,
          // What the running process owns, and the three the copy reads in
          // its own order.
          filter: (source) =>
            !/server\.(pid|log|exit)$/.test(source) &&
            !/\/control-directory$/.test(source) &&
            !/\/owner-session\.json(?:\.lock|\.[^/]+\.tmp)?$/.test(source) &&
            !/marfa\.db(-wal|-shm)?$/.test(source) &&
            !/\/blobs$/.test(source),
        });
        const before = writer.acknowledged.slice();
        copyFileSync(server.sqlitePath, join(image, "marfa.db"));
        await between("database");
        copyFileSync(`${server.sqlitePath}-wal`, join(image, "marfa.db-wal"));
        await between("log");
        cpSync(join(server.stateDir, "blobs"), join(image, "blobs"), {
          recursive: true,
        });
        return { image, before, after: writer.acknowledged.slice() };
      }

      /** What a copy cannot answer of what it must, and a blob a copied item
       *  names that the copy does not serve. `undefined` for a copy that
       *  does not start. */
      async function readBack(copy: {
        image: string;
        before: Written[];
        after: Written[];
      }): Promise<{ lost: number; blobless: number } | undefined> {
        const client = await bootImage(copy.image);
        if (client === undefined) return undefined;
        let lost = 0;
        let blobless = 0;
        for (const written of copy.before) {
          if ((await client.getItem(written.id)).status !== 200) lost++;
        }
        for (const written of copy.after) {
          if ((await client.getItem(written.id)).status !== 200) continue;
          const blob = await client.downloadBlob(written.hash);
          if (
            !blob.ok ||
            !Buffer.from(blob.data).equals(Buffer.from(written.bytes))
          ) {
            blobless++;
          }
        }
        return { lost, blobless };
      }

      // The witness: with no reader, a checkpoint that lands between the
      // database file and the log leaves a copy that has lost writes. The
      // copy loses none when its database file happens to be taken just after
      // a checkpoint, so it is taken again until one does.
      let needed = 0;
      let witnessed: object | undefined;
      for (let attempt = 0; attempt < 8 && witnessed === undefined; attempt++) {
        let saltAtDatabase = "";
        let writtenAtDatabase = 0;
        const unheld = await copyOneAfterAnother(async (copied) => {
          if (copied === "database") {
            saltAtDatabase = logSalt(server.sqlitePath);
            writtenAtDatabase = writer.written();
            await until(
              "a checkpoint that restarts the log",
              () => logSalt(server.sqlitePath) !== saltAtDatabase,
            );
            needed = Math.max(needed, writer.written() - writtenAtDatabase);
          } else {
            const target = writer.acknowledged.length + 3;
            await until(
              "more writes",
              () => writer.acknowledged.length >= target,
            );
          }
        });
        const report = await readBack(unheld);
        if (report === undefined || report.lost > 0) {
          witnessed = report ?? { starts: false };
        }
      }
      expect(witnessed, "no copy without a reader lost a write").toBeDefined();

      // The same copy under a read transaction that began before the first
      // read, over at least twice the writes a checkpoint took above.
      const reader = await HeldReader.take(server.sqlitePath);
      let held: Awaited<ReturnType<typeof copyOneAfterAnother>>;
      try {
        held = await copyOneAfterAnother(async (copied) => {
          if (copied === "database") {
            const target = writer.written() + 2 * needed;
            await until(
              "writes enough to checkpoint twice over",
              () => writer.written() >= target,
            );
          } else {
            const target = writer.acknowledged.length + 3;
            await until(
              "more writes",
              () => writer.acknowledged.length >= target,
            );
          }
        });
      } finally {
        await reader.release();
      }
      await writer.stop();

      expect(held.before.length).toBeGreaterThanOrEqual(10);
      expect(await readBack(held)).toEqual({ lost: 0, blobless: 0 });
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a completed claim after credential rows disappear", () => {
  it.each(["keys", "owner", "both"] as const)(
    "does not reopen setup after deleting %s rows",
    async (missing) => {
      const server = await bootFreshServer(`lifecycle-missing-${missing}`);
      try {
        const before = await controlRequest(
          server.controlSocket,
          "/_control/setup/status",
        );
        expect(before.body.claimed).toBe(true);
        const announcements = () =>
          readFileSync(join(server.stateDir, "server.log"), "utf8").split(
            "Claim this Marfa at /setup with setup code:",
          ).length - 1;
        expect(announcements()).toBe(1);
        await stopServer({ state: server.stateDir });
        withInstanceDatabase(server.sqlitePath, (db) => {
          db.exec("PRAGMA foreign_keys = OFF");
          if (missing !== "owner") db.exec("DELETE FROM api_keys");
          if (missing !== "keys")
            db.exec(
              "DELETE FROM auth_session; DELETE FROM auth_account; DELETE FROM auth_user",
            );
        });
        const restarted = await bootUnclaimedServer({ state: server.stateDir });
        const status = await controlRequest(
          restarted.controlSocket,
          "/_control/setup/status",
        );
        expect(status.body).toEqual(before.body);
        expect(announcements()).toBe(1);
        expect(
          (
            await controlRequest(
              restarted.controlSocket,
              "/_control/setup/code",
              { method: "POST", body: {} },
            )
          ).status,
        ).toBe(409);
        expect(
          (
            await controlRequest(
              restarted.controlSocket,
              "/_control/setup/claim",
              { method: "POST", body: TEST_OWNER },
            )
          ).status,
        ).toBe(409);
        const publicClaim = await fetch(`${restarted.url}/setup/claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(TEST_OWNER),
        });
        expect(publicClaim.status).toBe(409);
        expect(
          (await controlRequest(restarted.controlSocket, "/owner")).status,
        ).toBe(missing === "keys" ? 200 : 404);
        const recovery = await controlRequest(
          restarted.controlSocket,
          "/_control/owner/recover",
          { method: "POST", body: { password: "recovered existing password" } },
        );
        expect(recovery.status).toBe(missing === "keys" ? 200 : 404);
        if (missing !== "keys")
          expect(recovery.body).toMatchObject({
            error: { code: "owner_not_found" },
          });
        expect(
          (
            await controlRequest(
              restarted.controlSocket,
              "/_control/setup/status",
            )
          ).body,
        ).toEqual(before.body);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

/** The exit status of a database this build did not write, which a
 *  supervisor reads as "starting again will meet the same file". */
const REFUSED_DATABASE_STATUS = 78;

const EMPTY_FILE = createHash("sha256").update("").digest("hex");

/**
 * The database file is byte for byte what it was, and the log beside it holds
 * nothing: opening a database that is in WAL mode makes an empty log and an
 * index of it even when the open is refused, and neither is a change to what
 * the database holds.
 */
function expectDatabaseUnchanged(refused: RefusedBoot): void {
  expect(refused.after.db).toBe(refused.before.db);
  expect(["absent", EMPTY_FILE]).toContain(refused.after.wal);
}

type Database = Parameters<Parameters<typeof withInstanceDatabase>[1]>[0];

describe("starting on a database this build did not write", () => {
  let donor: FreshServer;
  /** A database of this build, stopped and with rows in it. */
  let image: string;
  /** The same database after one more start and stop. */
  let imageAfterAStart: string;
  const kept: string[] = [];

  beforeAll(async () => {
    donor = await bootFreshServer("lifecycle-refused");
    await writeNotes(donor, "lifecycle-refused", 5);
    const dir = mkdtempSync(join(tmpdir(), "marfa-refused-donor-"));
    kept.push(dir);
    image = join(dir, "first.db");
    imageAfterAStart = join(dir, "second.db");
    await donor.restart({
      whileStopped: () => cpSync(donor.sqlitePath, image),
    });
    await donor.restart({
      whileStopped: () => cpSync(donor.sqlitePath, imageAfterAStart),
    });
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await donor.stop();
    for (const dir of kept.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Runs `check` on a boot refused on a copy of the donor's database that
   *  `change` has altered, and removes its state. */
  async function expectRefusal(
    change: (db: Database) => void,
    check: (refused: RefusedBoot) => void,
  ): Promise<void> {
    const refused = await bootRefused("lifecycle-refusal", {
      prepare: (sqlitePath) => {
        cpSync(image, sqlitePath);
        withInstanceDatabase(sqlitePath, change);
      },
    });
    try {
      check(refused);
    } finally {
      await refused.stop();
    }
  }

  const CAUSES: [string, (db: Database) => void, RegExp][] = [
    [
      "a table that lacks a column this build declares",
      (db) => db.exec("ALTER TABLE audit_log DROP COLUMN client_ip"),
      /is not this build's: .*audit_log table lacks client_ip/,
    ],
    [
      "a table that carries a column this build does not declare",
      (db) => db.exec("ALTER TABLE audit_log ADD COLUMN stray TEXT"),
      /is not this build's: .*stray/,
    ],
    [
      "an index this build does not declare",
      (db) => db.exec("CREATE INDEX stray_index ON items (id)"),
      /is not this build's: .*stray_index/,
    ],
  ];

  it("starts on the database the refusals below are made from, and a start that is not refused changes the file", async () => {
    const health = await fetch(`${donor.apiUrl}/health`);
    const client = new MarfaClient({
      baseUrl: donor.apiUrl,
      apiKey: donor.workingKey,
    });
    const listed = await client.listItems({ source: "lifecycle-refused" });
    const digest = (path: string): string =>
      createHash("sha256").update(readFileSync(path)).digest("hex");

    expect(health.status).toBe(200);
    expect(listed.ok && listed.data.data.length).toBe(5);
    expect(digest(imageAfterAStart)).not.toBe(digest(image));
  });

  it.each(CAUSES)(
    "refuses a database holding %s, changes nothing in its files, and opens no port",
    async (_cause, change, message) => {
      await expectRefusal(change, (refused) => {
        expectDatabaseUnchanged(refused);
        expect(refusalText(refused)).toMatch(message);
        expect(refusalText(refused)).toContain(refused.sqlitePath);
        expect(listened(refused)).toBe(false);
      });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses to start on a database a newer build wrote, and leaves it as it was",
    async () => {
      await expectRefusal(
        (db) => db.exec("PRAGMA user_version = 1000"),
        (refused) => {
          expect(refused).toMatchObject({
            code: REFUSED_DATABASE_STATUS,
            signal: null,
          });
          expectDatabaseUnchanged(refused);
          expect(listened(refused)).toBe(false);
          expect(refusalText(refused)).toContain("which a newer build wrote");
          expect(refusalText(refused)).toContain(refused.sqlitePath);
        },
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "says in its refusal to export with the build that wrote the file, start on a fresh file and restore the archive there, and that the restore can refuse",
    async () => {
      for (const [cause, change] of CAUSES) {
        await expectRefusal(change, (refused) => {
          const text = refusalText(refused);
          expect(text, cause).toMatch(
            /export (it )?with the build that wrote/i,
          );
          expect(text, cause).toMatch(/start (this build )?on a fresh file/i);
          expect(text, cause).toContain("restore the archive there");
          expect(text, cause).toMatch(/restore\b.*\bcan refuse/i);
        });
      }
    },
    CAUSES.length * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "exits with status 78, not 1, when it refuses a database this build did not write",
    async () => {
      for (const [cause, change] of CAUSES) {
        await expectRefusal(change, (refused) => {
          expect(refused, cause).toMatchObject({
            code: REFUSED_DATABASE_STATUS,
            signal: null,
          });
        });
      }
    },
    CAUSES.length * FRESH_SERVER_TIMEOUT_MS,
  );
});

/** Every row of every table this build keeps removed (the tables SQLite keeps
 *  for a virtual table excepted), then `drop` taken out: the file a start
 *  leaves when it stops partway through making its tables. */
function emptyThenDrop(db: Database, drop: readonly string[]): void {
  db.exec("PRAGMA foreign_keys = OFF");
  const tables = db
    .prepare(
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => String(row.name));
  for (const table of tables) db.exec(`DELETE FROM \`${table}\``);
  for (const table of drop) db.exec(`DROP TABLE \`${table}\``);
}

/** Every table the database holds, by name. */
function tablesIn(db: Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row.name));
}

describe("starting on a database that holds some of the server's tables and no rows", () => {
  const DROPPED = ["audit_log", "items"];
  let server: FreshServer;
  let image: string;
  const kept: string[] = [];

  beforeAll(async () => {
    server = await bootFreshServer("lifecycle-unfinished");
    await writeNotes(server, "lifecycle-unfinished", 5);
    const dir = mkdtempSync(join(tmpdir(), "marfa-unfinished-donor-"));
    kept.push(dir);
    image = join(dir, "marfa.db");
    await server.restart({
      whileStopped: () => cpSync(server.sqlitePath, image),
    });
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
    for (const dir of kept.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function rootInstanceId(): Promise<string> {
    const root = (await (await fetch(`${server.apiUrl}/`)).json()) as {
      instance_id: string;
    };
    return root.instance_id;
  }

  async function startUnprovisioned(change: (db: Database) => void) {
    await stopServer({ state: server.stateDir });
    withInstanceDatabase(server.sqlitePath, change);
    const started = await bootUnclaimedServer({ state: server.stateDir });
    server.apiUrl = started.url;
    server.controlSocket = started.controlSocket;
  }

  it(
    "creates the tables it lacks and remains unclaimed until a real claim",
    async () => {
      const noteIds = await writeNotes(server, "lifecycle-unfinished", 3);
      const instanceBefore = await rootInstanceId();
      await startUnprovisioned((db) => {
        emptyThenDrop(db, DROPPED);
        for (const table of DROPPED) expect(tablesIn(db)).not.toContain(table);
      });
      expect((await fetch(`${server.apiUrl}/health`)).status).toBe(200);
      expect(
        (await controlRequest(server.controlSocket, "/_control/setup/status"))
          .body.claimed,
      ).toBe(false);
      expect(
        (await controlRequest(server.controlSocket, "/owner")).status,
      ).toBe(404);
      expect(await rootInstanceId()).not.toBe(instanceBefore);
      withInstanceDatabase(server.sqlitePath, (db) => {
        for (const table of DROPPED) expect(tablesIn(db)).toContain(table);
        expect(
          db.prepare("SELECT count(*) AS count FROM api_keys").get()?.count,
        ).toBe(0);
        expect(
          db.prepare("SELECT count(*) AS count FROM items").get()?.count,
        ).toBe(0);
      });
      expect(
        (
          await controlRequest(server.controlSocket, "/_control/setup/claim", {
            method: "POST",
            body: TEST_OWNER,
          })
        ).status,
      ).toBe(201);
      const minted = await controlRequest(server.controlSocket, "/keys", {
        method: "POST",
        body: {
          label: "unfinished-schema",
          source: "lifecycle-unfinished",
          permissions: ["audit.read"],
          type_permissions: { "*": "write" },
        },
      });
      expect(minted.status).toBe(201);
      const client = new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: minted.body.key as string,
      });
      expect((await client.getItem(noteIds[0] ?? "")).status).toBe(404);
      const written = await client.createItem({
        type: NOTE,
        source: "lifecycle-unfinished",
        properties: { body: "written after the tables were made" },
      });
      expect(written.status).toBe(201);
      expect((await client.getItem(written.data.item.id)).status).toBe(200);
      const audit = await client.listAudit({ action: "owner.claimed" });
      expect(audit.status).toBe(200);
      expect(audit.data.data).toHaveLength(1);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  /** Boots on the donor's database changed by `change`, expects it refused,
   *  and checks the refusal names `message`. */
  async function expectUnfinishedRefused(
    change: (db: Database) => void,
    message: RegExp,
  ): Promise<void> {
    const refused = await bootRefused("lifecycle-unfinished-refused", {
      prepare: (sqlitePath) => {
        cpSync(image, sqlitePath);
        withInstanceDatabase(sqlitePath, change);
      },
    });
    try {
      expect(refused).toMatchObject({
        code: REFUSED_DATABASE_STATUS,
        signal: null,
      });
      expectDatabaseUnchanged(refused);
      expect(refusalText(refused)).toMatch(message);
      expect(listened(refused)).toBe(false);
    } finally {
      await refused.stop();
    }
  }

  it(
    "refuses a database that lacks a table and holds a row in one it creates, and changes nothing",
    async () => {
      await expectUnfinishedRefused(
        (db) => db.exec("DROP TABLE audit_log"),
        /is not this build's: .*the file lacks the audit_log table/,
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a database that lacks a table and has a column it does not declare, though it holds no rows",
    async () => {
      await expectUnfinishedRefused((db) => {
        emptyThenDrop(db, DROPPED);
        db.exec("ALTER TABLE api_keys ADD COLUMN stray TEXT");
      }, /is not this build's: .*stray/);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("starting on a file that is not a database", () => {
  it(
    "exits with status 1, not 78, when the database file is not a database at all",
    async () => {
      const refused = await bootRefused("lifecycle-not-a-database", {
        prepare: (sqlitePath) =>
          writeFileSync(sqlitePath, "this is not a SQLite file\n".repeat(20)),
      });
      try {
        expect(refused).toMatchObject({ code: 1, signal: null });
        expect(refusalText(refused)).not.toContain("is not this build's");
        expect(listened(refused)).toBe(false);
      } finally {
        await refused.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
