import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { processAlive, signalGroup } from "./server-process.js";

const supervisor = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/run-server.mjs",
);

const groups: number[] = [];
const folders: string[] = [];

afterEach(() => {
  for (const group of groups.splice(0)) signalGroup(group, "SIGKILL");
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

interface Booted {
  leader: number;
  state: string;
  work: string;
  server: number;
}

/**
 * Starts the supervisor the way `marfa-server.ts up` does (detached, stdout
 * to the state directory's log) around a stand-in server that only waits.
 */
async function boot(settings: Record<string, string>): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), "marfa-reaper-"));
  folders.push(root);
  const state = join(root, "state");
  const work = join(root, "work");
  mkdirSync(state);
  mkdirSync(work);
  const pidFile = join(work, "server.pid");
  const stub = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const log = openSync(join(state, "server.log"), "a");
  const child = spawn(
    process.execPath,
    [supervisor, join(state, "server.exit"), process.execPath, "-e", stub],
    {
      cwd: work,
      env: {
        ...process.env,
        CONFORMANCE_SERVER_WATCH_MS: "200",
        ...settings,
      },
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  child.unref();
  groups.push(child.pid!);
  const deadline = Date.now() + 10_000;
  let server = 0;
  while (server === 0 && Date.now() < deadline) {
    try {
      server = Number(readFileSync(pidFile, "utf8"));
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  expect(server).toBeGreaterThan(0);
  return { leader: child.pid!, state, work, server };
}

async function bothGone(booted: Booted, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!processAlive(booted.leader) && !processAlive(booted.server)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const stillThere = (booted: Booted, ms: number) =>
  new Promise<boolean>((done) =>
    setTimeout(
      () => done(processAlive(booted.leader) && processAlive(booted.server)),
      ms,
    ),
  );

describe("a supervised server nobody will stop", () => {
  it("keeps running while its state directory is there", async () => {
    const booted = await boot({});
    expect(await stillThere(booted, 1_500)).toBe(true);
  });

  it("stops, with its leader, when the state directory is removed", async () => {
    const booted = await boot({});
    rmSync(booted.state, { recursive: true, force: true });
    expect(await bothGone(booted, 10_000)).toBe(true);
  });

  it("stops, with its leader, when its working directory is removed", async () => {
    const booted = await boot({});
    rmSync(booted.work, { recursive: true, force: true });
    expect(await bothGone(booted, 10_000)).toBe(true);
  });

  it("stops when no request reaches it for the idle limit", async () => {
    const booted = await boot({ CONFORMANCE_SERVER_IDLE_MS: "1500" });
    expect(await bothGone(booted, 15_000)).toBe(true);
  });

  it("keeps running past the idle limit while requests arrive", async () => {
    const booted = await boot({ CONFORMANCE_SERVER_IDLE_MS: "1500" });
    const log = join(booted.state, "server.log");
    const timer = setInterval(
      () => appendFileSync(log, '{"request_id":"r","status":200}\n'),
      200,
    );
    try {
      expect(await stillThere(booted, 4_000)).toBe(true);
    } finally {
      clearInterval(timer);
    }
    expect(await bothGone(booted, 15_000)).toBe(true);
  });

  it("is not kept running by lines that are not requests", async () => {
    const booted = await boot({ CONFORMANCE_SERVER_IDLE_MS: "1500" });
    const log = join(booted.state, "server.log");
    const timer = setInterval(
      () => appendFileSync(log, '{"msg":"housekeeping"}\n'),
      200,
    );
    try {
      expect(await bothGone(booted, 15_000)).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });
});
