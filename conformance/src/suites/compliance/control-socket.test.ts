import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  bootRefused,
  type FreshServer,
} from "../../utils/fresh-server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "marfa-restart-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, "control.sock");
  const extraEnv = { MARFA_CONTROL_SOCKET: socket };
  return {
    socket,
    async start(): Promise<FreshServer> {
      const server = await bootFreshServer("control-socket", extraEnv);
      cleanups.push(() => server.stop());
      return server;
    },
    async refused(prepare?: () => Promise<void>) {
      const boot = await bootRefused("control-socket", {
        extraEnv,
        prepare: async () => {
          await prepare?.();
        },
      });
      cleanups.push(() => boot.stop());
      return boot;
    },
  };
}

const health = async (socket: string) =>
  (await controlRequest(socket, "/health")).status;

it("starts on the same control socket after SIGKILL", async () => {
  const { socket, start } = await fixture();
  const first = await start();
  expect(await health(socket)).toBe(200);
  first.signal("SIGKILL");
  expect(await first.exit()).toMatchObject({ code: null, signal: "SIGKILL" });
  expect((await lstat(socket)).isSocket()).toBe(true);
  await expect(controlRequest(socket, "/health")).rejects.toMatchObject({
    code: "ECONNREFUSED",
  });
  await first.restart({ signal: "SIGKILL" });
  expect(await health(socket)).toBe(200);
}, 120_000);

it("allows only one concurrent restart on a stale control socket", async () => {
  const { socket, start } = await fixture();
  const first = await start();
  first.signal("SIGKILL");
  await first.exit();
  expect((await lstat(socket)).isSocket()).toBe(true);
  await expect(controlRequest(socket, "/health")).rejects.toMatchObject({
    code: "ECONNREFUSED",
  });
  const results = await Promise.allSettled([start(), start()]);
  expect(results.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(await health(socket)).toBe(200);
}, 120_000);

it("refuses a live control socket and preserves its listener", async () => {
  const { socket, start, refused } = await fixture();
  await start();
  const before = await lstat(socket);
  const second = await refused();
  expect({ code: second.code, signal: second.signal }).toEqual({
    code: 1,
    signal: null,
  });
  expect(second.output).toContain(
    `Control socket path is already in use: ${socket}`,
  );
  const after = await lstat(socket);
  expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  expect(await health(socket)).toBe(200);
}, 120_000);

it("refuses a non-socket control path and preserves its contents", async () => {
  const { socket, refused } = await fixture();
  const server = await refused(() => writeFile(socket, "keep these bytes"));
  expect({ code: server.code, signal: server.signal }).toEqual({
    code: 1,
    signal: null,
  });
  expect(server.output).toContain(`Control socket already exists: ${socket}`);
  expect(await readFile(socket, "utf8")).toBe("keep these bytes");
}, 120_000);

it("removes its socket on a clean stop and reuses the persistent lock file", async () => {
  const { socket, start } = await fixture();
  const first = await start();
  expect(await health(socket)).toBe(200);
  const lock = await lstat(`${socket}.lock`);
  first.signal("SIGTERM");
  expect(await first.exit()).toMatchObject({ code: 0, signal: null });
  await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
  const retained = await lstat(`${socket}.lock`);
  expect([retained.dev, retained.ino]).toEqual([lock.dev, lock.ino]);
  await first.restart();
  expect(await health(socket)).toBe(200);
}, 120_000);
