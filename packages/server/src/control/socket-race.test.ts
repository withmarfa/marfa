import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  link,
  lstat,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const CHILD = String.raw`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [role, socket, source] = process.argv.slice(1);
let closing = false;
if (role === "paused" || role === "closing") {
  const original = fs.lstatSync;
  let paused = false;
  fs.lstatSync = (path, ...args) => {
    const result = original(path, ...args);
    if (path === socket && !paused && (role !== "closing" || closing)) {
      paused = true;
      process.send({ event: "checked" });
      const deadline = Date.now() + 30000;
      while (!fs.existsSync(socket + ".release")) {
        if (Date.now() > deadline) throw new Error("pause deadline");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return result;
  };
  syncBuiltinESMExports();
}
if (role === "bound") {
  const original = fs.promises.link;
  fs.promises.link = async (from, to) => {
    if (to === socket) {
      process.send({ event: "bound" });
      const deadline = Date.now() + 30000;
      while (!fs.existsSync(socket + ".release")) {
        if (Date.now() > deadline) throw new Error("pause deadline");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return original(from, to);
  };
  syncBuiltinESMExports();
}
try {
  const { startControlSocket } = await import(source);
  const server = await startControlSocket(socket, () => new Response(role));
  process.send({ event: "ready" });
  process.on("message", () => {
    closing = true;
    server.close(() => process.exit(0));
  });
} catch (error) {
  process.send({ event: "refused", message: error.message });
  process.exit(1);
}
`;

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function stalePath() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "marfa-race-"));
  roots.push(root);
  const socket = join(root, "control.sock");
  const stale = createServer();
  const bound = join(root, "stale.sock");
  await new Promise<void>((done) => stale.listen(bound, done));
  await link(bound, socket);
  await new Promise<void>((done) =>
    stale.close(() => {
      done();
    }),
  );
  expect((await lstat(socket)).isSocket()).toBe(true);
  return socket;
}

function start(role: string, socket: string) {
  const messages: { event: string; message?: string }[] = [];
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      CHILD,
      role,
      socket,
      new URL("./socket.ts", import.meta.url).href,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  children.push(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.on("message", (message: { event: string; message?: string }) => {
    messages.push(message);
  });
  return {
    child,
    async event(...names: string[]) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const found = messages.find((message) => names.includes(message.event));
        if (found) return found;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(output);
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error(`Child did not report ${names.join(" or ")}: ${output}`);
    },
  };
}

function get(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/", agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += String(chunk);
      });
      res.on("end", () => {
        resolve(body);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

it("refuses a second process while stale socket removal and publication are paused", async () => {
  const socket = await stalePath();
  const before = await lstat(socket);
  const first = start("paused", socket);
  expect(await first.event("checked")).toMatchObject({ event: "checked" });
  const second = start("second", socket);
  expect(await second.event("ready", "refused")).toMatchObject({
    event: "refused",
  });
  const untouched = await lstat(socket);
  expect([untouched.dev, untouched.ino]).toEqual([before.dev, before.ino]);
  await writeFile(socket + ".release", "release");
  expect(await first.event("ready", "refused")).toMatchObject({
    event: "ready",
  });
  expect(await get(socket)).toBe("paused");
}, 30_000);

it("releases startup exclusion when the process is killed before publication", async () => {
  const socket = await stalePath();
  const first = start("paused", socket);
  await first.event("checked");
  const second = start("second", socket);
  expect(await second.event("ready", "refused")).toMatchObject({
    event: "refused",
  });
  const exited = once(first.child, "exit");
  first.child.kill("SIGKILL");
  expect(await exited).toEqual([null, "SIGKILL"]);
  const third = start("third", socket);
  expect(await third.event("ready", "refused")).toMatchObject({
    event: "ready",
  });
  expect(await get(socket)).toBe("third");
}, 30_000);

it("releases startup exclusion when the process is killed after binding but before publication", async () => {
  const socket = await stalePath();
  const first = start("bound", socket);
  await first.event("bound");
  await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
  const second = start("second", socket);
  expect(await second.event("ready", "refused")).toMatchObject({
    event: "refused",
  });
  const exited = once(first.child, "exit");
  first.child.kill("SIGKILL");
  expect(await exited).toEqual([null, "SIGKILL"]);
  const third = start("third", socket);
  expect(await third.event("ready", "refused")).toMatchObject({
    event: "ready",
  });
  expect(await get(socket)).toBe("third");
}, 30_000);

it("a closing process excludes concurrent restart until its socket cleanup finishes", async () => {
  const socket = await stalePath();
  const first = start("closing", socket);
  await first.event("ready");
  first.child.send("close");
  await first.event("checked");
  const second = start("second", socket);
  expect(await second.event("ready", "refused")).toMatchObject({
    event: "refused",
  });
  const exited = once(first.child, "exit");
  await writeFile(socket + ".release", "release");
  await exited;
  const third = start("third", socket);
  expect(await third.event("ready", "refused")).toMatchObject({
    event: "ready",
  });
  expect(await get(socket)).toBe("third");
}, 30_000);
