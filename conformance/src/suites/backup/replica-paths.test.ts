/**
 * Where the image keeps an instance's database replica, and which replica a
 * fresh volume restores: the instance chapter's `instance/replica-*` rules.
 *
 * Each boot runs the shipped `deploy/entrypoint.sh` with the real Litestream
 * and the shipped `deploy/litestream.yml`, against the bucket the `S3_*`
 * names in the environment point at. The server is a stand-in that creates
 * a database naming its instance, or reports the instance named by the
 * database it found, so what is under test is only which replica reaches
 * which volume.
 *
 * Needs `litestream` and `sqlite3` on the path and a local object store
 * (`pnpm garage:up`). It writes under a prefix of its own and under the
 * default prefix's `db/`, and removes both at the end, so it refuses an
 * endpoint that is not on this machine.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const ENTRYPOINT = join(REPO_ROOT, "deploy/entrypoint.sh");
const SHIPPED_CONFIG = join(REPO_ROOT, "deploy/litestream.yml");
/** The server's default `S3_PREFIX`. */
const DEFAULT_PREFIX = "blobs";
const BOOT_BUDGET_MS = 20_000;
const STOP_BUDGET_MS = 20_000;

const run = `replica-paths/${randomBytes(4).toString("hex")}`;
const dirs: string[] = [];
const running: ChildProcess[] = [];
let litestreamBinary = "";
let client: S3Client;
let bucket = "";

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

/** Every key under `prefix`, in the order the store lists them. */
async function keysUnder(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
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

async function removeUnder(prefix: string): Promise<void> {
  const keys = await keysUnder(prefix);
  for (let i = 0; i < keys.length; i += 1000) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
      }),
    );
  }
}

beforeAll(async () => {
  litestreamBinary = onPath("litestream");
  onPath("sqlite3");
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
      "S3_ENDPOINT is not on this machine; this fixture writes under the default prefix and runs only against a local object store",
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
  // `db/` at the bucket's root belongs to no instance, so a key there is one
  // this fixture should not find.
  await removeUnder("db/");
  await removeUnder(`${DEFAULT_PREFIX}/db/`);
});

afterAll(async () => {
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
  if (bucket !== "") {
    await removeUnder(`${run}/`);
    await removeUnder(`${DEFAULT_PREFIX}/db/`);
    client.destroy();
  }
});

interface Boot {
  /** The instance the database on the volume names, or `fresh` when the
   *  volume held none after the restore. */
  bootedAs: string;
  /** The `S3_PREFIX` the entrypoint handed the server. */
  serverPrefix: string;
  stop: () => Promise<number | null>;
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * Boots the entrypoint on a new, empty volume as the instance `name`, with
 * `prefix` as its `S3_PREFIX` (unset when `undefined`), and waits for the
 * stand-in server to report what it started on.
 */
async function boot(name: string, prefix: string | undefined): Promise<Boot> {
  const dir = mkdtempSync(join(tmpdir(), "marfa-replica-paths-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const executable = (path: string, lines: string[]) => {
    writeFileSync(path, `${lines.join("\n")}\n`);
    chmodSync(path, 0o755);
  };
  executable(join(bin, "node"), [
    "#!/bin/sh",
    `dir="${dir}"`,
    'printf "%s" "$S3_PREFIX" > "$dir/prefix"',
    'if [ -e "$SQLITE_PATH" ]; then',
    '  sqlite3 "$SQLITE_PATH" "SELECT owner FROM marker;" > "$dir/booted.tmp"',
    "else",
    '  echo fresh > "$dir/booted.tmp"',
    `  sqlite3 "$SQLITE_PATH" "PRAGMA journal_mode=WAL; CREATE TABLE marker (owner TEXT); INSERT INTO marker VALUES ('${name}');" > /dev/null`,
    "fi",
    'mv "$dir/booted.tmp" "$dir/booted"',
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

  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${dirname(onPath("sqlite3"))}:/usr/bin:/bin`,
    SQLITE_PATH: join(dir, "data/marfa.db"),
    BLOB_PATH: join(dir, "data/blobs"),
    S3_BUCKET: process.env.S3_BUCKET,
    S3_REGION: process.env.S3_REGION,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    ...(process.env.S3_FORCE_PATH_STYLE
      ? { S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE }
      : {}),
    ...(prefix === undefined ? {} : { S3_PREFIX: prefix }),
  };
  const child = spawn("/bin/sh", [ENTRYPOINT], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  running.push(child);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (output += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (output += c));
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("close", (code) => {
      resolveExit(code);
    });
  });
  let ended = false;
  void exited.then(() => (ended = true));

  const report = join(dir, "booted");
  const deadline = Date.now() + BOOT_BUDGET_MS;
  while (!existsSync(report)) {
    if (ended || Date.now() > deadline) {
      throw new Error(`the instance ${name} did not start:\n${output}`);
    }
    await pause(50);
  }
  return {
    bootedAs: readFileSync(report, "utf8").trim(),
    serverPrefix: readFileSync(join(dir, "prefix"), "utf8"),
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

/** Waits until Litestream has written something under `path`, and answers
 *  what it wrote. */
async function replicaAt(path: string): Promise<string[]> {
  const deadline = Date.now() + BOOT_BUDGET_MS;
  for (;;) {
    const keys = await keysUnder(`${path}/`);
    if (keys.length > 0) return keys;
    if (Date.now() > deadline) throw new Error(`nothing reached ${path}/`);
    await pause(250);
  }
}

/** Boots an instance on a fresh volume, waits for its replica, stops it. */
async function seed(name: string, prefix: string | undefined, replica: string) {
  const instance = await boot(name, prefix);
  expect(instance.bootedAs).toBe("fresh");
  await replicaAt(replica);
  expect(await instance.stop()).toBe(0);
}

describe("deploy/litestream.yml and deploy/entrypoint.sh", () => {
  it("streams the database under the default prefix's db when S3_PREFIX is unset, and a fresh volume restores it", async () => {
    await seed("default", undefined, `${DEFAULT_PREFIX}/db`);
    const keys = await keysUnder(`${DEFAULT_PREFIX}/`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith(`${DEFAULT_PREFIX}/db/`))).toBe(
      true,
    );
    expect(await keysUnder("db/")).toEqual([]);

    const again = await boot("default-again", undefined);
    expect(again.serverPrefix).toBe(DEFAULT_PREFIX);
    expect(again.bootedAs).toBe("default");
    expect(await again.stop()).toBe(0);
  });

  it("keeps the replicas of two instances on one bucket apart, and each fresh volume restores only its own", async () => {
    // One prefix holds the other, which is as close as two instances'
    // prefixes come.
    const own = run;
    const trial = `${run}/rehearsal/blobs`;

    await seed("own", own, `${own}/db`);
    // The witness: the bucket holds a replica, and this volume would restore
    // it if the path were shared.
    expect((await keysUnder(`${own}/db/`)).length).toBeGreaterThan(0);

    const trialFirst = await boot("trial", trial);
    expect(trialFirst.serverPrefix).toBe(trial);
    expect(trialFirst.bootedAs).toBe("fresh");
    await replicaAt(`${trial}/db`);
    expect(await trialFirst.stop()).toBe(0);

    const ownAgain = await boot("own-again", own);
    expect(ownAgain.bootedAs).toBe("own");
    expect(await ownAgain.stop()).toBe(0);

    const trialAgain = await boot("trial-again", trial);
    expect(trialAgain.bootedAs).toBe("trial");
    expect(await trialAgain.stop()).toBe(0);

    // Nothing of either instance's replica is anywhere but under its prefix.
    const everything = await keysUnder(`${run}/`);
    expect(
      everything.filter(
        (key) =>
          !key.startsWith(`${own}/db/`) && !key.startsWith(`${trial}/db/`),
      ),
    ).toEqual([]);
  });

  it("reads a prefix with a slash at either end as the same prefix, for the replica and for the server", async () => {
    const prefix = `${run}/slashes`;
    await seed("slashes", `${prefix}/`, `${prefix}/db`);
    expect(await keysUnder(`${prefix}//`)).toEqual([]);

    for (const spelling of [prefix, `/${prefix}`, `/${prefix}/`]) {
      const again = await boot("slashes-again", spelling);
      expect(again.serverPrefix).toBe(prefix);
      expect(again.bootedAs).toBe("slashes");
      expect(await again.stop()).toBe(0);
    }
  });
});
