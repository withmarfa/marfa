import { chmod, link, rm, stat, symlink } from "node:fs/promises";
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

const spool = async () => (await inspectStores(first.controlSocket)).spool;

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
async function heldUpload(): Promise<{
  bytes: Uint8Array;
  answer: ReturnType<MarfaClient["uploadBlob"]>;
}> {
  const bytes = new Uint8Array(UPLOAD_BYTES).map((_, at) => at % 251);
  await first.setFault("hold:blob-write");
  const answer = working.uploadBlob(bytes, "application/octet-stream");
  await first.waitForHold("hold:blob-write");
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
