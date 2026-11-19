import { chmod, link, rename, rm, stat, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
  type RefusedBoot,
} from "../../utils/fresh-server.js";
import {
  blobFolder,
  clientsFor,
  DISK_ONLY,
} from "../../utils/own-blob-server.js";
import { storeSettingRow } from "../../utils/instance-database.js";
import { inspectStores } from "../../utils/store-faults.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * A database and a blob folder belong to one running server at a time. A
 * second server is started on the first's files from a state folder of its
 * own, which is its working directory, and with a control socket of its own,
 * which `bootRefused` gives every boot that names none.
 */
const MiB = 1024 * 1024;
/** Large enough that the time a write is allowed for its size outlasts the refused starts. */
const UPLOAD_BYTES = 8 * MiB;

let first: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;
const removals: string[] = [];
const refusals: RefusedBoot[] = [];

beforeAll(async () => {
  // On the disk store alone, so no replication takes the write hold.
  first = await bootFreshServer("one-server", DISK_ONLY);
  ({ operator, working } = clientsFor(first));
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  for (const refused of refusals) await refused.stop();
  await first.stop();
  for (const path of removals) await rm(path, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

async function refused(extraEnv: Record<string, string>): Promise<RefusedBoot> {
  const boot = await bootRefused("one-server-second", {
    extraEnv: { ...DISK_ONLY, ...extraEnv },
  });
  refusals.push(boot);
  return boot;
}

const health = async () =>
  (await controlRequest(first.controlSocket, "/health")).status;

const spool = async (server: FreshServer = first) =>
  (await inspectStores(server.controlSocket)).spool;

/** The ways a second server can name the first's database. */
async function waysToTheDatabase(): Promise<string[]> {
  const links = tempFolder("marfa-link-");
  removals.push(links);
  const through = join(links, "through");
  await symlink(first.stateDir, through);
  return [
    first.sqlitePath,
    // `bootRefused` makes its state folder beside the first's and runs there.
    join("..", basename(first.stateDir), "marfa.db"),
    join(through, "marfa.db"),
  ];
}

/** Starts an upload of `UPLOAD_BYTES` and waits until its bytes wait, received, in the spool. */
async function heldUpload(
  server: FreshServer = first,
  client: MarfaClient = working,
): Promise<{
  bytes: Uint8Array;
  answer: ReturnType<MarfaClient["uploadBlob"]>;
}> {
  const bytes = new Uint8Array(UPLOAD_BYTES).map((_, at) => at % 251);
  await server.setFault("hold:blob-write");
  const answer = client.uploadBlob(bytes, "application/octet-stream");
  await server.waitForHold("hold:blob-write");
  return { bytes, answer };
}

describe("a second server on a running server's files", () => {
  it("is refused on the database however its path is written, though it has a control socket of its own, and names the database", async () => {
    for (const path of await waysToTheDatabase()) {
      const second = await refused({ MARFA_DATABASE_PATH: path });
      expect(second.code, second.output).toBe(1);
      expect(second.output).toContain(
        `${path} is open in another Marfa server`,
      );
      expect(await health()).toBe(200);
    }
  }, 180_000);

  it("is refused on the database, not the control socket, when both have the socket beside the database", async () => {
    // Short, because the socket's path must fit in a socket address.
    const dir = tempFolder("marfa-ds-");
    removals.push(dir);
    const database = join(dir, "marfa.db");
    // Where the server puts its control socket when it is given none.
    const beside = {
      MARFA_DATABASE_PATH: database,
      MARFA_CONTROL_SOCKET: join(dir, "control", "marfa.sock"),
    };
    const running = await bootFreshServer("one-server-beside", {
      ...DISK_ONLY,
      ...beside,
    });
    try {
      const second = await refused(beside);
      expect(second.code, second.output).toBe(1);
      expect(second.output).toContain(
        `${database} is open in another Marfa server`,
      );
      expect(second.output).not.toContain("Control socket");
      expect(
        (await controlRequest(running.controlSocket, "/health")).status,
      ).toBe(200);
    } finally {
      await running.stop();
    }
  }, 180_000);

  it(
    "is refused on a second hard link to the database, and says why",
    async () => {
      const dir = tempFolder("marfa-hard-");
      removals.push(dir);
      const other = join(dir, "marfa.db");
      await link(first.sqlitePath, other);
      try {
        const second = await refused({ MARFA_DATABASE_PATH: other });
        expect(second.code, second.output).toBe(1);
        expect(second.output).toContain(`${other} has 2 hard links`);
        expect(await health()).toBe(200);
      } finally {
        await rm(other);
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is refused on the blob folder though it has a database of its own, and names the folder",
    async () => {
      const folder = blobFolder(first);
      const second = await refused({ MARFA_BLOB_PATH: folder });
      expect(second.code, second.output).toBe(1);
      expect(second.output).toContain(
        `The blob folder ${folder} is open in another Marfa server`,
      );
      expect(await health()).toBe(200);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it("leaves the running server's upload in progress, which lands once it is let go", async () => {
    const { bytes, answer } = await heldUpload();
    const before = await spool();
    // A start that is not refused empties the spool, as the last case shows.
    expect(before.map((file) => file.size)).toEqual([UPLOAD_BYTES]);

    const onDatabase = await refused({ MARFA_DATABASE_PATH: first.sqlitePath });
    const onFolder = await refused({ MARFA_BLOB_PATH: blobFolder(first) });
    expect([onDatabase.code, onFolder.code]).toEqual([1, 1]);
    expect(await spool()).toEqual(before);

    await first.clearFault("hold:blob-write");
    const landed = await answer;
    expect(landed.status, JSON.stringify(landed.error)).toBe(201);
    const read = await operator.downloadBlob(landed.data.hash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(bytes);
  }, 180_000);

  it(
    "is not refused once the running server is killed, and empties the spool it left",
    async () => {
      const { answer } = await heldUpload();
      expect(await spool()).toHaveLength(1);
      const ended = answer.catch(() => undefined);
      const exit = await first.restart({ signal: "SIGKILL" });
      expect(exit).toMatchObject({ code: null, signal: "SIGKILL" });
      await ended;
      expect(await health()).toBe(200);
      expect(await spool()).toEqual([]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a blob folder that returns to a server started without it", () => {
  const KEPT_TEXT = "a file the folder keeps";

  /** A disk-only server holding one file, restarted with its folder moved away. */
  async function startedWithoutItsFolder(label: string) {
    const folder = join(tempFolder("marfa-one-server-disk-"), "blobs");
    const away = `${folder}.away`;
    const server = await bootFreshServer(label, {
      ...DISK_ONLY,
      MARFA_BLOB_PATH: folder,
    });
    const kept = await clientsFor(server).working.uploadBlob(
      new TextEncoder().encode(KEPT_TEXT),
      "text/plain",
    );
    expect(kept.status, JSON.stringify(kept.error)).toBe(201);
    await server.restart(async () => {
      storeSettingRow(server.sqlitePath, "backup_path", "not/an/absolute/path");
      await rename(folder, away);
    });
    return {
      server,
      folder,
      away,
      hash: kept.data.hash,
      ...clientsFor(server),
    };
  }

  /** What holds while the server cannot keep a returned folder to itself. */
  async function expectNothingStored({
    server,
    hash,
    operator: reader,
    working: client,
  }: Awaited<ReturnType<typeof startedWithoutItsFolder>>) {
    expect(await blobStorage(server)).toBe("down");
    const upload = await client.uploadBlob(
      new TextEncoder().encode("sent to a folder not kept"),
      "text/plain",
    );
    expect(upload.status).toBe(503);
    expect(upload.error?.error.code).toBe("blob_store_unavailable");
    const exported = await fetch(`${server.apiUrl}/export?format=archive`, {
      headers: { Authorization: `Bearer ${server.workingKey}` },
    });
    expect(exported.status).toBe(503);
    expect(
      ((await exported.json()) as { error: { code: string } }).error.code,
    ).toBe("blob_store_unavailable");
    const read = await reader.downloadBlob(hash);
    expect(read.status).toBe(200);
    expect(new TextDecoder().decode(read.data)).toBe(KEPT_TEXT);
  }

  const blobStorage = async (server: FreshServer) => {
    const { body } = await controlRequest(server.controlSocket, "/health");
    const { components } = body as {
      components: Record<string, { status: string }>;
    };
    return components.blob_storage?.status;
  };

  it(
    "refuses a second server on a returned folder while an upload is in progress there, and the upload lands",
    async () => {
      const {
        server,
        folder,
        away,
        working: client,
      } = await startedWithoutItsFolder("one-server-returning");
      try {
        await rename(away, folder);
        const { answer } = await heldUpload(server, client);
        const before = await spool(server);
        expect(before.map((file) => file.size)).toEqual([UPLOAD_BYTES]);

        const second = await refused({ MARFA_BLOB_PATH: folder });
        expect(second.code, second.output).toBe(1);
        expect(second.output).toContain(
          `The blob folder ${folder} is open in another Marfa server`,
        );
        expect(await spool(server)).toEqual(before);

        await server.clearFault("hold:blob-write");
        const landed = await answer;
        expect(landed.status, JSON.stringify(landed.error)).toBe(201);
      } finally {
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "stores nothing in a returned folder another server has open, still serves its files and reports it, and stores again once that server ends",
    async () => {
      const started = await startedWithoutItsFolder("one-server-beaten");
      const {
        server,
        folder,
        away,
        operator,
        working: client,
        local,
      } = started;
      try {
        await rename(away, folder);
        const holder = await bootFreshServer("one-server-holder", {
          ...DISK_ONLY,
          MARFA_BLOB_PATH: folder,
        });
        try {
          await expectNothingStored(started);
          // With a destination that can be used, only the blob folder stops the backup.
          const set = await local.patchConfig({
            backup_path: tempFolder("marfa-one-server-backups-"),
          });
          expect(set.status, JSON.stringify(set.error)).toBe(200);
          const refusedBackup = await operator.runBackup();
          expect(refusedBackup.status).toBe(503);
          expect(refusedBackup.error?.error.code).toBe(
            "blob_store_unavailable",
          );
          expect(refusedBackup.error?.error.message).toContain("blob folder");
        } finally {
          await holder.stop();
        }
        // The witness: all of it recovers once the folder is free, with no write first.
        expect(await blobStorage(server)).toBe("ok");
        const backup = await operator.runBackup();
        expect(backup.status, JSON.stringify(backup.error)).toBe(200);
        const later = await client.uploadBlob(
          new TextEncoder().encode("sent to a folder set free"),
          "text/plain",
        );
        expect(later.status, JSON.stringify(later.error)).toBe(201);
      } finally {
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "stores nothing in a returned folder that cannot be locked, still serves its files and reports it, and stores again once it can be",
    async () => {
      const started = await startedWithoutItsFolder("one-server-unlockable");
      const { server, folder, away, working: client } = started;
      const secondLink = `${folder}.second-link`;
      try {
        // The server refuses a lock file with a second name, as it does at a start.
        await link(join(away, ".server-lock"), secondLink);
        await rename(away, folder);
        await expectNothingStored(started);
        await rm(secondLink);
        expect(await blobStorage(server)).toBe("ok");
        const later = await client.uploadBlob(
          new TextEncoder().encode("sent once it can be locked"),
          "text/plain",
        );
        expect(later.status, JSON.stringify(later.error)).toBe(201);
      } finally {
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "makes a returned folder that others could read private before it stores a file there",
    async () => {
      const {
        server,
        folder,
        away,
        working: client,
      } = await startedWithoutItsFolder("one-server-returned-open");
      const mode = async () => (await stat(folder)).mode & 0o777;
      try {
        await chmod(away, 0o755);
        await rename(away, folder);
        // The witness: the folder returns as open as it was left.
        expect(await mode()).toBe(0o755);
        const stored = await client.uploadBlob(
          new TextEncoder().encode("sent to a returned folder"),
          "text/plain",
        );
        expect(stored.status, JSON.stringify(stored.error)).toBe(201);
        expect(await mode()).toBe(0o700);
      } finally {
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a second server on a returned folder once it has answered GET /health, and not after it has only served a read",
    async () => {
      const {
        server,
        folder,
        away,
        hash,
        operator: reader,
      } = await startedWithoutItsFolder("one-server-looked");
      try {
        await rename(away, folder);
        expect((await reader.downloadBlob(hash)).status).toBe(200);
        // The witness: a read leaves the folder free, so this server starts.
        const after = await bootFreshServer("one-server-after-read", {
          ...DISK_ONLY,
          MARFA_BLOB_PATH: folder,
        });
        await after.stop();

        expect((await fetch(`${server.apiUrl}/health`)).status).toBe(200);
        const second = await refused({ MARFA_BLOB_PATH: folder });
        expect(second.code, second.output).toBe(1);
        expect(second.output).toContain(
          `The blob folder ${folder} is open in another Marfa server`,
        );
      } finally {
        await server.stop();
      }
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a restart on lock files opened to the server's group", () => {
  it(
    "is not refused, and makes the lock files private again",
    async () => {
      const locks = [
        `${first.sqlitePath}.server-lock`,
        join(blobFolder(first), ".server-lock"),
      ];
      const mode = async (path: string) => (await stat(path)).mode & 0o777;
      const exit = await first.restart(async () => {
        // What a mount's group setting, such as Kubernetes fsGroup, or `chmod -R g+rw` leaves.
        for (const lock of locks) await chmod(lock, 0o660);
        expect(await Promise.all(locks.map(mode))).toEqual([0o660, 0o660]);
      });
      expect(exit.code).toBe(0);
      expect(await health()).toBe(200);
      expect(await Promise.all(locks.map(mode))).toEqual([0o600, 0o600]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("a database that cannot keep a write-ahead log", () => {
  it("is refused, saying so, and the same file is opened when it can keep one", async () => {
    const dir = tempFolder("marfa-no-log-");
    removals.push(dir);
    const file = join(dir, "marfa.db");
    // SQLite's dot-file locking keeps no shared memory, so it cannot keep the log.
    const uri = `file:${file}?vfs=unix-dotfile`;
    const noLog = await refused({ MARFA_DATABASE_PATH: uri });
    expect(noLog.code, noLog.output).toBe(1);
    expect(noLog.output).toContain(
      `${uri} cannot keep a write-ahead log, which the server needs`,
    );

    const logged = await bootFreshServer("one-server-log", {
      ...DISK_ONLY,
      MARFA_DATABASE_PATH: `file:${file}`,
    });
    try {
      expect(
        (await controlRequest(logged.controlSocket, "/health")).status,
      ).toBe(200);
    } finally {
      await logged.stop();
    }
  }, 180_000);
});
