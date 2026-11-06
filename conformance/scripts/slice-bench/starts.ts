/**
 * Start time: from the server process being spawned to its first `/health`
 * 200. The boots go through the conformance adapter, so whichever server it
 * starts (`MARFA_SERVER_BUILT`, `MARFA_SERVER_BIN`) is the one timed, on a
 * fixed port this harness polls itself. The clock starts at the pid file the
 * adapter writes once it has spawned the process, so the adapter's own start
 * and its sign-in after `/health` are not counted; a supervisor the adapter
 * puts between itself and the server is.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "./context.js";
import { distribution, log, scalar } from "./figures.js";
import { sleep } from "./http.js";
import { readPid } from "./processes.js";

const CONFORMANCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ADAPTER = resolve(CONFORMANCE, "scripts", "marfa-server.ts");
const BOOT_BUDGET_MS = 180_000;

/** What `pnpm marfa:up` sets, unless the caller set it already. */
const UP_SETTINGS: Record<string, string> = {
  MARFA_BLOB_CLEANUP_GRACE_MS: "0",
  RATE_LIMIT_ENABLED: "false",
  MARFA_ENRICHMENT_ENABLED: "false",
  MARFA_ENRICHMENT_OCR_ENABLED: "false",
  MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES: "true",
};

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? done(address.port)
          : fail(new Error("no port was assigned")),
      );
    });
  });
}

interface Adapter {
  done: Promise<string>;
}

function adapter(args: string[]): Adapter {
  const child = spawn(process.execPath, ["--import", "tsx", ADAPTER, ...args], {
    cwd: CONFORMANCE,
    env: { ...UP_SETTINGS, ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const done = new Promise<string>((finish, fail) => {
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0
        ? finish(output)
        : fail(
            new Error(
              `the adapter's ${args[0] ?? ""} ended with ${String(code)}:\n${output.slice(-2_000)}`,
            ),
          ),
    );
  });
  return { done };
}

/** Milliseconds from the new pid file to the first `/health` 200 on `port`. */
async function timeBoot(
  state: string,
  port: number,
  previousPid: number | undefined,
  boot: Adapter,
): Promise<number> {
  let failed: unknown;
  boot.done.catch((error: unknown) => (failed = error));
  const deadline = Date.now() + BOOT_BUDGET_MS;
  const pidFile = resolve(state, "server.pid");
  let spawnedAt: number | undefined;
  while (spawnedAt === undefined) {
    if (failed !== undefined) throw failed;
    if (Date.now() > deadline)
      throw new Error("the adapter wrote no new pid file");
    if (existsSync(pidFile)) {
      try {
        if (readPid(state) !== previousPid)
          spawnedAt = statSync(pidFile).mtimeMs;
      } catch {
        // Written as it was read.
      }
    }
    if (spawnedAt === undefined) await sleep(2);
  }
  for (;;) {
    if (failed !== undefined) throw failed;
    if (Date.now() > deadline)
      throw new Error(`no /health 200 on port ${port}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Connection: "close" },
        signal: AbortSignal.timeout(2_000),
      });
      await response.text();
      if (response.status === 200) return Date.now() - spawnedAt;
    } catch {
      // Not listening yet.
    }
    await sleep(5);
  }
}

/** Restarts on the loaded database; the first restart is kept apart. */
export async function warmStarts(ctx: Context): Promise<void> {
  const times: number[] = [];
  const stops: number[] = [];
  let first: number | undefined;
  for (let i = 0; i <= ctx.starts; i++) {
    const port = await freePort();
    const boot = adapter([
      "restart",
      "--state",
      ctx.state,
      "--env",
      `PORT=${port}`,
    ]);
    const ms = await timeBoot(ctx.state, port, readPid(ctx.state), boot);
    const output = await boot.done;
    const exit = /previous exit (\{.*\})/.exec(output)?.[1];
    if (exit !== undefined) stops.push((JSON.parse(exit) as { ms: number }).ms);
    log(`warm start ${i + 1}: ${ms} ms`);
    if (i === 0) first = ms;
    else times.push(ms);
  }
  ctx.record.add(
    scalar(
      {
        name: "start_warm_first_ms",
        label: "Start on the loaded database, first after the load",
        unit: "ms",
        note: "the first start after the load can pay for work the load left, such as a checkpoint",
      },
      first ?? 0,
    ),
  );
  ctx.record.add(
    distribution(
      {
        name: "start_warm_ms",
        label: "Start on the loaded database, spawn to /health 200",
        unit: "ms",
      },
      times,
    ),
  );
  ctx.record.add(
    distribution(
      {
        name: "stop_ms",
        label: "Stop on SIGTERM, signal to exit",
        unit: "ms",
        note: "as the adapter's supervisor recorded it",
      },
      stops,
    ),
  );
}

/** Boots on fresh state directories beside the run's, each removed after. */
export async function coldStarts(ctx: Context): Promise<void> {
  const times: number[] = [];
  for (let i = 1; i <= ctx.starts; i++) {
    const state = `${ctx.state}.cold-${i}`;
    if (existsSync(state))
      throw new Error(`${state} is in the way of a fresh boot`);
    mkdirSync(state);
    try {
      const port = await freePort();
      const boot = adapter(["up", "--state", state, "--port", String(port)]);
      const ms = await timeBoot(state, port, undefined, boot);
      await boot.done;
      log(`cold start ${i}: ${ms} ms`);
      times.push(ms);
    } finally {
      await adapter(["down", "--state", state]).done;
      rmSync(state, { recursive: true, force: true });
    }
  }
  ctx.record.add(
    distribution(
      {
        name: "start_cold_ms",
        label: "Start on a fresh database, spawn to /health 200",
        unit: "ms",
      },
      times,
    ),
  );
}
