/**
 * The restore drill: an instance thrown away and rebuilt from its bucket
 * alone, every line and every file checked.
 *
 *   tsx scripts/restore-drill.ts [--state <dir>] [--keep]
 *
 * Needs `MARFA_SERVER_BIN` and the `S3_*` names in the environment, which it
 * reads and never prints. `S3_PREFIX` is not read: the drill sets it to a
 * prefix of its own, `drill/<id>`, and removes what is under it, with its own
 * state directory, at the end unless `--keep` is given.
 *
 * 1. A source server boots on the bucket and is given a registered type with
 *    a table and its rows, notes with a history, one in the trash, files
 *    (one large enough to take the object store's multipart path), edges
 *    with properties and a stored setting. Replication copies every file to
 *    the bucket, and the owner takes a backup.
 * 2. The source is fingerprinted: an archive export of everything, its
 *    instance, item, edge and row lines, and every file's bytes as served.
 * 3. The source stops, and its whole data directory is deleted.
 * 4. A fresh server boots on an empty data directory and the same bucket,
 *    lists the backup in the source's folder and restores it.
 * 5. The restored server is fingerprinted the same way, with every file read
 *    from the bucket, and the two must agree line for line and byte for byte.
 *
 * The report is printed and written to `reports/restore-drill.md` beside
 * the state directory; the exit code is non-zero on any mismatch.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { MarfaClient } from "../src/client/api.js";
import { archiveLines, type LineFile } from "../src/utils/archive.js";
import { same } from "../src/utils/drill.js";
import { parseEnvFile } from "../src/utils/target.js";
import { bootServer, serverProgram, stopServer } from "./marfa-server.js";

/** The names the bucket needs. The endpoint and the addressing style may be
 *  unset, which names the provider's own defaults. */
const REQUIRED_NAMES = [
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;
/** Well past the object store's multipart threshold (the upload's part
 *  size, 5 MiB), so the restore reads a multipart object back as well as a
 *  single-part one. */
const LARGE_BLOB_BYTES = 70 * 1024 * 1024;
const LINE_FILES: readonly LineFile[] = ["instance", "items", "edges", "rows"];
const ROWS = 250;
const NOTES = 40;

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

function requireBucketEnv(): void {
  const missing = REQUIRED_NAMES.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`the bucket is not named: ${missing.join(", ")} unset`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What an answer must be, or the drill stops naming the step. */
function expectOk<T>(
  step: string,
  answer: { ok: boolean; status: number; data: T; error?: unknown },
): T {
  if (!answer.ok) {
    throw new Error(
      `${step} answered ${String(answer.status)}: ${JSON.stringify(answer.error).slice(0, 300)}`,
    );
  }
  return answer.data;
}

interface Server {
  /** The owner, through the private local command. */
  owner: MarfaClient;
  /** A key minted with no narrowing, which reaches everything. */
  everything: MarfaClient;
}

async function serverAt(state: string): Promise<Server> {
  const env = parseEnvFile(readFileSync(join(state, "env"), "utf8"));
  const url = env.MARFA_API_URL;
  const socket = env.MARFA_CONTROL_SOCKET;
  if (!url || !socket) throw new Error(`no server answers from ${state}`);
  const owner = new MarfaClient({ baseUrl: url, controlSocket: socket });
  const minted = expectOk(
    "minting a key that reaches everything",
    await owner.createKey({ label: "restore drill", source: "restore-drill" }),
  );
  return {
    owner,
    everything: new MarfaClient({ baseUrl: url, apiKey: minted.key }),
  };
}

/** Runs a housekeeping job until it reports nothing left to do. */
async function replicateToZero(owner: MarfaClient): Promise<number> {
  let copied = 0;
  for (let i = 0; i < 100; i++) {
    const run = await owner.runHousekeeping("blob-replicate");
    if (run.status === 409) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const data = expectOk("blob-replicate", run) as {
      outcome: string;
      result: { copied?: number; remaining?: number };
    };
    if (data.outcome !== "ok") {
      throw new Error(`blob-replicate ended ${JSON.stringify(data)}`);
    }
    copied += data.result.copied ?? 0;
    if (data.result.remaining === 0) return copied;
  }
  throw new Error("blob-replicate never reached remaining: 0");
}

/** The source's contents, written through a key that reaches everything. */
async function fill(
  client: MarfaClient,
  id: string,
): Promise<{ files: string[]; bytes: number }> {
  const type = `user.drill_ledger_${id}`;
  expectOk(
    "registering a type with a table",
    await client.registerType({
      id: type,
      fields: { title: { type: "string" }, amount: { type: "number" } },
      tables: {
        lines: {
          columns: { label: { type: "string" }, amount: { type: "number" } },
        },
      },
    } as never),
  );
  const ledger = expectOk(
    "creating a ledger",
    await client.createItem({
      type,
      properties: { title: "the drill's ledger", amount: 1 },
    } as never),
  ).item.id;
  for (let from = 0; from < ROWS; from += 100) {
    expectOk(
      "writing rows",
      await client.writeRows(ledger, "lines", {
        operations: Array.from(
          { length: Math.min(100, ROWS - from) },
          (_, at) => ({
            op: "put" as const,
            values: { label: `line ${String(from + at)}`, amount: from + at },
          }),
        ),
      }),
    );
  }

  const notes: string[] = [];
  for (let i = 0; i < NOTES; i++) {
    const note = expectOk(
      "creating a note",
      await client.createItem({
        type: "core.note",
        properties: { title: `note ${String(i)}`, body: `run ${id}` },
      }),
    ).item;
    notes.push(note.id);
    if (i % 4 === 0) {
      expectOk(
        "updating a note",
        await client.updateItem(note.id, {
          version: note.version,
          properties: { title: `note ${String(i)}, edited`, body: `run ${id}` },
        } as never),
      );
    }
  }
  expectOk("trashing a note", await client.deleteItem(notes[NOTES - 1]!));

  const files: string[] = [];
  let bytes = 0;
  for (const [name, content] of [
    ["small.txt", new TextEncoder().encode(`a small file, run ${id}`)],
    ["large.bin", new Uint8Array(randomBytes(LARGE_BLOB_BYTES))],
  ] as const) {
    const blob = expectOk(
      `uploading ${name}`,
      await client.uploadBlob(content, "application/octet-stream"),
    );
    files.push(blob.hash);
    bytes += content.length;
    const item = expectOk(
      `creating the item for ${name}`,
      await client.createItem({
        type: "core.file",
        properties: {
          title: name,
          blob_ref: blob.hash,
          mime_type: "application/octet-stream",
        },
      }),
    ).item;
    expectOk(
      "linking a file to the ledger",
      await client.createEdge({
        source_id: ledger,
        target_id: item.id,
        edge_type: "references",
        properties: { why: `holds ${name}` },
      } as never),
    );
  }
  for (let i = 1; i < 10; i++) {
    expectOk(
      "linking two notes",
      await client.createEdge({
        source_id: notes[i - 1]!,
        target_id: notes[i]!,
        edge_type: "references",
      } as never),
    );
  }
  expectOk(
    "storing a setting",
    await client.patchConfig({ trash_retention_days: 45 }),
  );
  return { files, bytes };
}

interface Fingerprint {
  lines: Record<LineFile, unknown[]>;
  files: Record<string, string>;
}

/** A value with every object's keys in order, since JSON gives key order no meaning. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

/** Every line an archive of everything carries, sorted, and every file's bytes as served. */
async function fingerprint(
  client: MarfaClient,
  files: readonly string[],
): Promise<Fingerprint> {
  const archive = expectOk(
    "exporting an archive of everything",
    await client.exportArchive({ state: "any", files: "false" }),
  );
  const lines = Object.fromEntries(
    LINE_FILES.map((name) => [
      name,
      archiveLines(archive, name)
        .map((line) => JSON.stringify(canonical(line)))
        .sort()
        .map((line) => JSON.parse(line) as unknown),
    ]),
  ) as Record<LineFile, unknown[]>;
  const served: Record<string, string> = {};
  for (const hash of files) {
    const read = expectOk(`reading ${hash}`, await client.downloadBlob(hash));
    served[hash] = sha256(new Uint8Array(read));
  }
  return { lines, files: served };
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (serverProgram() === undefined) {
    throw new Error("MARFA_SERVER_BIN does not name the server to drill");
  }
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
    `${new Date().toISOString()}. Bucket named by \`S3_BUCKET\`, prefix \`${prefix}/\`, ${process.env.S3_ENDPOINT ? "an endpoint set" : "no endpoint set"}.`,
  );
  say("");

  rmSync(args.state, { recursive: true, force: true });
  const sourceState = join(args.state, "source");
  const restoredState = join(args.state, "restored");
  for (const dir of [sourceState, restoredState]) {
    mkdirSync(dir, { recursive: true });
  }
  process.env.S3_PREFIX = prefix;
  const boot = (state: string) =>
    bootServer({ state, env: { MARFA_BACKUP_INTERVAL_SECONDS: "0" } });

  try {
    // 1. The source, filled and backed up.
    await boot(sourceState);
    const source = await serverAt(sourceState);
    const { files, bytes } = await fill(source.everything, id);
    const copied = await replicateToZero(source.owner);
    const sourceId = expectOk(
      "reading the instance",
      await source.owner.root(),
    ).instance_id;
    const backup = expectOk(
      "taking a backup",
      await source.owner.runBackup(),
    ).backup;
    say(
      `Source \`${sourceId}\`: ${String(ROWS)} rows, ${String(NOTES)} notes, ${String(files.length)} files of ${String(bytes)} bytes, ${String(copied)} copies made to the bucket; backup \`${backup.name}\`, ${String(backup.size_bytes)} bytes.`,
    );

    // 2. What the source holds.
    const before = await fingerprint(source.everything, files);
    say(
      `Source fingerprint: ${LINE_FILES.map((name) => `${String(before.lines[name].length)} ${name} lines`).join(", ")}.`,
    );

    // 3. The source's data, thrown away.
    await stopServer({ state: sourceState });
    rmSync(sourceState, { recursive: true, force: true });
    say("Source stopped and its data directory deleted.");

    // 4. A fresh server on the same bucket, restoring the backup.
    await boot(restoredState);
    const restored = await serverAt(restoredState);
    const listed = expectOk(
      "listing the backups",
      await restored.owner.listBackups(),
    );
    check(
      "the fresh server lists the source's backup",
      listed.data.some(
        (row) => row.name === backup.name && row.instance_id === sourceId,
      ),
      true,
    );
    const answer = expectOk(
      "restoring the backup",
      await restored.owner.restoreBackup(sourceId, backup.name),
    );
    check("files the restore could not find", answer.blobs_missing, []);
    say(
      `Restored \`${backup.name}\` into a fresh server: ${JSON.stringify({ ...answer, set_up_again: undefined })}.`,
    );

    // 5. What the restored server holds, every file read from the bucket.
    const after = await fingerprint(restored.everything, files);
    say("");
    say("## Comparison");
    for (const name of LINE_FILES) {
      check(
        `${name} lines (${String(before.lines[name].length)} on the source, ${String(after.lines[name].length)} restored)`,
        before.lines[name],
        after.lines[name],
      );
      const was = new Set(
        before.lines[name].map((line) => JSON.stringify(line)),
      );
      const is = new Set(after.lines[name].map((line) => JSON.stringify(line)));
      for (const line of [...was].filter((line) => !is.has(line)).slice(0, 5))
        say(`  - only on the source: \`${line.slice(0, 400)}\``);
      for (const line of [...is].filter((line) => !was.has(line)).slice(0, 5))
        say(`  - only restored: \`${line.slice(0, 400)}\``);
    }
    check(
      `every file's bytes as served (${String(files.length)} files, ${String(bytes)} bytes)`,
      before.files,
      after.files,
    );
  } catch (err) {
    say("");
    // The first line only: a boot's failure goes on to quote the server
    // log, which belongs in the step's output rather than the report.
    const message = err instanceof Error ? err.message : String(err);
    say(`Aborted: ${message.split("\n")[0] ?? ""}`);
    failures.push("the drill aborted before its comparison");
    throw err;
  } finally {
    await stopServer({ state: sourceState }).catch(() => undefined);
    await stopServer({ state: restoredState }).catch(() => undefined);
    say("");
    if (args.keep) {
      say(`Kept the objects under \`${prefix}/\` and the state directory.`);
    } else {
      const removed = await deletePrefix(prefix);
      rmSync(args.state, { recursive: true, force: true });
      say(
        `Removed ${String(removed)} objects under \`${prefix}/\` and the state directory.`,
      );
    }
    say("");
    say(
      failures.length === 0
        ? "## Result: restored whole"
        : `## Result: FAILED (${failures.join("; ")})`,
    );
    const reportDir = join(dirname(args.state), "reports");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "restore-drill.md"), lines.join("\n") + "\n");
  }
  if (failures.length > 0) process.exitCode = 1;
}

await main();
