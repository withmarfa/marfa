import { randomBytes } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, mkdir, chmod, link } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve, sep, join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";

const execute = promisify(execFile);

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
) {
  await verifyControlDirectory(socketPath);
  try {
    await lstat(socketPath);
    throw new Error(
      `Control socket already exists: ${socketPath}. Stop its server before removing a stale socket.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  server.requestTimeout = 30_000;
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
