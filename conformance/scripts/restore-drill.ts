/**
 * The restore drill: a fresh instance rebuilt from the bucket alone, to the
 * byte.
 *
 *   tsx scripts/restore-drill.ts [--state <dir>] [--keep]
 *
 * Needs `litestream` and `sqlite3` on the path and the `S3_*` names in the
 * environment, which it reads and never prints. `S3_PREFIX` is not read:
 * the drill works under a prefix of its own, `drill/<id>/`, and removes it,
 * with its own state directory, at the end unless `--keep` is given. The
 * Litestream configuration is the shipped `deploy/litestream.yml` with its
 * replica path moved under that prefix, so what the drill proves is the
 * recipe a deployment runs.
 *
 * 1. A source instance boots with Litestream replicating its database to
 *    `drill/<id>/db` and its object store at `drill/<id>/blobs`. Phase A
 *    writes items and blobs (referenced and unreferenced, one large enough
 *    to take the object store's multipart path) and runs replication to
 *    zero remaining; the time is recorded as T1. Phase B writes more. The
 *    server and then Litestream are stopped, a last sync is forced, and the
 *    source is fingerprinted at rest: a content hash over every table, the
 *    schema,
 *    the item count, the file's sha256, and every blob's bytes as the
 *    instance served them and as the disk store holds them.
 * 2. `litestream restore` rebuilds the database into an empty directory,
 *    with a full integrity check, and the file is fingerprinted at rest
 *    before anything opens it. A second restore, to T1, must hold exactly
 *    phase A's items: point in time, proven rather than asserted.
 * 3. A second instance boots from the restored file, the same bucket and an
 *    empty blob folder, runs replication until its own disk holds every
 *    blob, and every blob is read back over `GET /blobs/{hash}` and from
 *    that disk.
 * 4. The two fingerprints must agree on the content hash, the schema, the
 *    item count, the instance id and every blob's bytes. The file-level
 *    sha256 is reported, not asserted: Litestream rebuilds the file from
 *    pages, and page order is not content.
 *
 * The report is printed and written to `reports/restore-drill.md` beside
 * the state directory; the exit code is non-zero on any mismatch.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { bootServer, stopServer } from "./marfa-server.js";
import { moveReplicaPath, same } from "../src/utils/drill.js";
import { parseEnvFile } from "../src/utils/target.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED_CONFIG = resolve(REPO_ROOT, "deploy/litestream.yml");
/** The names the bucket needs. The endpoint and the addressing style may be
 *  unset, which names the provider's own defaults. */
const REQUIRED_NAMES = [
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;
/** Long enough for Litestream's one-second sync to have run more than once
 *  after the last write, so a restore at T1 has an L0 boundary to land on. */
const SYNC_SETTLE_MS = 3_000;
const PROCESS_STOP_BUDGET_MS = 20_000;
/** Well past the object store's multipart threshold (the upload's part
 *  size, 5 MiB), so the drill reads a multipart object back as well as a
 *  single-part one. */
const LARGE_BLOB_BYTES = 70 * 1024 * 1024;

interface Args {
  state: string;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { state: resolve(".marfa-drill"), keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--state") args.state = resolve(argv[++i] ?? "");
    else if (arg === "--keep") args.keep = true;
    else throw new Error(`unexpected argument: ${arg ?? ""}`);
  }
  return args;
}

function requireOnPath(binary: string, versionArgs: string[]): string {
  const probe = spawnSync(binary, versionArgs, { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(`${binary} is not on the path`);
  }
  return probe.stdout.trim().split("\n")[0] ?? "";
}

function requireBucketEnv(): void {
  const missing = REQUIRED_NAMES.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`the bucket is not named: ${missing.join(", ")} unset`);
  }
}

function sqlite3(db: string, command: string): string {
  const out = spawnSync("sqlite3", [db, command], { encoding: "utf8" });
  if (out.status !== 0) {
    throw new Error(`sqlite3 ${command} failed: ${out.stderr}`);
  }
  return out.stdout.trim();
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The shipped configuration with its replica path moved under the
 *  drill's prefix (`moveReplicaPath` says what else holds). */
function writeLitestreamConfig(path: string, prefix: string): void {
  writeFileSync(
    path,
    moveReplicaPath(readFileSync(SHIPPED_CONFIG, "utf8"), prefix),
  );
}

function litestream(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("litestream", args, { encoding: "utf8", env });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function startLitestream(
  config: string,
  log: string,
  env: NodeJS.ProcessEnv,
): number {
  const fd = openSync(log, "a");
  const child = spawn("litestream", ["replicate", "-config", config], {
    detached: true,
    env,
    stdio: ["ignore", fd, fd],
  });
  if (child.pid === undefined) throw new Error("failed to spawn litestream");
  child.unref();
  return child.pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(pid: number): Promise<void> {
  if (!alive(pid)) return;
  process.kill(-pid, "SIGTERM");
  const deadline = Date.now() + PROCESS_STOP_BUDGET_MS;
  while (alive(pid) && Date.now() < deadline) await sleep(200);
  if (alive(pid)) process.kill(-pid, "SIGKILL");
}

function restore(
  config: string,
  db: string,
  out: string,
  env: NodeJS.ProcessEnv,
  timestamp?: string,
): string {
  const args = [
    "restore",
    "-config",
    config,
    "-o",
    out,
    "-integrity-check",
    "full",
  ];
  if (timestamp) args.push("-timestamp", timestamp);
  args.push(db);
  const result = litestream(args, env);
  if (result.status !== 0) {
    throw new Error(`litestream ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stderr.trim();
}

interface Api {
  url: string;
  key: string;
}

async function call<T>(
  api: Api,
  method: string,
  path: string,
  body?: Uint8Array<ArrayBuffer> | Record<string, unknown>,
  contentType = "application/json",
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${api.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${api.key}`,
      ...(body === undefined ? {} : { "Content-Type": contentType }),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof Uint8Array
          ? body
          : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the text itself is the answer.
  }
  return { status: res.status, body: parsed as T };
}

/** A key that may write every type, minted through the operator's; the
 *  operator's own key runs the housekeeping door and nothing else. */
async function mintWorkingKey(operator: Api): Promise<string> {
  const { status, body } = await call<{ key: string }>(
    operator,
    "POST",
    "/keys",
    {
      label: "restore-drill",
      source: "restore-drill",
      type_permissions: { "*": "write" },
    },
  );
  if (status !== 201) {
    throw new Error(
      `key mint answered ${String(status)}: ${JSON.stringify(body)}`,
    );
  }
  return body.key;
}

async function uploadBlob(
  api: Api,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const { status, body } = await call<{ hash: string }>(
    api,
    "POST",
    "/blobs",
    bytes,
    "application/octet-stream",
  );
  if (status !== 201) throw new Error(`upload answered ${String(status)}`);
  return body.hash;
}

async function createItem(
  api: Api,
  type: string,
  properties: Record<string, unknown>,
): Promise<void> {
  const { status, body } = await call(api, "POST", "/items", {
    type,
    properties,
  });
  if (status !== 201) {
    throw new Error(
      `item write answered ${String(status)}: ${JSON.stringify(body)}`,
    );
  }
}

async function replicateToZero(api: Api): Promise<number> {
  let copied = 0;
  for (let i = 0; i < 100; i++) {
    const { status, body } = await call<{
      outcome: string;
      result: { copied: number; remaining: number };
      error?: string;
    }>(api, "POST", "/housekeeping/blob-replicate/run");
    if (status === 409) {
      await sleep(100);
      continue;
    }
    if (status !== 200 || body.outcome !== "ok") {
      throw new Error(
        `blob-replicate answered ${String(status)}: ${JSON.stringify(body)}`,
      );
    }
    copied += body.result.copied;
    if (body.result.remaining === 0) return copied;
  }
  throw new Error("blob-replicate never reached remaining: 0");
}

async function instanceId(api: Api): Promise<string> {
  const { status, body } = await call<{ instance_id: string }>(api, "GET", "/");
  if (status !== 200) throw new Error(`GET / answered ${String(status)}`);
  return body.instance_id;
}

/** Every blob's bytes as the instance serves them, hashed. */
async function blobsOverHttp(
  api: Api,
  hashes: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const hash of hashes) {
    const res = await fetch(`${api.url}/blobs/${hash}`, {
      headers: { Authorization: `Bearer ${api.key}` },
    });
    if (res.status !== 200) {
      throw new Error(`GET /blobs/${hash} answered ${String(res.status)}`);
    }
    out[hash] = createHash("sha256")
      .update(new Uint8Array(await res.arrayBuffer()))
      .digest("hex");
  }
  return out;
}

/** Every blob file under a disk store, hashed, keyed by its name. */
function blobsOnDisk(blobPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const shard of readdirSync(blobPath)) {
    const dir = join(blobPath, shard);
    if (shard === "tmp" || !statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      out[`sha256:${file}`] = sha256File(join(dir, file));
    }
  }
  return out;
}

interface AtRest {
  contentHash: string;
  schema: string;
  itemCount: number;
  fileSha256: string;
  tables: Record<string, string>;
}

/**
 * One table's content hash, for naming what differs when the whole hash
 * does. `.sha3sum` prints the hash for one of SQLite's own tables and then
 * exits non-zero, so the answer is read off its output rather than its
 * exit status; a table it cannot hash at all answers "unhashable".
 */
function tableHash(db: string, table: string): string {
  const out = spawnSync("sqlite3", [db, `.sha3sum --sha3-256 ${table}`], {
    encoding: "utf8",
  });
  const line = out.stdout.split("\n").find((l) => l.includes("|"));
  return line?.split("|")[0] ?? "unhashable";
}

/** The database as a file nothing has open: a checkpoint first, so the
 *  file alone carries every page. The whole-database hash with `--schema`
 *  covers every table, SQLite's own included; the per-table hashes are for
 *  the report, and a virtual table's content is in its shadow tables. */
function fingerprintAtRest(db: string): AtRest {
  sqlite3(db, "PRAGMA wal_checkpoint(TRUNCATE);");
  const tables: Record<string, string> = {};
  for (const table of sqlite3(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name;",
  ).split("\n")) {
    if (table === "") continue;
    tables[table] = tableHash(db, table);
  }
  return {
    contentHash: sqlite3(db, ".sha3sum --sha3-256 --schema"),
    schema: sqlite3(db, ".schema"),
    itemCount: Number(sqlite3(db, "SELECT count(*) FROM items;")),
    fileSha256: sha256File(db),
    tables,
  };
}

async function deletePrefix(prefix: string): Promise<number> {
  const client = new S3Client({
    region: process.env.S3_REGION ?? "",
    ...(process.env.S3_ENDPOINT
      ? {
          endpoint: process.env.S3_ENDPOINT,
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
        }
      : {}),
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    },
  });
  const bucket = process.env.S3_BUCKET ?? "";
  let removed = 0;
  let token: string | undefined;
  try {
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: token,
        }),
      );
      const keys = (page.Contents ?? []).flatMap((o) =>
        o.Key ? [{ Key: o.Key }] : [],
      );
      if (keys.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys },
          }),
        );
        removed += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } finally {
    client.destroy();
  }
  return removed;
}

/** The operator's key and the url, from the env file a boot wrote. */
function apiFor(state: string): Api {
  const env = parseEnvFile(readFileSync(join(state, "env"), "utf8"));
  return { url: env.MARFA_API_URL ?? "", key: env.MARFA_OPERATOR_KEY ?? "" };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const litestreamVersion = requireOnPath("litestream", ["version"]);
  const sqliteVersion = requireOnPath("sqlite3", ["--version"]);
  requireBucketEnv();

  const id = randomBytes(4).toString("hex");
  const prefix = `drill/${id}`;
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    console.log(line);
  };
  const failures: string[] = [];
  const check = (name: string, a: unknown, b: unknown) => {
    const agree = same(a, b);
    say(`- ${agree ? "same" : "DIFFERENT"}: ${name}`);
    if (!agree) failures.push(name);
  };
  // The comparison's own control, before anything is compared: a verdict
  // that could not say "different" would be no verdict.
  if (same("source", "restored") || !same("source", "source")) {
    throw new Error("the comparison cannot tell same from different");
  }

  say(`# Restore drill ${id}`);
  say("");
  say(
    `${new Date().toISOString()}; Litestream ${litestreamVersion}; sqlite3 ${sqliteVersion.split(" ")[0] ?? ""}. Bucket named by \`S3_BUCKET\`, prefix \`${prefix}/\`, ${process.env.S3_ENDPOINT ? "an endpoint set" : "no endpoint set"}, ${process.env.S3_FORCE_PATH_STYLE === "false" ? "virtual-hosted" : "path-style"} addressing.`,
  );
  say("");

  rmSync(args.state, { recursive: true, force: true });
  const sourceState = join(args.state, "source");
  const restoredState = join(args.state, "restored");
  const pitState = join(args.state, "point-in-time");
  for (const dir of [sourceState, restoredState, pitState]) {
    mkdirSync(dir, { recursive: true });
  }
  const sourceDb = join(sourceState, "marfa.db");
  const config = join(args.state, "litestream.yml");
  writeLitestreamConfig(config, prefix);
  // What the sidecar reads: the shipped names, with the database this run
  // replicates. The addressing style is spelled out because the server
  // reads an unset value as `true` and the sidecar's file needs a word.
  const sidecarEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SQLITE_PATH: sourceDb,
    S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE ?? "true",
  };

  let litestreamPid: number | undefined;
  try {
    // 1. The source instance, replicating.
    process.env.S3_PREFIX = `${prefix}/blobs`;
    await bootServer({ state: sourceState });
    const sourceOperator = apiFor(sourceState);
    const workingKey = await mintWorkingKey(sourceOperator);
    const source: Api = { url: sourceOperator.url, key: workingKey };
    litestreamPid = startLitestream(
      config,
      join(args.state, "litestream.log"),
      sidecarEnv,
    );
    say(
      `Source instance booted; Litestream replicating its database (pid ${String(litestreamPid)}).`,
    );

    const hashes: string[] = [];
    const bytesOf: Record<string, number> = {};
    const upload = async (bytes: Uint8Array<ArrayBuffer>) => {
      const hash = await uploadBlob(source, bytes);
      hashes.push(hash);
      bytesOf[hash] = bytes.length;
      return hash;
    };
    const small = await upload(
      new TextEncoder().encode(`phase A, a small file, run ${id}`),
    );
    await createItem(source, "core.file", {
      blob_ref: small,
      mime_type: "application/octet-stream",
      name: "small",
    });
    const large = await upload(new Uint8Array(randomBytes(LARGE_BLOB_BYTES)));
    await createItem(source, "core.file", {
      blob_ref: large,
      mime_type: "application/octet-stream",
      name: "large",
    });
    await upload(
      new TextEncoder().encode(`phase A, nothing names this, run ${id}`),
    );
    for (let i = 0; i < 20; i++) {
      await createItem(source, "core.note", {
        body: `phase A note ${String(i)}`,
      });
    }
    const copiedA = await replicateToZero(sourceOperator);
    await sleep(SYNC_SETTLE_MS);
    const phaseACount = Number(
      sqlite3(sourceDb, "SELECT count(*) FROM items;"),
    );
    // Whole seconds: the restore takes a timestamp, and the sync that
    // follows the last write has landed by now.
    const t1 = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    say(
      `Phase A: ${String(phaseACount)} items and ${String(hashes.length)} blobs written (one of ${String(LARGE_BLOB_BYTES)} bytes, one that nothing names), ${String(copiedA)} copies made by replication, zero remaining; T1 = ${t1}.`,
    );
    await sleep(SYNC_SETTLE_MS);

    const later = await upload(
      new TextEncoder().encode(`phase B, after the point in time, run ${id}`),
    );
    await createItem(source, "core.file", {
      blob_ref: later,
      mime_type: "application/octet-stream",
      name: "later",
    });
    for (let i = 0; i < 10; i++) {
      await createItem(source, "core.note", {
        body: `phase B note ${String(i)}`,
      });
    }
    const copiedB = await replicateToZero(sourceOperator);
    const sourceInstance = await instanceId(source);
    const sourceOverHttp = await blobsOverHttp(source, hashes);
    say(
      `Phase B: ${String(hashes.length - 3)} more blob and 11 more items written, ${String(copiedB)} copies made by replication.`,
    );

    // The server first, then the sidecar, then one more sync. The sidecar
    // syncs on its way down, and the drill has passed without this; it is
    // here so the verdict rests on the replica and not on that shutdown.
    await stopServer({ state: sourceState });
    await stopProcess(litestreamPid);
    litestreamPid = undefined;
    const once = litestream(
      ["replicate", "-config", config, "-once"],
      sidecarEnv,
    );
    if (once.status !== 0) {
      throw new Error(`litestream replicate -once failed:\n${once.stderr}`);
    }
    const sourceAtRest = fingerprintAtRest(sourceDb);
    const sourceOnDisk = blobsOnDisk(join(sourceState, "blobs"));
    say(
      `Source at rest: ${String(sourceAtRest.itemCount)} items, ${String(Object.keys(sourceAtRest.tables).length)} tables, content hash \`${sourceAtRest.contentHash}\`, file sha256 \`${sourceAtRest.fileSha256}\`, instance \`${sourceInstance}\`.`,
    );

    // 2. Restore, latest and at T1, into empty directories.
    const restoredDb = join(restoredState, "marfa.db");
    restore(config, sourceDb, restoredDb, sidecarEnv);
    const restoredAtRest = fingerprintAtRest(restoredDb);
    say(
      `Restored the latest replica with a full integrity check: ${String(restoredAtRest.itemCount)} items, content hash \`${restoredAtRest.contentHash}\`, file sha256 \`${restoredAtRest.fileSha256}\`.`,
    );
    const pitDb = join(pitState, "marfa.db");
    restore(config, sourceDb, pitDb, sidecarEnv, t1);
    const pitCount = Number(sqlite3(pitDb, "SELECT count(*) FROM items;"));
    say(
      `Restored to T1 with a full integrity check: ${String(pitCount)} items.`,
    );

    // 3. Boot from the restored file, the same bucket and an empty blob
    // folder. The file carries the source's keys, so the boot reuses the
    // source's env file rather than minting again.
    writeFileSync(
      join(restoredState, "env"),
      readFileSync(join(sourceState, "env")),
    );
    await bootServer({ state: restoredState });
    const restoredOperator = apiFor(restoredState);
    const restored: Api = { url: restoredOperator.url, key: workingKey };
    const restoredInstance = await instanceId(restored);
    const copiedBack = await replicateToZero(restoredOperator);
    const restoredOverHttp = await blobsOverHttp(restored, hashes);
    await stopServer({ state: restoredState });
    const restoredOnDisk = blobsOnDisk(join(restoredState, "blobs"));
    say(
      `Restored instance booted from the file and the bucket alone: instance \`${restoredInstance}\`; replication brought ${String(copiedBack)} copies to its empty disk store.`,
    );

    // 4. Compare.
    say("");
    say("## Comparison");
    check(
      "database content hash, sha3-256 over every table and the schema",
      sourceAtRest.contentHash,
      restoredAtRest.contentHash,
    );
    if (sourceAtRest.contentHash !== restoredAtRest.contentHash) {
      for (const table of Object.keys(sourceAtRest.tables)) {
        if (sourceAtRest.tables[table] !== restoredAtRest.tables[table]) {
          say(`  - table \`${table}\` differs`);
        }
      }
    }
    check("database schema", sourceAtRest.schema, restoredAtRest.schema);
    check("item count", sourceAtRest.itemCount, restoredAtRest.itemCount);
    check("instance id", sourceInstance, restoredInstance);
    check(
      `every blob over GET /blobs/{hash} (${String(hashes.length)} blobs, ${String(Object.values(bytesOf).reduce((a, b) => a + b, 0))} bytes)`,
      sourceOverHttp,
      restoredOverHttp,
    );
    check("every blob on the disk store", sourceOnDisk, restoredOnDisk);
    check(
      "blobs the instance served against the files on its disk",
      sourceOverHttp,
      Object.fromEntries(hashes.map((h) => [h, sourceOnDisk[h]])),
    );
    check(
      `items at T1 against phase A (${String(pitCount)} restored, ${String(phaseACount)} written)`,
      pitCount,
      phaseACount,
    );
    say(
      `- reported, not asserted: file sha256 source \`${sourceAtRest.fileSha256}\`, restored \`${restoredAtRest.fileSha256}\` (Litestream rebuilds the file from pages; page order is not content)`,
    );
  } catch (err) {
    say("");
    // The first line only: a boot's failure quotes the server log, which
    // can carry the bootstrap secret, and this report is kept as an
    // artifact.
    const message = err instanceof Error ? err.message : String(err);
    say(`Aborted: ${message.split("\n")[0] ?? ""}`);
    failures.push("the drill aborted before its comparison");
    throw err;
  } finally {
    // Both, whether or not a boot got as far as answering: a server that
    // was spawned and never answered `/health` is still running, and
    // `stopServer` answers quietly when there is nothing to stop.
    await stopServer({ state: sourceState }).catch(() => undefined);
    await stopServer({ state: restoredState }).catch(() => undefined);
    if (litestreamPid !== undefined) await stopProcess(litestreamPid);
    say("");
    if (args.keep) {
      say(`Kept the objects under \`${prefix}/\` and the state directory.`);
    } else {
      const removed = await deletePrefix(prefix);
      // The state goes too: three copies of the large blob, and two server
      // logs and a Litestream log that name the bucket.
      rmSync(args.state, { recursive: true, force: true });
      say(
        `Removed ${String(removed)} objects under \`${prefix}/\` and the state directory.`,
      );
    }
    say("");
    say(
      failures.length === 0
        ? "## Result: restored to the byte"
        : `## Result: FAILED (${failures.join("; ")})`,
    );
    const reportDir = join(dirname(args.state), "reports");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "restore-drill.md"), lines.join("\n") + "\n");
  }
  if (failures.length > 0) process.exitCode = 1;
}

await main();
