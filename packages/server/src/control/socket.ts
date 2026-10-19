import { randomBytes } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, mkdir, chmod, link, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep, join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";
import { createClient, LibsqlError } from "@libsql/client";
import { getRequestListener } from "@hono/node-server";
import {
  CONTROL_REQUEST_DEADLINE_MS,
  enforceRequestDeadline,
} from "../request-deadline.js";

const execute = promisify(execFile);
let startupTurn = Promise.resolve();
const activeLocks = new Set<string>();

async function acquireStartupLock(socketPath: string) {
  const lockPath = `${socketPath}.lock`;
  const inUse = () =>
    new Error(`Control socket path is already in use: ${socketPath}`);
  try {
    const existing = await lstat(lockPath);
    // Do not open and close a descriptor for an inode this process has locked.
    if (activeLocks.has(`${String(existing.dev)}:${String(existing.ino)}`))
      throw inUse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let file;
  let identity: string;
  try {
    file = await open(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    file = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    )
      throw new Error(
        `Control startup lock must be a private regular file owned by the server account: ${lockPath}`,
      );
    await assertNoAcl(lockPath);
    const current = await lstat(lockPath);
    if (current.dev !== stat.dev || current.ino !== stat.ino)
      throw new Error(`Control startup lock changed: ${lockPath}`);
    identity = `${String(stat.dev)}:${String(stat.ino)}`;
  } finally {
    await file.close();
  }
  // Keep the file in place: deleting it lets another process lock a different
  // inode. SQLite releases this reservation on rollback or process exit.
  const lock = createClient({ url: pathToFileURL(lockPath).href, timeout: 0 });
  try {
    const reservation = await lock.transaction("write");
    activeLocks.add(identity);
    return {
      close() {
        reservation.close();
        lock.close();
        activeLocks.delete(identity);
      },
    };
  } catch (error) {
    try {
      lock.close();
    } catch {
      /* Keep the acquisition error. */
    }
    if (error instanceof LibsqlError && error.code === "SQLITE_BUSY")
      throw inUse();
    throw new Error(
      `Control socket startup lock could not be acquired: ${socketPath}`,
      { cause: error },
    );
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let previous;
  try {
    previous = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const collision = () =>
    new Error(`Control socket already exists: ${socketPath}`);
  if (!previous.isSocket()) throw collision();
  const refused = await new Promise<boolean>((resolvePromise, reject) => {
    const probe = createConnection(socketPath);
    probe.setTimeout(1_000, () => {
      probe.destroy();
      reject(new Error(`Control socket probe timed out: ${socketPath}`));
    });
    probe.once("connect", () => {
      probe.destroy();
      reject(collision());
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ECONNREFUSED") resolvePromise(true);
      else if (error.code === "ENOENT") resolvePromise(false);
      else reject(error);
    });
  });
  if (!refused) return;
  // The reservation excludes other startups; recheck in case the server
  // account replaced this path through another operation.
  try {
    const current = lstatSync(socketPath);
    if (current.dev !== previous.dev || current.ino !== previous.ino)
      throw collision();
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertNoAcl(path: string): Promise<void> {
  if (process.platform === "darwin") {
    const { stdout } = await execute("/bin/ls", ["-lde", path]);
    if (
      stdout
        .split("\n")
        .slice(1)
        .some((line) => /\ballow\b/.test(line))
    ) {
      throw new Error(`Control path has an access ACL: ${path}`);
    }
  } else if (process.platform === "linux") {
    const { stdout } = await execute("getfacl", [
      "--absolute-names",
      "--omit-header",
      path,
    ]);
    if (
      stdout
        .split("\n")
        .some((line) => /^(?:default:|(?:user|group):[^:]+:)/.test(line))
    ) {
      throw new Error(`Control path has an access ACL: ${path}`);
    }
  } else {
    throw new Error("Private control sockets require macOS or Linux");
  }
}

export async function verifyControlDirectory(
  socketPath: string,
): Promise<void> {
  if (
    !isAbsolute(socketPath) ||
    socketPath !== resolve(socketPath) ||
    Buffer.byteLength(socketPath) > 103
  ) {
    throw new Error(
      "MARFA_CONTROL_SOCKET must be a normalized absolute Unix socket path of at most 103 bytes",
    );
  }
  const directory = dirname(socketPath);
  const uid = process.getuid?.();
  let current = parse(directory).root;
  for (const part of directory
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = resolve(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(
        `Control path is a symbolic link or not a directory: ${current}`,
      );
    if (stat.uid !== uid && stat.uid !== 0)
      throw new Error(`Control path has another owner: ${current}`);
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if ((stat.mode & 0o022) !== 0 && !stickyRoot)
      throw new Error(
        `Control path is writable by another account: ${current}`,
      );
    if (current === directory) {
      if (stat.uid !== uid || (stat.mode & 0o777) !== 0o700)
        throw new Error(
          `Control directory must belong to the server account with mode 0700: ${current}`,
        );
    }
    await assertNoAcl(current);
  }
}

/** The fetch closure is constructed with local authority only by the entry point. */
export async function startControlSocket(
  socketPath: string,
  fetch: (request: Request) => Response | Promise<Response>,
  requestDeadlineMs = CONTROL_REQUEST_DEADLINE_MS,
) {
  await verifyControlDirectory(socketPath);
  // Closing any descriptor for a lock file can release this process's POSIX
  // locks. Serialize local startups too, including aliases on case-insensitive disks.
  const previous = startupTurn;
  let release!: () => void;
  startupTurn = new Promise<void>((done) => {
    release = done;
  });
  await previous;
  let lock: Awaited<ReturnType<typeof acquireStartupLock>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    lock = await acquireStartupLock(socketPath);
    await removeStaleSocket(socketPath);
    server = await publishControlSocket(socketPath, fetch, requestDeadlineMs);
    const ownership = lock;
    server.once("close", () => {
      ownership.close();
    });
    return server;
  } catch (error) {
    if (server) {
      const published = server;
      await new Promise<void>((done) =>
        published.close(() => {
          done();
        }),
      );
    }
    try {
      lock?.close();
    } catch {
      /* Keep the startup error. */
    }
    throw error;
  } finally {
    release();
  }
}

async function publishControlSocket(
  socketPath: string,
  fetch: (request: Request) => Response | Promise<Response>,
  requestDeadlineMs: number,
) {
  // libuv unlinks its bound name unconditionally on close. Publish a second
  // link only after verification, and remove that link only while it is ours.
  const boundPath = join(
    dirname(socketPath),
    `.s-${randomBytes(6).toString("hex")}`,
  );
  if (Buffer.byteLength(boundPath) > 103)
    throw new Error("Control socket directory path is too long");
  const listener = getRequestListener(fetch);
  const server = createServer((request, response) => {
    void listener(request, response);
  });
  enforceRequestDeadline(server, requestDeadlineMs);
  server.headersTimeout = 10_000;
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(boundPath, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  try {
    await chmod(boundPath, 0o600);
    await assertNoAcl(boundPath);
    const bound = await lstat(boundPath);
    await link(boundPath, socketPath);
    server.once("close", () => {
      try {
        const current = lstatSync(socketPath);
        if (current.dev === bound.dev && current.ino === bound.ino)
          unlinkSync(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  } catch (error) {
    await new Promise<void>((done) =>
      server.close(() => {
        done();
      }),
    );
    throw error;
  }
  return server;
}
