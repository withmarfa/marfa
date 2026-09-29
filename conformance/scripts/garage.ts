/**
 * Boot a single-node Garage as the object store the suite attaches to the
 * server, and write the `S3_*` values that name it.
 *
 *   tsx scripts/garage.ts up [--state <dir>] [--port <n>]
 *   tsx scripts/garage.ts down [--state <dir>]
 *
 * Garage is the S3-compatible store a developer installs with Homebrew; the
 * fixtures that assert the object-store half of the blob chapters need a
 * server booted with these values in its environment, so `up` writes them to
 * `<state>/garage.env` for a shell to source, and appends them to
 * `GITHUB_ENV` when that is set so a later workflow step inherits them.
 * `pnpm marfa:up` forwards its environment to the server it boots.
 *
 * The state directory holds Garage's metadata and data, its config, its log
 * and pid, and the env file. `down` stops the node and removes all of it: a
 * stand-in holds nothing worth keeping between runs.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { maskInActions } from "../src/utils/target.js";

const READY_BUDGET_MS = 30_000;
const POLL_MS = 250;
const SHUTDOWN_BUDGET_MS = 10_000;
const BUCKET = "marfa";
const KEY_NAME = "marfa-conformance";

interface Args {
  command: "up" | "down";
  state: string;
  port?: number;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== "up" && command !== "down") {
    throw new Error(
      "usage: garage.ts up [--state <dir>] [--port <n>] | down [--state <dir>]",
    );
  }
  const args: Args = { command, state: resolve(".marfa-state", "garage") };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--state") {
      args.state = resolve(rest[++i] ?? "");
    } else if (arg === "--port") {
      args.port = Number(rest[++i]);
      if (!Number.isInteger(args.port) || args.port <= 0) {
        throw new Error("--port needs a positive integer");
      }
    } else {
      throw new Error(`unexpected argument: ${arg ?? ""}`);
    }
  }
  return args;
}

function paths(state: string) {
  return {
    config: resolve(state, "garage.toml"),
    meta: resolve(state, "meta"),
    data: resolve(state, "data"),
    log: resolve(state, "garage.log"),
    pid: resolve(state, "garage.pid"),
    env: resolve(state, "garage.env"),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function requireGarage(): void {
  const probe = spawnSync("garage", ["--version"], { stdio: "pipe" });
  if (probe.status !== 0) {
    throw new Error(
      "garage is not on the path; install it with `brew install garage`, or a release binary from garagehq.deuxfleurs.fr",
    );
  }
}

/** `garage -c <config> ...`, with its output, refusing on failure. */
function garage(config: string, args: string[]): string {
  const run = spawnSync("garage", ["-c", config, ...args], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (run.status !== 0) {
    throw new Error(
      `garage ${args.join(" ")} failed: ${run.stderr || run.stdout}`,
    );
  }
  return run.stdout;
}

function readPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForNode(config: string): Promise<void> {
  const deadline = Date.now() + READY_BUDGET_MS;
  while (Date.now() < deadline) {
    const probe = spawnSync("garage", ["-c", config, "status"], {
      stdio: "pipe",
    });
    if (probe.status === 0) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error("garage did not answer its status call in time");
}

async function up(args: Args): Promise<void> {
  requireGarage();
  const p = paths(args.state);
  const existing = readPid(p.pid);
  if (existing !== undefined && alive(existing)) {
    throw new Error(
      `a garage node is already running from ${args.state} (pid ${String(existing)}); run down first`,
    );
  }
  rmSync(args.state, { recursive: true, force: true });
  mkdirSync(p.meta, { recursive: true });
  mkdirSync(p.data, { recursive: true });
  // The node's secrets are in here and `--state` takes any name, so the
  // folder ignores itself.
  writeFileSync(resolve(args.state, ".gitignore"), "*\n");

  const s3Port = args.port ?? (await freePort());
  const rpcPort = await freePort();
  const adminPort = await freePort();
  // Path-style addressing, because the suite reaches the node by address
  // and a virtual-hosted URL would need a name for the bucket to resolve.
  writeFileSync(
    p.config,
    [
      `metadata_dir = "${p.meta}"`,
      `data_dir = "${p.data}"`,
      'db_engine = "sqlite"',
      "replication_factor = 1",
      `rpc_bind_addr = "127.0.0.1:${String(rpcPort)}"`,
      `rpc_public_addr = "127.0.0.1:${String(rpcPort)}"`,
      `rpc_secret = "${randomBytes(32).toString("hex")}"`,
      "",
      "[s3_api]",
      's3_region = "garage"',
      `api_bind_addr = "127.0.0.1:${String(s3Port)}"`,
      'root_domain = ".s3.garage.localhost"',
      "",
      "[admin]",
      `api_bind_addr = "127.0.0.1:${String(adminPort)}"`,
      `admin_token = "${randomBytes(32).toString("base64")}"`,
      "",
    ].join("\n"),
  );

  const logFd = openSync(p.log, "a");
  const child = spawn("garage", ["-c", p.config, "server"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  if (child.pid === undefined) throw new Error("failed to spawn garage");
  writeFileSync(p.pid, `${String(child.pid)}\n`);
  child.unref();
  console.log(
    `[garage] started pid ${String(child.pid)} on 127.0.0.1:${String(s3Port)}; log at ${p.log}`,
  );

  await waitForNode(p.config);

  // One node, one zone, one layout version: the whole cluster.
  const status = garage(p.config, ["status"]);
  const node = /^([0-9a-f]{16})\s/m.exec(status)?.[1];
  if (!node) throw new Error(`garage status named no node:\n${status}`);
  garage(p.config, ["layout", "assign", "-z", "dc1", "-c", "1G", node]);
  garage(p.config, ["layout", "apply", "--version", "1"]);

  garage(p.config, ["bucket", "create", BUCKET]);
  const created = garage(p.config, ["key", "create", KEY_NAME]);
  const keyId = /^Key ID:\s+(\S+)/m.exec(created)?.[1];
  const secret = /^Secret key:\s+(\S+)/m.exec(created)?.[1];
  if (!keyId || !secret) {
    throw new Error("garage key create printed no key id and secret");
  }
  maskInActions(keyId, secret);
  garage(p.config, [
    "bucket",
    "allow",
    "--read",
    "--write",
    "--owner",
    BUCKET,
    "--key",
    KEY_NAME,
  ]);

  const env = [
    `S3_BUCKET=${BUCKET}`,
    "S3_REGION=garage",
    `S3_ENDPOINT=http://127.0.0.1:${String(s3Port)}`,
    `S3_ACCESS_KEY_ID=${keyId}`,
    `S3_SECRET_ACCESS_KEY=${secret}`,
    "S3_FORCE_PATH_STYLE=true",
    "S3_PREFIX=blobs",
    "",
  ].join("\n");
  writeFileSync(p.env, env);
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, env);
  }
  console.log(`[garage] bucket ${BUCKET} ready; env file at ${p.env}`);
}

async function down(args: Args): Promise<void> {
  const p = paths(args.state);
  const pid = readPid(p.pid);
  if (pid !== undefined && alive(pid)) {
    process.kill(-pid, "SIGTERM");
    const deadline = Date.now() + SHUTDOWN_BUDGET_MS;
    while (alive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (alive(pid)) process.kill(-pid, "SIGKILL");
    console.log(`[garage] stopped pid ${String(pid)}`);
  } else {
    console.log("[garage] not running");
  }
  rmSync(args.state, { recursive: true, force: true });
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "up") await up(args);
else await down(args);
