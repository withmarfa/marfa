import { controlRequest } from "../../utils/control-request.js";
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
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  approvedAppToken,
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
  type RefusedBoot,
  type ServerExit,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { parseEnvFile, TEST_OWNER } from "../../utils/target.js";
import {
  bootServer,
  bootUnclaimedServer,
  stopServer,
} from "../../../scripts/marfa-server.js";

/**
 * What an instance does when it starts and when it stops: the instance
 * chapter's `instance/image-*`, `instance/stop-*`, `instance/salt-*`,
 * `instance/upgrade-*` and `instance/unfinished-*` rules, and the settings it
 * refuses at boot.
 *
 * Every body here boots a server of its own, because the subject is the
 * process: how it ends, what it leaves in its files, and what it does with a
 * start it will not make. The run's shared server answers none of that.
 */

/** The longest a stop may take, by the contract (`instance/stop-within-eight`). */
const STOP_WITHIN_MS = 8_000;

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
      await server.restart({
        signal,
        whileStopped: () => {
          logAfterStop = logBytes(server.sqlitePath);
          inFileAlone = itemIdsInFileAlone(server.sqlitePath);
        },
      });

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

describe("the exit status of a stop", () => {
  let server: FreshServer;

  beforeAll(async () => {
    server = await bootFreshServer("lifecycle-exit");
  }, FRESH_SERVER_TIMEOUT_MS);

  it.each(["SIGTERM", "SIGINT"] as const)(
    "exits with status 0 within eight seconds when stopped on %s",
    async (signal) => {
      await writeNotes(server, "lifecycle-exit", 3, signal);

      const stopped = await server.restart({ signal });

      expect(stopped).toMatchObject({ code: 0, signal: null });
      expect(stopped.ms).toBeLessThan(STOP_WITHIN_MS);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "exits with status 0 within eight seconds when stopped with an event stream open",
    async () => {
      const response = await fetch(`${server.apiUrl}/events`, {
        headers: { Authorization: `Bearer ${server.workingKey}` },
      });
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      // The stream was live, so the stop had something to end.
      while (!text.includes("event: stream_live")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        text += decoder.decode(chunk.value, { stream: true });
      }

      const stopped = await server.restart();
      await reader.cancel().catch(() => undefined);

      expect(stopped).toMatchObject({ code: 0, signal: null });
      expect(stopped.ms).toBeLessThan(STOP_WITHIN_MS);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "exits with status 1, not 0, when a request in flight is still open at the end of the stop's wait",
    async () => {
      // A body that never ends: the request is in flight at the signal and
      // does not finish, so the server cannot close within its own bound.
      const open = request(`${server.apiUrl}/blobs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${server.workingKey}`,
          "Content-Type": "application/octet-stream",
          "Transfer-Encoding": "chunked",
          Expect: "100-continue",
        },
      });
      open.on("error", () => undefined);
      // The server writes `100 Continue` as it hands the request to the
      // application, so the request is in flight once this arrives.
      await new Promise<void>((resolve, reject) => {
        open.once("continue", resolve);
        open.once("error", reject);
        open.flushHeaders();
      });
      open.write(randomBytes(1_000));

      const stopped = await server.restart();
      open.destroy();

      expect(stopped).toMatchObject({ code: 1, signal: null });
      expect(stopped.ms).toBeLessThan(STOP_WITHIN_MS);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("starting on an image a crash leaves", () => {
  let server: FreshServer;
  const states: string[] = [];

  beforeAll(async () => {
    server = await bootFreshServer("lifecycle-crash");
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    for (const state of states.splice(0)) {
      await stopServer({ state });
      rmSync(state, { recursive: true, force: true });
    }
  }, FRESH_SERVER_TIMEOUT_MS);

  it(
    "answers every write acknowledged before the process was killed, and every blob they name",
    async () => {
      const client = new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: server.workingKey,
      });
      const acknowledged: { id: string; hash: string; bytes: Uint8Array }[] =
        [];
      let running = true;
      // Written until the process is gone, so the kill lands mid-write.
      const writer = (async () => {
        while (running) {
          const bytes = randomBytes(2_000 + acknowledged.length);
          const upload = await client.uploadBlob(
            bytes,
            "application/octet-stream",
          );
          if (!upload.ok) return;
          const note = await client.createItem({
            type: NOTE,
            source: "lifecycle-crash",
            properties: { body: `![bytes](${upload.data.hash})` },
          });
          if (!note.ok) return;
          acknowledged.push({
            id: note.data.item.id,
            hash: upload.data.hash,
            bytes,
          });
        }
      })();
      while (acknowledged.length < 30) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const image = mkdtempSync(join(tmpdir(), "marfa-crash-image-"));
      states.push(image);
      const before = acknowledged.slice();
      const killed = await server.restart({
        signal: "SIGKILL",
        whileStopped: () => {
          cpSync(server.stateDir, image, {
            recursive: true,
            // What the running process owns rather than what it holds.
            filter: (source) => !/server\.(pid|log|exit)$/.test(source),
          });
        },
      });
      running = false;
      await writer;
      // The witness that this was a crash and not a stop: no status, and
      // the log was left beside the database for the start to apply.
      expect(killed).toMatchObject({ code: null, signal: "SIGKILL" });
      expect(existsSync(join(image, "marfa.db-wal"))).toBe(true);

      await bootServer({ state: image });
      const env = parseEnvFile(readFileSync(join(image, "env"), "utf8"));
      const apiUrl = env.MARFA_API_URL;
      expect(apiUrl).toBeTruthy();
      expect((await fetch(`${apiUrl}/health`)).status).toBe(200);
      const restored = new MarfaClient({
        baseUrl: apiUrl ?? "",
        apiKey: server.workingKey,
      });
      expect(before.length).toBeGreaterThanOrEqual(30);
      for (const written of before) {
        expect((await restored.getItem(written.id)).status).toBe(200);
        const blob = await restored.downloadBlob(written.hash);
        expect(blob.ok).toBe(true);
        if (blob.ok) {
          expect(
            Buffer.from(blob.data).equals(Buffer.from(written.bytes)),
          ).toBe(true);
        }
      }
      const next = await restored.createItem({
        type: NOTE,
        source: "lifecycle-crash",
        properties: { body: "written after the restore" },
      });
      expect(next.status).toBe(201);
    },
    FRESH_SERVER_TIMEOUT_MS,
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

      /** What a copy cannot answer of what it must, and a blob a copied row
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

describe("starting on a data directory with another API_KEY_SALT", () => {
  const OTHER_SALT = "another-salt-".padEnd(40, "x");
  let server: FreshServer;
  let appToken: string;

  beforeAll(async () => {
    server = await bootFreshServer("lifecycle-salt");
    appToken = await approvedAppToken(server);
  }, FRESH_SERVER_TIMEOUT_MS);

  /** What a door answers a credential: the status and the error's code. */
  async function ask(
    path: string,
    credential?: string,
    init: RequestInit = {},
  ): Promise<{ status: number; code?: string }> {
    const response = await fetch(`${server.apiUrl}${path}`, {
      ...init,
      headers: {
        ...(credential === undefined
          ? {}
          : { Authorization: `Bearer ${credential}` }),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string };
    };
    return { status: response.status, code: body.error?.code };
  }

  it(
    "refuses the working key, the management key and an app's access token with 401 unauthorized, and accepts all three again under the original salt",
    async () => {
      const doors = [
        {
          who: "working key",
          path: "/items?limit=1",
          credential: () => server.workingKey,
        },
        {
          who: "management key",
          path: "/keys",
          credential: () => server.managementKey,
        },
        {
          who: "app token",
          path: "/items?limit=1",
          credential: () => appToken,
        },
      ];
      // The witness: each credential opens its door under the salt it was
      // minted under.
      for (const door of doors) {
        expect(await ask(door.path, door.credential()), door.who).toMatchObject(
          { status: 200 },
        );
      }

      await server.restart({ env: { API_KEY_SALT: OTHER_SALT } });
      for (const door of doors) {
        expect(await ask(door.path, door.credential()), door.who).toEqual({
          status: 401,
          code: "unauthorized",
        });
      }

      await server.restart();
      for (const door of doors) {
        expect(await ask(door.path, door.credential()), door.who).toMatchObject(
          { status: 200 },
        );
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps the completed claim and offers no setup code or unauthenticated key mint under another API_KEY_SALT",
    async () => {
      const announcements = (): number =>
        readFileSync(join(server.stateDir, "server.log"), "utf8").split(
          "Claim this Marfa at /setup with setup code:",
        ).length - 1;
      // The initial unclaimed boot announced setup proof; the claimed restart does not.
      expect(announcements()).toBe(1);

      await server.restart({ env: { API_KEY_SALT: OTHER_SALT } });
      const minted = await ask("/keys", undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "recovery", source: "recovery" }),
      });

      expect(announcements()).toBe(1);
      expect(
        (await controlRequest(server.controlSocket, "/_control/setup/status"))
          .body.claimed,
      ).toBe(true);
      expect(
        (
          await controlRequest(server.controlSocket, "/_control/setup/code", {
            method: "POST",
            body: {},
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await controlRequest(server.controlSocket, "/_control/setup/claim", {
            method: "POST",
            body: TEST_OWNER,
          })
        ).status,
      ).toBe(409);
      expect(minted).toEqual({ status: 401, code: "unauthorized" });
    },
    FRESH_SERVER_TIMEOUT_MS,
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

/** The text a refused boot logged as its reason, from the log's own line. */
function refusalText(refused: RefusedBoot): string {
  for (const line of refused.output.split("\n")) {
    try {
      const entry = JSON.parse(line) as { message?: string; error?: string };
      if (entry.message === "Failed to start server") {
        return String(entry.error);
      }
    } catch {
      // Not a log line.
    }
  }
  throw new Error(`the server logged no refusal:\n${refused.output}`);
}

/** Whether the server got as far as listening, which is the one thing a
 *  refused boot must not do. */
function listened(refused: RefusedBoot): boolean {
  return refused.output.includes("Marfa server listening");
}

/** The exit status of a database another build wrote, which a supervisor
 *  reads as "starting again will meet the same file". */
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

describe("starting on a database another build wrote", () => {
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

  afterAll(() => {
    for (const dir of kept.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Boots on a copy of the donor's database that `change` has altered. */
  function refusedAfter(
    change: (db: Database) => void,
    extraEnv: Record<string, string> = {},
  ): Promise<RefusedBoot> {
    return bootRefused("lifecycle-refusal", {
      prepare: (sqlitePath) => {
        cpSync(image, sqlitePath);
        withInstanceDatabase(sqlitePath, change);
      },
      extraEnv,
    });
  }

  /** Runs `check` on a refused boot and removes its state. */
  async function expectRefusal(
    change: (db: Database) => void,
    check: (refused: RefusedBoot) => void,
  ): Promise<void> {
    const refused = await refusedAfter(change);
    try {
      check(refused);
    } finally {
      await refused.stop();
    }
  }

  const CAUSES: [string, (db: Database) => void, RegExp][] = [
    [
      "the retired custom_types table",
      (db) => db.exec("CREATE TABLE custom_types (id TEXT PRIMARY KEY)"),
      /type registry in .* is still held in custom_types/,
    ],
    [
      "the retired custom_edge_types table",
      (db) => db.exec("CREATE TABLE custom_edge_types (id TEXT PRIMARY KEY)"),
      /type registry in .* is still held in custom_edge_types/,
    ],
    [
      "the retired space_config setting",
      (db) =>
        db.exec(
          "INSERT INTO settings (key, value) VALUES ('space_config', '{}')",
        ),
      /settings in .* are still keyed space_config/,
    ],
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
    "says in its refusal to export with the build that wrote the file, start on a fresh file and restore the archive there, and that the restore can refuse",
    async () => {
      for (const [cause, change] of CAUSES) {
        await expectRefusal(change, (refused) => {
          const text = refusalText(refused);
          expect(text, cause).toContain(
            "export it with the build that wrote it",
          );
          expect(text, cause).toContain("start this build on a fresh file");
          expect(text, cause).toContain("restore the archive there");
          expect(text, cause).toContain("that restore can refuse it");
        });
      }
    },
    CAUSES.length * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "exits with status 78, not 1, when it refuses a database under the contract's upgrade rule",
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

  it(
    "exits with status 1, not 78, when the port it was given is already taken",
    async () => {
      const held = await holdPort();
      try {
        const refused = await bootRefused("lifecycle-port-taken", {
          extraEnv: { PORT: String(held.port) },
        });
        try {
          expect(refused).toMatchObject({ code: 1, signal: null });
          expect(listened(refused)).toBe(false);
        } finally {
          await refused.stop();
        }
      } finally {
        held.server.close();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

/** A port something of this process's is listening on. */
function holdPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        server,
      });
    });
  });
}

/** Every row of every table this build keeps removed, then `drop` taken out:
 *  the file a start leaves when it stops partway through making its tables. */
function emptyThenDrop(db: Database, drop: readonly string[]): void {
  db.exec("PRAGMA foreign_keys = OFF");
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'items_fts_%'",
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

  afterAll(() => {
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

  it(
    "does not count a row in a table it does not create, and leaves that table as it was",
    async () => {
      await startUnprovisioned((db) => {
        emptyThenDrop(db, DROPPED);
        db.exec("CREATE TABLE _litestream_seq (id INTEGER PRIMARY KEY)");
        db.exec("INSERT INTO _litestream_seq (id) VALUES (7), (8)");
      });
      expect((await fetch(`${server.apiUrl}/health`)).status).toBe(200);
      expect(
        (await controlRequest(server.controlSocket, "/_control/setup/status"))
          .body.claimed,
      ).toBe(false);
      withInstanceDatabase(server.sqlitePath, (db) => {
        expect(tablesIn(db)).toContain("audit_log");
        expect(
          db
            .prepare("SELECT id FROM _litestream_seq ORDER BY id")
            .all()
            .map((row) => Number(row.id)),
        ).toEqual([7, 8]);
      });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  function refusedUnfinished(
    change: (db: Database) => void,
  ): Promise<RefusedBoot> {
    return bootRefused("lifecycle-unfinished-refused", {
      prepare: (sqlitePath) => {
        cpSync(image, sqlitePath);
        withInstanceDatabase(sqlitePath, change);
      },
    });
  }

  async function expectUnfinishedRefused(
    change: (db: Database) => void,
    message: RegExp,
  ): Promise<void> {
    const refused = await refusedUnfinished(change);
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

  it(
    "refuses a database that lacks a table, holds no rows and holds the retired custom_types table",
    async () => {
      await expectUnfinishedRefused((db) => {
        emptyThenDrop(db, DROPPED);
        db.exec("CREATE TABLE custom_types (id TEXT PRIMARY KEY)");
      }, /type registry in .* is still held in custom_types/);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a database that lacks a table and holds the retired space_config setting",
    async () => {
      await expectUnfinishedRefused((db) => {
        emptyThenDrop(db, DROPPED);
        db.exec(
          "INSERT INTO settings (key, value) VALUES ('space_config', '{}')",
        );
      }, /export it with the build that wrote it/);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

/** The lines of a refusal over settings, one per setting, as the log has
 *  them: what follows the heading. */
function settingLines(refused: RefusedBoot): string[] {
  const [heading, ...lines] = refusalText(refused).split("\n");
  expect(heading).toBe("The server cannot start; fix these settings:");
  return lines.map((line) => line.trim());
}

/** Boots with `env`, expects it refused over settings, and answers the
 *  settings' lines after removing the state. */
async function refusedOverSettings(
  env: Record<string, string>,
  nodeEnv?: string,
): Promise<string[]> {
  const refused = await bootRefused("lifecycle-settings", {
    extraEnv: env,
    nodeEnv,
  });
  try {
    // Exit status 1, as for any failure to start that is not a refused database
    // (`instance/upgrade-exit-1`), before anything was opened or listened on.
    expect(refused).toMatchObject({ code: 1, signal: null });
    expect(refused.after).toEqual({
      db: "absent",
      wal: "absent",
      shm: "absent",
    });
    expect(listened(refused)).toBe(false);
    return settingLines(refused);
  } finally {
    await refused.stop();
  }
}

describe("starting with a setting outside its rule", () => {
  // One step outside each rule, for a kind of rule apiece.
  const OUTSIDE: [string, string, string, string][] = [
    [
      "MARFA_CONNECTOR_HOLD_MS",
      "a count below its minimum",
      "999",
      'MARFA_CONNECTOR_HOLD_MS must be a whole number, from 1000 to 3600000 (got "999")',
    ],
    [
      "AUDIT_RETENTION_DAYS",
      "a count above its maximum",
      "36501",
      'AUDIT_RETENTION_DAYS must be a whole number, from 0 to 36500 (got "36501")',
    ],
    [
      "SQLITE_BUSY_BUDGET_MS",
      "not a number",
      "soon",
      'SQLITE_BUSY_BUDGET_MS must be a whole number, from 0 to 2147483647 (got "soon")',
    ],
    [
      "MARFA_ENRICHMENT_ENABLED",
      "not a boolean",
      "maybe",
      'MARFA_ENRICHMENT_ENABLED must be true or false (also 1/0, yes/no, on/off) (got "maybe")',
    ],
    [
      "S3_ENDPOINT",
      "not a URL",
      "nope",
      'S3_ENDPOINT must be an absolute http or https URL (got "nope")',
    ],
  ];

  // The witness for every refusal below: the largest or smallest value each
  // rule takes, and the cross-field rules at their equal edge, start.
  it(
    "starts with each of those settings one step inside its rule and each cross-field rule at its edge",
    async () => {
      const server = await bootFreshServer("lifecycle-settings-edge", {
        MARFA_CONNECTOR_HOLD_MS: "1000",
        AUDIT_RETENTION_DAYS: "36500",
        SQLITE_BUSY_BUDGET_MS: "0",
        MARFA_ENRICHMENT_ENABLED: "OFF",
        S3_ENDPOINT: "https://objects.example.test",
        // With no bucket the endpoint is parsed and never reached, whatever
        // object store the run's environment names.
        S3_BUCKET: "",
        VERSION_RECENT_DAYS: "40",
        VERSION_DAILY_SNAPSHOT_DAYS: "40",
        VERSION_WEEKLY_SNAPSHOT_DAYS: "40",
        MARFA_BULK_ACTION_POLL_INTERVAL_MS: "500",
        MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS: "500",
        MARFA_AUTH_SECRET: "x".repeat(32),
      });

      try {
        expect((await fetch(`${server.apiUrl}/health`)).status).toBe(200);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it.each(OUTSIDE)(
    "refuses to start with status 1, naming %s and no other setting, when it is %s",
    async (name, _kind, value, line) => {
      expect(await refusedOverSettings({ [name]: value })).toEqual([line]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "names every setting that is outside its rule in one refusal",
    async () => {
      const lines = await refusedOverSettings(
        Object.fromEntries(OUTSIDE.map(([name, , value]) => [name, value])),
      );

      expect([...lines].sort()).toEqual(
        OUTSIDE.map(([, , , line]) => line).sort(),
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a secret with whitespace around it without printing it, where it prints the value of a setting that is not one",
    async () => {
      const secret = "padded-secret-value";

      const lines = await refusedOverSettings({
        S3_SECRET_ACCESS_KEY: ` ${secret} `,
        MARFA_CONNECTOR_HOLD_MS: "999",
      });

      expect([...lines].sort()).toEqual(
        [
          'MARFA_CONNECTOR_HOLD_MS must be a whole number, from 1000 to 3600000 (got "999")',
          "S3_SECRET_ACCESS_KEY has whitespace around it, which would be part of the secret; remove it",
        ].sort(),
      );
      expect(lines.join("\n")).not.toContain(secret);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a MARFA_AUTH_SECRET of 31 characters, without printing it",
    async () => {
      const secret = "y".repeat(31);

      const lines = await refusedOverSettings({ MARFA_AUTH_SECRET: secret });

      expect(lines).toEqual([
        "MARFA_AUTH_SECRET must be at least 32 characters; generate one with `openssl rand -hex 32`",
      ]);
      expect(lines.join("\n")).not.toContain(secret);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  const disagreeing: [string, Record<string, string>, string][] = [
    [
      "VERSION_DAILY_SNAPSHOT_DAYS",
      { VERSION_RECENT_DAYS: "40", VERSION_DAILY_SNAPSHOT_DAYS: "39" },
      'VERSION_DAILY_SNAPSHOT_DAYS must be at least VERSION_RECENT_DAYS (got "39")',
    ],
    [
      "VERSION_WEEKLY_SNAPSHOT_DAYS",
      {
        VERSION_DAILY_SNAPSHOT_DAYS: "100",
        VERSION_WEEKLY_SNAPSHOT_DAYS: "99",
      },
      'VERSION_WEEKLY_SNAPSHOT_DAYS must be at least VERSION_DAILY_SNAPSHOT_DAYS (got "99")',
    ],
    [
      "MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS",
      {
        MARFA_BULK_ACTION_POLL_INTERVAL_MS: "500",
        MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS: "499",
      },
      'MARFA_BULK_ACTION_POLL_MAX_INTERVAL_MS must be at least MARFA_BULK_ACTION_POLL_INTERVAL_MS (got "499")',
    ],
  ];

  it.each(disagreeing)(
    "refuses to start with status 1, naming %s, when each setting is inside its own rule and the two disagree",
    async (_name, env, line) => {
      expect(await refusedOverSettings(env)).toEqual([line]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "names only the setting outside its rule, and holds back the cross-field rule until every setting parses",
    async () => {
      const [, disagreement, disagreementLine] = disagreeing[0]!;
      const [name, , value, line] = OUTSIDE[0]!;

      // The witness: the disagreement is reported when it is the only fault.
      expect(await refusedOverSettings(disagreement)).toEqual([
        disagreementLine,
      ]);

      // A setting outside its rule that the comparison does not read.
      expect(
        await refusedOverSettings({ ...disagreement, [name]: value }),
      ).toEqual([line]);

      // One of the two settings the comparison reads.
      expect(
        await refusedOverSettings({
          ...disagreement,
          VERSION_RECENT_DAYS: "soon",
        }),
      ).toEqual([
        'VERSION_RECENT_DAYS must be a whole number, from 0 to 36500 (got "soon")',
      ]);

      // The rules that hold only in production wait too. The three settings
      // production requires are given as empty, which is unset, so what the
      // environment of whoever runs the suite holds does not answer them.
      const unset = {
        API_KEY_SALT: "",
        MARFA_AUTH_SECRET: "",
        MARFA_AUTH_BASE_URL: "",
      };
      // The witness: in production alone, the three are named.
      expect(
        [...(await refusedOverSettings(unset, "production"))].sort(),
      ).toEqual(
        [
          "API_KEY_SALT must be set in production; generate one with `openssl rand -hex 32`",
          "MARFA_AUTH_BASE_URL must be set in production to the public URL clients reach this server at",
          "MARFA_AUTH_SECRET must be set in production; generate one with `openssl rand -hex 32`",
        ].sort(),
      );
      expect(
        await refusedOverSettings({ ...unset, [name]: value }, "production"),
      ).toEqual([line]);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
