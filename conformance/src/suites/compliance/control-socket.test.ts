import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { controlRequest } from "../../utils/control-request.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "marfa-restart-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, "control.sock");
  const closeProbe = join(root, "close-probe.mjs");
  await writeFile(
    closeProbe,
    String.raw`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
let closing = false;
process.on("SIGTERM", () => { closing = true; });
const original = fs.lstatSync;
fs.lstatSync = (path, ...args) => {
  const stat = original(path, ...args);
  if (closing && path === process.env.MARFA_CONTROL_SOCKET) {
    process.stdout.write("control-close-checked\n");
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(path + ".release")) {
      if (Date.now() > deadline) throw new Error("close probe deadline");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return stat;
};
syncBuiltinESMExports();
`,
  );
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    MARFA_AUTH_SECRET: randomBytes(32).toString("hex"),
    MARFA_CONTROL_ONLY: "true",
    MARFA_CONTROL_SOCKET: socket,
    SQLITE_PATH: join(root, "marfa.db"),
    BLOB_PATH: join(root, "blobs"),
    MARFA_ENRICHMENT_ENABLED: "false",
    MARFA_ENRICHMENT_OCR_ENABLED: "false",
  };
  function start(pauseOnClose = false) {
    const child = spawn(
      process.execPath,
      [
        ...(pauseOnClose ? ["--import", pathToFileURL(closeProbe).href] : []),
        resolve("../packages/server/dist/index.js"),
      ],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = once(child, "exit");
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    });
    return {
      child,
      exited,
      output: () => output,
      async startup() {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (output.includes("Private control socket listening"))
            return "ready";
          if (child.exitCode !== null || child.signalCode !== null)
            return "refused";
          await new Promise((done) => setTimeout(done, 25));
        }
        throw new Error(`Server did not finish startup: ${output}`);
      },
      async ready() {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(output);
          try {
            if ((await controlRequest(socket, "/health")).status === 200)
              return;
          } catch {
            /* The process has not bound its socket yet. */
          }
          await new Promise((done) => setTimeout(done, 25));
        }
        throw new Error(`Server did not start: ${output}`);
      },
    };
  }
  return { socket, start };
}

it("starts on the same control socket after SIGKILL", async () => {
  const { socket, start } = await fixture();
  const first = start();
  await first.ready();
  expect((await controlRequest(socket, "/health")).status).toBe(200);
  first.child.kill("SIGKILL");
  expect(await first.exited).toEqual([null, "SIGKILL"]);
  expect((await lstat(socket)).isSocket()).toBe(true);
  await expect(controlRequest(socket, "/health")).rejects.toMatchObject({
    code: "ECONNREFUSED",
  });
  const second = start();
  await second.ready();
  expect((await controlRequest(socket, "/health")).status).toBe(200);
}, 60_000);

it("allows only one concurrent restart on a stale control socket", async () => {
  const { socket, start } = await fixture();
  const first = start();
  await first.ready();
  first.child.kill("SIGKILL");
  expect(await first.exited).toEqual([null, "SIGKILL"]);
  expect((await lstat(socket)).isSocket()).toBe(true);
  await expect(controlRequest(socket, "/health")).rejects.toMatchObject({
    code: "ECONNREFUSED",
  });
  const restarts = [start(), start()];
  const results = await Promise.all(restarts.map((server) => server.startup()));
  expect(results.sort()).toEqual(["ready", "refused"]);
  expect((await controlRequest(socket, "/health")).status).toBe(200);
}, 60_000);

it("refuses a live control socket and preserves its listener", async () => {
  const { socket, start } = await fixture();
  const first = start();
  await first.ready();
  const before = await lstat(socket);
  const second = start();
  expect(await second.exited).toEqual([1, null]);
  expect(second.output()).toContain(
    `Control socket path is already in use: ${socket}`,
  );
  const after = await lstat(socket);
  expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  expect((await controlRequest(socket, "/health")).status).toBe(200);
}, 60_000);

it("refuses a non-socket control path and preserves its contents", async () => {
  const { socket, start } = await fixture();
  await writeFile(socket, "keep these bytes");
  const server = start();
  expect(await server.exited).toEqual([1, null]);
  expect(server.output()).toContain(`Control socket already exists: ${socket}`);
  expect(await readFile(socket, "utf8")).toBe("keep these bytes");
}, 60_000);

it("removes its socket on a clean stop and reuses the persistent lock file", async () => {
  const { socket, start } = await fixture();
  const first = start();
  await first.ready();
  expect((await controlRequest(socket, "/health")).status).toBe(200);
  const lock = await lstat(`${socket}.lock`);
  first.child.kill("SIGTERM");
  expect(await first.exited).toEqual([0, null]);
  await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
  const retained = await lstat(`${socket}.lock`);
  expect([retained.dev, retained.ino]).toEqual([lock.dev, lock.ino]);
  const second = start();
  await second.ready();
  expect((await controlRequest(socket, "/health")).status).toBe(200);
}, 60_000);

it("refuses startup until a closing listener has finished its socket cleanup", async () => {
  const { socket, start } = await fixture();
  const first = start(true);
  await first.ready();
  expect((await controlRequest(socket, "/health")).status).toBe(200);
  first.child.kill("SIGTERM");
  await expect
    .poll(first.output, { timeout: 30_000 })
    .toContain("control-close-checked");
  await expect(controlRequest(socket, "/health")).rejects.toMatchObject({
    code: "ECONNREFUSED",
  });
  const second = start();
  expect(await second.exited).toEqual([1, null]);
  expect(second.output()).toContain(
    `Control socket path is already in use: ${socket}`,
  );
  await writeFile(`${socket}.release`, "release");
  expect(await first.exited).toEqual([0, null]);
  const third = start();
  await third.ready();
  expect((await controlRequest(socket, "/health")).status).toBe(200);
}, 60_000);
