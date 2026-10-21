/**
 * Boots the shipped `deploy/entrypoint.sh` with the real Litestream and the
 * shipped `deploy/litestream.yml`, against the bucket the `S3_*` names in
 * the environment point at. The server is a stand-in that creates a
 * database naming its instance, or reports the instance named by the
 * database it found, and writes one row on every start, so each start gives
 * the replica a transaction of its own. What is under test is only which
 * replica reaches which volume, and when the entrypoint replicates at all.
 *
 * The entrypoint's check before replication runs as the image runs it, the
 * server's built `dist/replica-check.js` on this machine's Node, so the
 * server must be built first (`pnpm --filter "@withmarfa/server..." build`).
 *
 * Needs `litestream` and `sqlite3` on the path and a local object store
 * (`pnpm garage:up`). A fixture writes under prefixes of its own, and
 * `openBucket` refuses an endpoint that is not on this machine.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const ENTRYPOINT = join(REPO_ROOT, "deploy/entrypoint.sh");
const SHIPPED_CONFIG = join(REPO_ROOT, "deploy/litestream.yml");
const REPLICA_CHECK = join(REPO_ROOT, "packages/server/dist/replica-check.js");
/** The server's default `S3_PREFIX`. */
export const DEFAULT_PREFIX = "blobs";
const BOOT_BUDGET_MS = 20_000;
const STOP_BUDGET_MS = 20_000;

const dirs: string[] = [];
const running: ChildProcess[] = [];
let litestreamBinary = "";
let sqliteBinary = "";
let client: S3Client | undefined;
let bucket = "";

export const pause = (ms: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, ms));

function onPath(binary: string): string {
  const found = spawnSync("/bin/sh", ["-c", `command -v ${binary}`], {
    encoding: "utf8",
  });
  const path = found.stdout.trim();
  if (found.status !== 0 || path === "") {
    throw new Error(`${binary} is not on the path`);
  }
  return path;
}

function store(): S3Client {
  if (client === undefined) throw new Error("openBucket has not run");
  return client;
}

/** Checks what the boots need and connects to the bucket. */
export function openBucket(): void {
  litestreamBinary = onPath("litestream");
  sqliteBinary = onPath("sqlite3");
  if (!existsSync(REPLICA_CHECK)) {
    throw new Error(
      'packages/server/dist/replica-check.js is missing; run `pnpm --filter "@withmarfa/server..." build`',
    );
  }
  for (const name of [
    "S3_BUCKET",
    "S3_REGION",
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ]) {
    if (!process.env[name]) {
      throw new Error(
        `${name} is not set; run \`pnpm garage:up\` and source its env file`,
      );
    }
  }
  const endpoint = new URL(process.env.S3_ENDPOINT ?? "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error(
      "S3_ENDPOINT is not on this machine; the backup fixtures write to the bucket and run only against a local object store",
    );
  }
  bucket = process.env.S3_BUCKET ?? "";
  client = new S3Client({
    region: process.env.S3_REGION ?? "",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    },
  });
}

/** Stops every boot still running, removes the volumes and every key under `prefixes`. */
export async function closeBucket(prefixes: string[]): Promise<void> {
  for (const child of running.splice(0)) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (client !== undefined) {
    for (const prefix of prefixes) await removeUnder(prefix);
    client.destroy();
    client = undefined;
  }
}

/** Every key under `prefix`, in the order the store lists them. */
export async function keysUnder(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await store().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key) keys.push(object.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export async function removeUnder(prefix: string): Promise<void> {
  const keys = await keysUnder(prefix);
  for (let i = 0; i < keys.length; i += 1000) {
    await store().send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
      }),
    );
  }
}

/** A new, empty volume, removed by `closeBucket`. */
export function newVolume(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-backup-"));
  dirs.push(dir);
  return dir;
}

/** Where the entrypoint keeps the database on `volume`. */
export function dataDir(volume: string): string {
  return join(volume, "data");
}

export function sqlitePath(volume: string): string {
  return join(dataDir(volume), "marfa.db");
}

export type Start =
  | {
      started: true;
      /** The instance the database on the volume names, or `fresh` when
       *  the volume held none after the restore. */
      bootedAs: string;
      /** The `S3_PREFIX` the entrypoint handed the server. */
      serverPrefix: string;
      output: () => string;
      stop: () => Promise<number | null>;
    }
  | { started: false; code: number | null; output: string };

/**
 * Runs the entrypoint on `volume` as the instance `name`, with `prefix` as
 * its `S3_PREFIX` (unset when `undefined`) and `env` added, and waits until
 * the stand-in server reports what it started on or the entrypoint ends.
 */
export async function start(
  volume: string,
  name: string,
  prefix: string | undefined,
  env: NodeJS.ProcessEnv = {},
): Promise<Start> {
  const run = mkdtempSync(join(tmpdir(), "marfa-backup-run-"));
  dirs.push(run);
  const bin = join(run, "bin");
  mkdirSync(bin);
  const executable = (path: string, lines: string[]) => {
    writeFileSync(path, `${lines.join("\n")}\n`);
    chmodSync(path, 0o755);
  };
  executable(join(bin, "node"), [
    "#!/bin/sh",
    'if [ "${1:-}" = dist/replica-check.js ]; then',
    "  shift",
    `  exec "${process.execPath}" "${REPLICA_CHECK}" "$@"`,
    "fi",
    `run="${run}"`,
    'printf "%s" "$S3_PREFIX" > "$run/prefix"',
    'if [ -e "$SQLITE_PATH" ]; then',
    '  sqlite3 "$SQLITE_PATH" "SELECT owner FROM marker;" > "$run/booted.tmp"',
    "else",
    '  echo fresh > "$run/booted.tmp"',
    `  sqlite3 "$SQLITE_PATH" "PRAGMA journal_mode=WAL; CREATE TABLE marker (owner TEXT); CREATE TABLE starts (name TEXT); INSERT INTO marker VALUES ('${name}');" > /dev/null`,
    "fi",
    `sqlite3 "$SQLITE_PATH" "INSERT INTO starts VALUES ('${name}');"`,
    'mv "$run/booted.tmp" "$run/booted"',
    "trap 'exit 0' TERM INT",
    "while :; do sleep 0.1; done",
  ]);
  // The real Litestream, reading the shipped file where the image puts it.
  executable(join(bin, "litestream"), [
    "#!/bin/sh",
    "count=$#",
    "while [ $count -gt 0 ]; do",
    "  arg=$1; shift; count=$((count - 1))",
    `  [ "$arg" = /etc/litestream.yml ] && arg="${SHIPPED_CONFIG}"`,
    '  set -- "$@" "$arg"',
    "done",
    `exec "${litestreamBinary}" "$@"`,
  ]);

  const child = spawn("/bin/sh", [ENTRYPOINT], {
    env: {
      PATH: `${bin}:${dirname(sqliteBinary)}:/usr/bin:/bin`,
      SQLITE_PATH: sqlitePath(volume),
      BLOB_PATH: join(dataDir(volume), "blobs"),
      S3_BUCKET: process.env.S3_BUCKET,
      S3_REGION: process.env.S3_REGION,
      S3_ENDPOINT: process.env.S3_ENDPOINT,
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
      ...(process.env.S3_FORCE_PATH_STYLE
        ? { S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE }
        : {}),
      ...(prefix === undefined ? {} : { S3_PREFIX: prefix }),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  running.push(child);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (output += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (output += c));
  let ended: { code: number | null } | undefined;
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("close", (code) => {
      ended = { code };
      resolveExit(code);
    });
  });

  const report = join(run, "booted");
  const deadline = Date.now() + BOOT_BUDGET_MS;
  while (!existsSync(report)) {
    if (ended !== undefined) {
      return { started: false, code: ended.code, output };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the instance ${name} neither started nor ended:\n${output}`,
      );
    }
    await pause(50);
  }
  return {
    started: true,
    bootedAs: readFileSync(report, "utf8").trim(),
    serverPrefix: readFileSync(join(run, "prefix"), "utf8"),
    output: () => output,
    stop: async () => {
      child.kill("SIGTERM");
      const code = await Promise.race([
        exited,
        pause(STOP_BUDGET_MS).then(() => "late" as const),
      ]);
      if (code === "late") throw new Error(`${name} did not stop:\n${output}`);
      return code;
    },
  };
}

/** `start` on `volume`, which must start. */
export async function boot(
  volume: string,
  name: string,
  prefix: string | undefined,
  env: NodeJS.ProcessEnv = {},
): Promise<Extract<Start, { started: true }>> {
  const started = await start(volume, name, prefix, env);
  if (!started.started) {
    throw new Error(
      `the instance ${name} ended with ${String(started.code)} before it started:\n${started.output}`,
    );
  }
  return started;
}

/**
 * Waits until Litestream has written a key under `path` that is not in
 * `before`, and answers every key there.
 */
export async function replicaAt(
  path: string,
  before: string[] = [],
): Promise<string[]> {
  const known = new Set(before);
  const deadline = Date.now() + BOOT_BUDGET_MS;
  for (;;) {
    const keys = await keysUnder(`${path}/`);
    if (keys.some((key) => !known.has(key))) return keys;
    if (Date.now() > deadline) throw new Error(`nothing new reached ${path}/`);
    await pause(250);
  }
}
