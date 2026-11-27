import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  archiveLines,
  LINE_FILES,
  listEntries,
  lostFiles,
  notCarried,
} from "../../utils/archive.js";
import {
  afterFirstScheduledBackup,
  backupConcerns,
  backupInFolder,
  backupName,
  attentionOf,
  healthDetail,
  instanceIdOf,
  ownerOf,
  partName,
  sha256Of,
  storedSize,
} from "../../utils/backups.js";
import { same } from "../../utils/drill.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  replicateUntilCaughtUp,
  runJob,
} from "../../utils/own-blob-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { diskHolds, inspectStores } from "../../utils/store-faults.js";
import { waitFor } from "../../utils/wait.js";
import { tempFolder } from "../../utils/temp-folder.js";

/**
 * Backups to a folder the owner names with `backup_path`: one manifest
 * per backup under `backups/<instance id>/`, the parts it names under
 * `backup-parts/<instance id>/`, a copy of each file a backup names
 * under `files/<instance id>/`, and a restore from the folder alone into a
 * fresh server on another data path.
 */
const folder = tempFolder("marfa-backup-folder-");
const away = `${folder}-away`;
const YEAR_SECONDS = "31536000";
const FOLDER_ONLY = {
  MARFA_OBJECT_STORE_BUCKET: "",
  MARFA_BACKUP_PATH: folder,
  MARFA_BACKUP_INTERVAL_SECONDS: "0",
};
let origin: FreshServer;
let originId: string;
const others: FreshServer[] = [];

beforeAll(async () => {
  origin = await bootFreshServer("backup-folder-origin", {
    ...FOLDER_ONLY,
    MARFA_BACKUP_INTERVAL_SECONDS: "31536000",
  });
  originId = await instanceIdOf(origin);
  await afterFirstScheduledBackup(origin);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  for (const server of others) await server.stop();
  await origin?.stop();
  rmSync(folder, { recursive: true, force: true });
  rmSync(away, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

/**
 * Holds the lock another Marfa server takes on a folder, from a process of its
 * own, until `release` is called.
 */
async function lockHeldOn(path: string): Promise<{ release(): Promise<void> }> {
  const holder = spawn(
    "perl",
    [
      "-e",
      'open(my $d, "<", $ARGV[0]) or die; flock($d, 2 | 4) or die "busy"; $| = 1; print "held\\n"; <STDIN>;',
      path,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const ended = new Promise<void>((done) => holder.once("close", () => done()));
  await new Promise<void>((resolve, reject) => {
    holder.stdout.once("data", () => resolve());
    holder.once("close", () => reject(new Error("the lock was not taken")));
  });
  return {
    async release() {
      holder.stdin.end();
      await ended;
    },
  };
}

async function health(server: FreshServer) {
  const answer = await clientsFor(server).operator.rawRequest<{
    status: string;
    backups: Record<string, unknown>;
  }>("/health");
  expect(answer.status, JSON.stringify(answer.data)).toBe(200);
  return answer.data;
}

/**
 * The parts folder of `instance` under `root`: the names a part is being
 * written under, which begin with `.`, and the parts stored, each of which
 * must hold the bytes its name gives.
 */
function partsIn(root: string, instance: string) {
  const dir = join(root, "backup-parts", instance);
  const names = existsSync(dir) ? readdirSync(dir).sort() : [];
  const writing = names.filter((entry) => entry.startsWith("."));
  const stored = names.filter((entry) => !entry.startsWith("."));
  for (const entry of stored) {
    expect(`${sha256Of(readFileSync(join(dir, entry)))}.ndjson.gz`).toBe(entry);
  }
  return { writing, stored };
}

function copyOf(instance: string, hash: string): string {
  const hex = hash.replace(/^sha256:/, "");
  return join(folder, "files", instance, hex.slice(0, 4), hex);
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

/** Every line an archive of everything carries, sorted. */
async function linesOf(server: FreshServer) {
  const minted = await ownerOf(server).createKey({
    label: "everything",
    source: `backup-folder-${String(Date.now())}`,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  const everything = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: minted.data.key,
  });
  const archive = await everything.exportArchive({
    state: "any",
    files: "false",
  });
  expect(archive.status).toBe(200);
  return Object.fromEntries(
    LINE_FILES.map((name) => [
      name,
      archiveLines(archive.data, name)
        .map((line) => JSON.stringify(canonical(line)))
        .sort(),
    ]),
  );
}

let made: {
  note: string;
  ledger: string;
  hash: string;
  bytes: Uint8Array;
};
let name: string;

describe("backups to a folder", () => {
  it("writes each backup as one manifest named for its created_at in the folder's backups folder for its instance, its parts named for their bytes, and a copy of each file it names in the folder's files area", async () => {
    const { working } = clientsFor(origin);
    const type = `user.folder_ledger_${String(Date.now())}`;
    const registered = await working.registerType({
      id: type,
      fields: { title: { type: "string" } },
      tables: { lines: { columns: { amount: { type: "number" } } } },
    } as never);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const ledger = await working.createItem({
      type,
      properties: { title: "a ledger" },
    } as never);
    expect(ledger.status, JSON.stringify(ledger.error)).toBe(201);
    const rows = await working.writeRows(ledger.data.item.id, "lines", {
      operations: [0, 1, 2].map((amount) => ({
        op: "put" as const,
        values: { amount },
      })),
    });
    expect(rows.status, JSON.stringify(rows.error)).toBe(200);
    const note = await working.createItem({
      type: "core.note",
      properties: { title: "kept in the folder" },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    // An edit, so the backup carries a version line.
    const edited = await working.updateItem(note.data.item.id, {
      version: note.data.item.version,
      properties: { title: "kept in the folder, edited" },
    });
    expect(edited.status, JSON.stringify(edited.error)).toBe(200);
    const bytes = bytesOf("a file the backup copies", 4096);
    const uploaded = await working.uploadBlob(bytes, "text/plain");
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    const file = await working.createItem({
      type: "core.file",
      properties: { blob_ref: uploaded.data.hash, mime_type: "text/plain" },
    });
    expect(file.status, JSON.stringify(file.error)).toBe(201);
    const edge = await working.createEdge({
      from_id: ledger.data.item.id,
      to_id: file.data.item.id,
      edge_type: "references",
    } as never);
    expect(edge.status, JSON.stringify(edge.error)).toBe(201);
    made = {
      note: note.data.item.id,
      ledger: ledger.data.item.id,
      hash: uploaded.data.hash,
      bytes,
    };

    const scheduled = readdirSync(join(folder, "backups", originId));
    expect(scheduled).toHaveLength(1);
    const run = await ownerOf(origin).runBackup();
    expect(run.status, JSON.stringify(run.error)).toBe(200);
    expect(run.data.outcome).toBe("put");
    name = run.data.backup.name;
    expect(name).toBe(backupName(new Date(run.data.backup.created_at)));
    expect(readdirSync(join(folder, "backups", originId)).sort()).toEqual(
      [...scheduled, name].sort(),
    );
    const stored = await backupInFolder(folder, originId, name);
    expect(storedSize(stored)).toBe(run.data.backup.size_bytes);
    expect(stored.manifest).toMatchObject({
      format: "marfa-backup",
      version: 1,
    });
    const parts = partsIn(folder, originId);
    expect(parts.writing).toEqual([]);
    expect(parts.stored).toEqual(
      expect.arrayContaining(stored.manifest.parts.map(partName)),
    );
    const archive = stored.archive;
    expect(listEntries(archive).map((entry) => entry.name)).toEqual([
      "manifest.json",
      "files.ndjson.gz",
      "instance.ndjson.gz",
      "items.ndjson.gz",
      "versions.ndjson.gz",
      "edges.ndjson.gz",
      "rows.ndjson.gz",
    ]);
    expect(Object.keys(notCarried(archive))).toContain(made.hash);
    expect(
      listEntries(archive).filter((entry) => entry.name.startsWith("blobs/")),
    ).toEqual([]);
    expect(new Uint8Array(readFileSync(copyOf(originId, made.hash)))).toEqual(
      bytes,
    );
  });

  it("lists the backup folder's files area as a store of kind folder at its path", async () => {
    const { operator } = clientsFor(origin);
    const stores = (await operator.listBlobStores()).data.data;
    const kept = stores.find((store) => store.kind === "folder");
    expect(kept?.locator).toBe(join(folder, "files", originId));
    expect(kept?.detached_at).toBeNull();
  });

  it("refuses to drop the folder's copy of a file a kept backup names", async () => {
    const { operator, working } = clientsFor(origin);
    const stores = (await operator.listBlobStores()).data.data;
    const kept = stores.find((store) => store.kind === "folder")!;
    const witness = await working.uploadBlob(
      bytesOf("a file no backup names", 4096),
      "text/plain",
    );
    expect(witness.status, JSON.stringify(witness.error)).toBe(201);
    const { result } = await runJob<{ remaining: number }>(
      operator,
      "blob-replicate",
    );
    expect(result.remaining).toBe(0);
    expect(existsSync(copyOf(originId, witness.data.hash))).toBe(true);
    const dropped = await operator.deleteBlobCopy(witness.data.hash, kept.id);
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    expect(existsSync(copyOf(originId, witness.data.hash))).toBe(false);

    const refused = await operator.deleteBlobCopy(made.hash, kept.id);
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(refused.error?.error.code).toBe("copy_held_by_backup");
    expect(existsSync(copyOf(originId, made.hash))).toBe(true);
  });

  it("says in health that backups go to a folder", async () => {
    const answer = await health(origin);
    expect(answer.backups.status).toBe("ok");
    expect(answer.backups.destination).toBe("folder");
  });

  it("restores a named backup into a fresh server on another data path from the folder alone, every line and file", async () => {
    const fresh = await bootFreshServer("backup-folder-fresh", FOLDER_ONLY);
    others.push(fresh);
    expect(fresh.stateDir).not.toBe(origin.stateDir);
    expect(await instanceIdOf(fresh)).not.toBe(originId);
    const listed = await ownerOf(fresh).listBackups();
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data.data).toContainEqual(
      expect.objectContaining({ name, instance_id: originId }),
    );
    const restored = await ownerOf(fresh).restoreBackup(originId, name);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([]);

    const [before, after] = [await linesOf(origin), await linesOf(fresh)];
    for (const file of LINE_FILES) {
      expect(before[file]!.length, file).toBeGreaterThan(0);
      expect(same(after[file], before[file]), file).toBe(true);
    }
    const { operator } = clientsFor(fresh);
    const read = await operator.downloadBlob(made.hash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(made.bytes);
  });

  it("refuses a restore with 409 backup_files_missing naming each file the folder does not hold, and restores nothing", async () => {
    const copy = copyOf(originId, made.hash);
    const kept = readFileSync(copy);
    rmSync(copy);
    try {
      const fresh = await bootFreshServer("backup-folder-lacking", FOLDER_ONLY);
      others.push(fresh);
      const refused = await ownerOf(fresh).restoreBackup(originId, name);
      expect(refused.status, JSON.stringify(refused.data)).toBe(409);
      expect(refused.error?.error.code).toBe("backup_files_missing");
      expect(refused.error?.error.details).toEqual({
        missing_blobs: [made.hash],
      });
      const { working } = clientsFor(fresh);
      expect((await working.getItem(made.note)).status).toBe(404);
    } finally {
      writeFileSync(copy, kept);
    }
  });

  it("counts a run while the folder is gone as failed, makes no folder, and puts the next backup once it is back", async () => {
    renameSync(folder, away);
    try {
      const run = await ownerOf(origin).runBackup();
      expect(run.status, JSON.stringify(run.data)).toBe(503);
      expect(run.error?.error.code).toBe("blob_store_unavailable");
      expect(existsSync(folder)).toBe(false);
      const answer = await health(origin);
      expect(answer.backups.status).toBe("failing");
      expect(answer.status).not.toBe("ok");
    } finally {
      renameSync(away, folder);
    }
    const run = await ownerOf(origin).runBackup();
    expect(run.status, JSON.stringify(run.error)).toBe(200);
    // The run the backup brought forward may have met the folder gone, so a run that ends whole
    // clears what it said.
    await replicateUntilCaughtUp(
      clientsFor(origin).operator,
      "replication to clear what the folder being gone said",
    );
    expect((await health(origin)).backups.status).toBe("ok");
  });

  it("leaves no file a listing reads as a backup when a run fails partway or its process ends, and clears what it left at the next run", async () => {
    const own = join(folder, "backups", originId);
    const owner = ownerOf(origin);
    const before = readdirSync(own).sort();
    const { working } = clientsFor(origin);
    const changed = await working.createItem({
      type: "core.note",
      properties: { title: "a change to back up" },
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(201);

    const partsBefore = partsIn(folder, originId).stored;

    await origin.setFault("fail:backup-folder-write");
    const full = await owner.runBackup();
    expect(full.status, JSON.stringify(full.data)).toBe(503);
    expect(full.error?.error.message).toMatch(/No space left on device/);
    expect(readdirSync(own).sort()).toEqual(before);
    expect(partsIn(folder, originId)).toEqual({
      writing: [],
      stored: partsBefore,
    });
    await origin.clearFault();

    await origin.setFault("hold:backup:put");
    void ownerOf(origin).runBackup();
    await origin.waitForHold("hold:backup:put");
    expect(readdirSync(own).sort()).toEqual(before);
    const held = partsIn(folder, originId);
    expect(held.writing).toHaveLength(1);
    expect(held.writing[0]).toMatch(/^\..*\.partial$/);
    await origin.restart({ signal: "SIGKILL" });
    expect(readdirSync(own).sort()).toEqual(before);
    expect(partsIn(folder, originId).writing).toEqual(held.writing);
    const listed = await ownerOf(origin).listBackups();
    expect(listed.data.data.map((backup) => backup.name).sort()).toEqual(
      before,
    );

    const next = await ownerOf(origin).runBackup();
    expect(next.status, JSON.stringify(next.error)).toBe(200);
    expect(readdirSync(own).sort()).toEqual(
      [...before, next.data.backup.name].sort(),
    );
    expect(partsIn(folder, originId).writing).toEqual([]);
  });
});

describe("a backup folder that lacks a file or its disk", () => {
  /** A server backing up to a folder of its own, stopped and removed after `body`. */
  async function withFolder(
    label: string,
    body: (server: FreshServer, root: string) => Promise<void>,
  ): Promise<void> {
    const root = tempFolder(`marfa-${label}-`);
    const server = await bootFreshServer(label, {
      ...FOLDER_ONLY,
      MARFA_BACKUP_PATH: root,
      MARFA_BACKUP_INTERVAL_SECONDS: YEAR_SECONDS,
    });
    try {
      await afterFirstScheduledBackup(server);
      await body(server, root);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }

  function copyIn(root: string, instance: string, hash: string): string {
    const hex = hash.replace(/^sha256:/, "");
    return join(root, "files", instance, hex.slice(0, 4), hex);
  }

  async function fileItem(server: FreshServer, bytes: Uint8Array) {
    const { working } = clientsFor(server);
    const uploaded = await working.uploadBlob(bytes, "text/plain");
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    const file = await working.createItem({
      type: "core.file",
      properties: { blob_ref: uploaded.data.hash, mime_type: "text/plain" },
    });
    expect(file.status, JSON.stringify(file.error)).toBe(201);
    return { hash: uploaded.data.hash, item: file.data.item.id };
  }

  it("puts a backup past a file no store can give, names it lost and in health, and a restore goes ahead without it", async () => {
    await withFolder("backup-folder-lost", async (server, root) => {
      const id = await instanceIdOf(server);
      await server.setFault("hold:housekeeping:blob-replicate");
      const lost = await fileItem(
        server,
        bytesOf("a file whose copy went", 4096),
      );
      const kept = await fileItem(server, bytesOf("a file still held", 4096));
      await server.setFault(`lose:blob=${lost.hash}`);
      const run = await ownerOf(server).runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      expect(run.data.blobs_lost).toEqual([lost.hash]);
      const { archive } = await backupInFolder(root, id, run.data.backup.name);
      expect(lostFiles(archive)).toEqual([lost.hash]);
      expect(existsSync(copyIn(root, id, kept.hash))).toBe(true);
      const answer = await health(server);
      expect(answer.backups.status).toBe("failing");
      expect(answer.backups.last_error).toContain(lost.hash);
      const told = await backupConcerns(server);
      expect(told.map((concern) => concern.reference)).toEqual(["run"]);
      expect(told[0]!.description).toContain(lost.hash);

      const fresh = await bootFreshServer("backup-folder-lost-fresh", {
        ...FOLDER_ONLY,
        MARFA_BACKUP_PATH: root,
      });
      try {
        const restored = await ownerOf(fresh).restoreBackup(
          id,
          run.data.backup.name,
        );
        expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        expect(restored.data.blobs_missing).toEqual([lost.hash]);
        const { working } = clientsFor(fresh);
        expect((await working.getItem(lost.item)).status).toBe(200);
      } finally {
        await fresh.stop();
      }

      await server.clearFault();
      const next = await ownerOf(server).runBackup();
      expect(next.status, JSON.stringify(next.error)).toBe(200);
      expect(next.data.blobs_lost).toEqual([]);
      expect((await health(server)).backups.status).toBe("ok");
      expect(await backupConcerns(server)).toEqual([]);
    });
  });

  it("says nothing in health or attention while the folder answers and no file waits for its copy", async () => {
    await withFolder("backup-folder-quiet", async (server) => {
      await fileItem(server, bytesOf("a file copied at once", 2048));
      await waitFor("the file's copy in the folder", async () => {
        const run = await runJob<{ remaining: number }>(
          clientsFor(server).operator,
          "blob-replicate",
        );
        return run.result.remaining === 0 ? true : undefined;
      });
      const detail = await healthDetail(server);
      expect(detail.status).toBe("ok");
      expect(detail.backups).toMatchObject({
        status: "ok",
        store_error: null,
        copies_waiting: 0,
        damaged_parts: 0,
      });
      expect(await attentionOf(server)).toEqual([]);
    });
  });

  it("leaves a file uncopied that would take the server's own volume below its reserve, says so in health by the setting's name, and copies it once there is room", async () => {
    await withFolder("backup-folder-reserve", async (server, root) => {
      const id = await instanceIdOf(server);
      const { operator } = clientsFor(server);
      await server.setFault("free:backups=2097152");
      const held = await fileItem(
        server,
        bytesOf("a file the folder has no room for", 2048),
      );
      const run = await runJob(operator, "blob-replicate", "failed");
      expect(run.result).toMatchObject({ copied: 0 });
      expect(existsSync(copyIn(root, id, held.hash))).toBe(false);
      const told = (await healthDetail(server)).backups.store_error;
      expect(told).toEqual(expect.stringContaining("has 2 MiB free"));
      expect(told).toEqual(expect.stringContaining("disk_reserve_bytes"));

      // The witness: the same file is copied once the folder's volume has room.
      await server.setFault("free:backups=1073741824");
      await waitFor("the file's copy in the folder", async () => {
        const caught = await runJob<{ remaining: number }>(
          operator,
          "blob-replicate",
        );
        return caught.result.remaining === 0 ? true : undefined;
      });
      expect(existsSync(copyIn(root, id, held.hash))).toBe(true);
    });
  });

  it("writes no archive that would take the server's own volume below its reserve, and writes it once there is room", async () => {
    await withFolder("backup-folder-archive-reserve", async (server, root) => {
      const own = join(root, "backups", await instanceIdOf(server));
      const before = readdirSync(own);
      await server.setFault("free:backups=2097152");
      const refused = await ownerOf(server).runBackup();
      expect(refused.status).toBe(503);
      expect(JSON.stringify(refused.error)).toContain("disk_reserve_bytes");
      expect(JSON.stringify(refused.error)).toContain("has 2 MiB free");
      expect(readdirSync(own)).toEqual(before);

      // The witness: the same run is written once the folder's volume has room.
      await server.setFault("free:backups=1073741824");
      const written = await ownerOf(server).runBackup();
      expect(written.status, JSON.stringify(written.error)).toBe(200);
      expect(readdirSync(own).sort()).toEqual(
        [...before, written.data.backup.name].sort(),
      );
    });
  });

  // The claim is a latency bound: a pass on the second try would pass a slow answer.
  it(
    "says at once in health and attention that the folder's disk is not there, with the files that wait, and clears once it is back and replication has caught up",
    { retry: 0 },
    async () => {
      await withFolder("backup-folder-away", async (server, root) => {
        const { operator } = clientsFor(server);
        const gone = `${root}-gone`;
        renameSync(root, gone);
        try {
          const before = Date.now();
          const detail = await healthDetail(server);
          expect(Date.now() - before).toBeLessThan(2500);
          expect(detail.status).not.toBe("ok");
          expect(detail.backups.status).toBe("failing");
          expect(detail.backups.store_error).toEqual(
            expect.stringContaining("is not there"),
          );
          const told = await backupConcerns(server);
          expect(told.map((concern) => concern.reference)).toEqual(["store"]);
          expect(told[0]!.title).toBe("The backup folder is not there");

          // A run of the backup that fails for the same folder is told once, as the folder's.
          const failed = await ownerOf(server).runBackup();
          expect(failed.status, JSON.stringify(failed.data)).toBe(503);
          const together = await backupConcerns(server);
          expect(together.map((concern) => concern.reference)).toEqual([
            "store",
          ]);
          expect(together[0]!.description).toContain(
            "The last backup run failed too.",
          );

          await fileItem(server, bytesOf("a file waiting for its copy", 2048));
          const run = await runJob(operator, "blob-replicate", "failed");
          expect(run.result).toMatchObject({ copied: 0, remaining: 1 });
          const waiting = await healthDetail(server);
          expect(waiting.backups.copies_waiting).toBe(1);
          const concerns = await attentionOf(server);
          const store = concerns.find(
            (concern) => concern.reference === "store",
          );
          expect(store?.description).toContain(
            "1 file waits for its second copy",
          );
          // The failed run is told once, as the folder's concern.
          expect(concerns.some((concern) => concern.kind === "job")).toBe(
            false,
          );
        } finally {
          renameSync(gone, root);
        }
        await replicateUntilCaughtUp(operator, "replication to catch up");
        const caught = await runJob(operator, "blob-replicate");
        expect(caught.result).toMatchObject({ remaining: 0 });
        // The folder answers again, so the failed run stands on its own until one is put.
        expect(
          (await backupConcerns(server)).map((concern) => concern.reference),
        ).toEqual(["run"]);
        const put = await ownerOf(server).runBackup();
        expect(put.status, JSON.stringify(put.error)).toBe(200);
        const detail = await healthDetail(server);
        expect(detail.status).toBe("ok");
        expect(detail.backups).toMatchObject({
          status: "ok",
          store_error: null,
          copies_waiting: 0,
        });
        expect(await attentionOf(server)).toEqual([]);
      });
    },
  );

  // The claim is a latency bound: a pass on the second try would pass a slow answer.
  it(
    "answers health within three seconds and says the folder is not answering while a look at its mount hangs",
    { retry: 0 },
    async () => {
      await withFolder("backup-folder-hung", async (server) => {
        await server.setFault("hold:disk-probe");
        try {
          const before = Date.now();
          const detail = await healthDetail(server);
          expect(Date.now() - before).toBeLessThan(3000);
          expect(detail.backups.status).toBe("failing");
          expect(detail.backups.store_error).toEqual(
            expect.stringContaining("did not answer in time"),
          );
          const told = await backupConcerns(server);
          expect(told.map((concern) => concern.reference)).toEqual(["store"]);
          expect(told[0]!.title).toBe("The backup folder is not answering");
        } finally {
          await server.clearFault();
        }
        // The witness: once the mount answers, the same folder is quiet.
        await waitFor("the folder to be told as answering", async () =>
          (await healthDetail(server)).backups.store_error === null
            ? true
            : undefined,
        );
        expect(await attentionOf(server)).toEqual([]);
      });
    },
  );

  it("lists in attention a backup run by hand that failed, until a later one is put", async () => {
    await withFolder("backup-folder-hand", async (server, root) => {
      const gone = `${root}-gone`;
      renameSync(root, gone);
      try {
        const run = await ownerOf(server).runBackup();
        expect(run.status, JSON.stringify(run.data)).toBe(503);
        // While the folder is gone, the failed run and the folder are one fault.
        expect(
          (await attentionOf(server)).map((concern) => concern.reference),
        ).toEqual(["store"]);
      } finally {
        renameSync(gone, root);
      }
      // Once the folder answers, the failed run stands on its own.
      expect(
        (await attentionOf(server)).map((concern) => concern.reference),
      ).toEqual(["run"]);
      const run = await ownerOf(server).runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      expect(await attentionOf(server)).toEqual([]);
    });
  });

  it("says a backup run by hand that failed as failing in health while scheduled backups are turned off, and off once one is put", async () => {
    const root = tempFolder("marfa-backup-folder-off-");
    const server = await bootFreshServer("backup-folder-off", {
      ...FOLDER_ONLY,
      MARFA_BACKUP_PATH: root,
    });
    try {
      const told = async () =>
        (await attentionOf(server))
          .filter((concern) => concern.kind === "backup")
          .map((concern) => concern.reference);
      // The witness: with nothing failing, an interval of 0 is off.
      expect((await healthDetail(server)).backups).toMatchObject({
        status: "off",
        reason: "turned_off",
      });
      await server.setFault("fail:backup-folder-write");
      try {
        const run = await ownerOf(server).runBackup();
        expect(run.status, JSON.stringify(run.data)).toBe(503);
      } finally {
        await server.clearFault();
      }
      const detail = await healthDetail(server);
      expect(detail.status).toBe("degraded");
      expect(detail.backups).toMatchObject({
        status: "failing",
        reason: "turned_off",
        failures: 1,
      });
      expect(await told()).toEqual(["turned_off", "run"]);
      const run = await ownerOf(server).runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      expect((await healthDetail(server)).backups).toMatchObject({
        status: "off",
        reason: "turned_off",
      });
      expect(await told()).toEqual(["turned_off"]);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says a backup folder that takes no copies as failing in health while scheduled backups are turned off, and off once it takes them", async () => {
    const root = tempFolder("marfa-backup-folder-off-away-");
    const server = await bootFreshServer("backup-folder-off-away", {
      ...FOLDER_ONLY,
      MARFA_BACKUP_PATH: root,
    });
    const gone = `${root}-gone`;
    try {
      // The witness: with the folder there and nothing failing, an interval of 0 is off.
      expect((await healthDetail(server)).backups).toMatchObject({
        status: "off",
        reason: "turned_off",
        store_error: null,
      });
      renameSync(root, gone);
      try {
        const detail = await healthDetail(server);
        expect(detail.status).toBe("degraded");
        expect(detail.backups).toMatchObject({
          status: "failing",
          reason: "turned_off",
          failures: 0,
        });
        expect(detail.backups.store_error).toEqual(
          expect.stringContaining("is not there"),
        );
      } finally {
        renameSync(gone, root);
      }
      expect((await healthDetail(server)).backups).toMatchObject({
        status: "off",
        reason: "turned_off",
        store_error: null,
      });
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
      rmSync(gone, { recursive: true, force: true });
    }
  });

  it("refuses a restore that lacks a file before it reads any file from the folder", async () => {
    await withFolder("backup-folder-first", async (server, root) => {
      const id = await instanceIdOf(server);
      const gone = await fileItem(
        server,
        bytesOf("a copy someone deleted", 4096),
      );
      const other = await fileItem(server, bytesOf("a copy still there", 4096));
      const run = await ownerOf(server).runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      rmSync(copyIn(root, id, gone.hash));

      const fresh = await bootFreshServer("backup-folder-first-fresh", {
        ...FOLDER_ONLY,
        MARFA_BACKUP_PATH: root,
      });
      try {
        const refused = await ownerOf(fresh).restoreBackup(
          id,
          run.data.backup.name,
        );
        expect(refused.status, JSON.stringify(refused.data)).toBe(409);
        expect(refused.error?.error.details).toEqual({
          missing_blobs: [gone.hash],
        });
        const hex = other.hash.replace(/^sha256:/, "");
        const blobs = join(fresh.stateDir, "blobs");
        expect(existsSync(join(blobs, hex.slice(0, 4), hex))).toBe(false);
        expect(readdirSync(join(blobs, "tmp"))).toEqual([]);
      } finally {
        await fresh.stop();
      }
    });
  });

  it("refuses a restore that meets a copy altered to the same size, names it, and places no file", async () => {
    await withFolder("backup-folder-altered", async (server, root) => {
      const id = await instanceIdOf(server);
      const altered = await fileItem(
        server,
        bytesOf("a copy someone changed", 4096),
      );
      const other = await fileItem(server, bytesOf("a copy still whole", 4096));
      const run = await ownerOf(server).runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      const copy = copyIn(root, id, altered.hash);
      const bytes = readFileSync(copy);
      bytes[0] = bytes[0]! ^ 0xff;
      writeFileSync(copy, bytes);

      const fresh = await bootFreshServer("backup-folder-altered-fresh", {
        ...FOLDER_ONLY,
        MARFA_BACKUP_PATH: root,
      });
      try {
        const refused = await ownerOf(fresh).restoreBackup(
          id,
          run.data.backup.name,
        );
        expect(refused.status, JSON.stringify(refused.data)).toBe(409);
        expect(refused.error?.error.code).toBe("backup_files_missing");
        expect(refused.error?.error.details).toEqual({
          missing_blobs: [altered.hash],
        });
        expect(existsSync(copyIn(root, id, other.hash))).toBe(true);
        for (const hash of [altered.hash, other.hash]) {
          expect(await diskHolds(fresh.controlSocket, hash)).toBe(false);
        }
        await waitFor("the restore's spool to empty", async () =>
          (await inspectStores(fresh.controlSocket)).spool.length === 0
            ? true
            : undefined,
        );
        const { working } = clientsFor(fresh);
        expect((await working.getItem(other.item)).status).toBe(404);
      } finally {
        await fresh.stop();
      }
    });
  });

  it("restores a backup over the instance that took it with room for none of the files it already holds", async () => {
    await withFolder("backup-folder-rollback", async (server) => {
      const id = await instanceIdOf(server);
      const { operator } = clientsFor(server);
      const reserve = await ownerOf(server).patchConfig({
        disk_reserve_bytes: 100_000,
      });
      expect(reserve.status, JSON.stringify(reserve.error)).toBe(200);
      const bytes = bytesOf("a file already on the disk", 1_000_000);
      const held = await fileItem(server, bytes);
      const run = await ownerOf(server).runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);

      await server.setFault("free:blobs=300000");
      const restored = await ownerOf(server).restoreBackup(
        id,
        run.data.backup.name,
      );
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.blobs_missing).toEqual([]);
      const read = await operator.downloadBlob(held.hash);
      expect(read.status).toBe(200);
      expect(new Uint8Array(read.data)).toEqual(bytes);
    });
  });

  it("refuses to back up into a files folder that lost its marker, names the adopt command, and adopts it afresh, changing no other store", async () => {
    const parent = tempFolder("marfa-backup-folder-adopt-");
    const root = join(parent, "disk");
    const replaced = join(parent, "old disk");
    mkdirSync(root);
    const server = await bootFreshServer("backup-folder-adopt", {
      ...FOLDER_ONLY,
      MARFA_BACKUP_PATH: root,
      MARFA_BACKUP_INTERVAL_SECONDS: YEAR_SECONDS,
    });
    try {
      await afterFirstScheduledBackup(server);
      const id = await instanceIdOf(server);
      const owner = ownerOf(server);
      const { operator } = clientsFor(server);
      const bytes = bytesOf("a file the old disk held", 4096);
      const file = await fileItem(server, bytes);
      expect((await owner.runBackup()).status).toBe(200);
      const before = (await operator.listBlobStores()).data.data;
      const old = before.find((store) => store.kind === "folder")!;
      const disk = before.find((store) => store.kind === "disk")!;

      const held = await owner.adoptBackupFolder();
      expect(held.status, JSON.stringify(held.data)).toBe(409);
      expect(held.error?.error.code).toBe("conflict");

      renameSync(root, replaced);
      const missing = await owner.adoptBackupFolder();
      expect(missing.status, JSON.stringify(missing.data)).toBe(503);
      expect(missing.error?.error.code).toBe("blob_store_unavailable");
      expect(existsSync(root)).toBe(false);

      mkdirSync(root);
      const refused = await owner.runBackup();
      expect(refused.status, JSON.stringify(refused.data)).toBe(503);
      expect(refused.error?.error.message).toContain(
        "marfa backups folder adopt",
      );
      expect(readdirSync(root)).toEqual([]);
      const failing = await health(server);
      expect(failing.backups.last_error).toContain(
        "marfa backups folder adopt",
      );

      const adopted = await owner.adoptBackupFolder();
      expect(adopted.status, JSON.stringify(adopted.error)).toBe(200);
      await expectMatchesSchema(
        "POST",
        "/backups/folder/adopt",
        200,
        adopted.data,
      );
      expect(adopted.data.replaced_store_id).toBe(old.id);
      expect(adopted.data.backups_forgotten).toBeGreaterThan(0);
      expect(adopted.data.store_id).not.toBe(old.id);
      const after = (await operator.listBlobStores()).data.data;
      const now = after.find((store) => store.id === adopted.data.store_id)!;
      expect(now.kind).toBe("folder");
      expect(now.locator).toBe(join(root, "files", id));
      expect(now.detached_at).toBeNull();
      expect(
        after.find((store) => store.id === old.id)?.detached_at,
      ).not.toBeNull();
      const copies = await operator.listBlobCopies(file.hash);
      expect(copies.status, JSON.stringify(copies.error)).toBe(200);
      const holders = copies.data.data.map((copy) => copy.store_id);
      expect(holders).toContain(disk.id);
      expect(holders).not.toContain(old.id);

      const next = await owner.runBackup();
      expect(next.status, JSON.stringify(next.error)).toBe(200);
      expect(new Uint8Array(readFileSync(copyIn(root, id, file.hash)))).toEqual(
        bytes,
      );
      expect((await health(server)).backups.status).toBe("ok");
      const read = await operator.downloadBlob(file.hash);
      expect(new Uint8Array(read.data)).toEqual(bytes);
    } finally {
      await server.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses to adopt a files folder that holds another store's marker, and leaves the marker as it is", async () => {
    await withFolder("backup-folder-adopt-foreign", async (server, root) => {
      const id = await instanceIdOf(server);
      const marker = join(root, "files", id, ".marfa-store");
      const before = readFileSync(marker, "utf8");
      const foreign = randomUUID();
      expect(foreign).not.toBe(before.trim());
      writeFileSync(marker, foreign);

      const refused = await ownerOf(server).adoptBackupFolder();
      expect(refused.status, JSON.stringify(refused.data)).toBe(409);
      expect(refused.error?.error.code).toBe("conflict");
      expect(refused.error?.error.message).toContain(foreign);
      expect(readFileSync(marker, "utf8")).toBe(foreign);
      writeFileSync(marker, before);
    });
  });

  it("refuses a key without backups.manage at the adopt door", async () => {
    await withFolder("backup-folder-adopt-key", async (server) => {
      const refused = await clientsFor(server).working.adoptBackupFolder();
      expect(refused.status, JSON.stringify(refused.data)).toBe(403);
      expect(refused.error?.error.details).toEqual({
        required_scope: "backups.manage",
      });
    });
  });

  /** The stores `GET /blobs/stores` lists, by id, with whether each is detached. */
  async function storesOf(server: FreshServer) {
    const listed = await clientsFor(server).operator.listBlobStores();
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    return listed.data.data.map((store) => ({
      id: store.id,
      kind: store.kind,
      locator: store.locator,
      detached: store.detached_at !== null,
    }));
  }

  const referencesOf = async (server: FreshServer) =>
    (await backupConcerns(server)).map((concern) => concern.reference);

  async function replicated(server: FreshServer) {
    await waitFor("every file's copy in the folder", async () => {
      const run = await runJob<{ remaining: number }>(
        clientsFor(server).operator,
        "blob-replicate",
      );
      return run.result.remaining === 0 ? true : undefined;
    });
  }

  it("forgets nothing when it cannot record an adopt, and adopts on the next try", async () => {
    await withFolder("backup-folder-adopt-unrecorded", async (server, root) => {
      const id = await instanceIdOf(server);
      const owner = ownerOf(server);
      const made = await owner.runBackup();
      expect(made.status, JSON.stringify(made.error)).toBe(200);
      const listed = await owner.listBackups();
      expect(listed.status, JSON.stringify(listed.error)).toBe(200);
      const backups = listed.data.data;
      expect(backups.length).toBeGreaterThan(0);
      renameSync(join(root, "files", id), join(root, "old files"));
      const stores = await storesOf(server);

      await server.setFault("fail:stores-record");
      const refused = await owner.adoptBackupFolder();
      await server.clearFault("fail:stores-record");
      expect(refused.status, JSON.stringify(refused.data)).not.toBe(200);
      expect(refused.error?.error.message).not.toContain("forgotten");
      expect(await storesOf(server)).toEqual(stores);

      // The adopt that succeeds forgets every backup, so the failed one forgot none.
      const adopted = await owner.adoptBackupFolder();
      expect(adopted.status, JSON.stringify(adopted.error)).toBe(200);
      expect(adopted.data.backups_forgotten).toBe(backups.length);
    });
  });

  it("gives the files folder the store an adopt recorded when the server ended before the folder took its marker", async () => {
    await withFolder("backup-folder-adopt-ended", async (server, root) => {
      const id = await instanceIdOf(server);
      const area = join(root, "files", id);
      const old = (await storesOf(server)).find(
        (store) => store.kind === "folder",
      )!;
      renameSync(area, join(root, "old files"));

      await server.setFault("hold:folder-marker");
      const adopting = ownerOf(server).adoptBackupFolder();
      await server.waitForHold("hold:folder-marker");
      await server.restart({ signal: "SIGKILL" });
      await adopting.catch(() => undefined);

      const recorded = (await storesOf(server)).filter(
        (store) => store.locator === area && !store.detached,
      );
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.id).not.toBe(old.id);
      expect(readFileSync(join(area, ".marfa-store"), "utf8").trim()).toBe(
        recorded[0]!.id,
      );
      const next = await ownerOf(server).runBackup();
      expect(next.status, JSON.stringify(next.error)).toBe(200);
    });
  });

  it("gives the files folder the store an adopt recorded once its disk is back, when the server ended before the folder took its marker and started without it", async () => {
    await withFolder("backup-folder-adopt-ended-away", async (server, root) => {
      const id = await instanceIdOf(server);
      const area = join(root, "files", id);
      const away = join(root, "away");
      renameSync(area, join(root, "old files"));

      await server.setFault("hold:folder-marker");
      const adopting = ownerOf(server).adoptBackupFolder();
      await server.waitForHold("hold:folder-marker");
      await server.restart({
        signal: "SIGKILL",
        whileStopped: () => renameSync(area, away),
      });
      await adopting.catch(() => undefined);

      const recorded = (await storesOf(server)).filter(
        (store) => store.locator === area && !store.detached,
      );
      expect(recorded).toHaveLength(1);
      const waiting = await ownerOf(server).runBackup();
      expect(waiting.status).toBe(503);
      expect(existsSync(join(away, ".marfa-store"))).toBe(false);
      expect(
        readFileSync(join(away, ".marfa-store.pending"), "utf8").trim(),
      ).toBe(recorded[0]!.id);

      renameSync(away, area);
      const next = await ownerOf(server).runBackup();
      expect(next.status, JSON.stringify(next.error)).toBe(200);
      expect(readFileSync(join(area, ".marfa-store"), "utf8").trim()).toBe(
        recorded[0]!.id,
      );
      expect(existsSync(join(area, ".marfa-store.pending"))).toBe(false);
    });
  });

  it("says in health and attention that another server holds the folder, not that it is not there, while an adopt's claim waits on its lock, and clears once that server lets go", async () => {
    await withFolder("backup-folder-adopt-held", async (server, root) => {
      const id = await instanceIdOf(server);
      const area = join(root, "files", id);
      const away = join(root, "away");
      renameSync(area, join(root, "old files"));

      await server.setFault("hold:folder-marker");
      const adopting = ownerOf(server).adoptBackupFolder();
      await server.waitForHold("hold:folder-marker");
      await server.restart({
        signal: "SIGKILL",
        whileStopped: () => renameSync(area, away),
      });
      await adopting.catch(() => undefined);
      renameSync(away, area);
      expect(existsSync(join(area, ".marfa-store"))).toBe(false);

      const other = await lockHeldOn(area);
      try {
        const said = (await health(server)).backups.store_error as string;
        expect(said).toContain("open in another Marfa server");
        expect(said).not.toContain("is not there");
        const store = (await backupConcerns(server)).find(
          (concern) => concern.reference === "store",
        );
        expect(store?.title).toBe(
          "The backup folder is open in another Marfa server",
        );
        expect(store?.description).toContain("open in another Marfa server");
        expect(existsSync(join(area, ".marfa-store"))).toBe(false);
      } finally {
        await other.release();
      }

      expect((await health(server)).backups.store_error).toBeNull();
      expect(await referencesOf(server)).not.toContain("store");
      expect(readFileSync(join(area, ".marfa-store"), "utf8").trim()).not.toBe(
        "",
      );
    });
  });

  it("lists in attention a files folder put in place of the one the server took, copies no file into it, and copies again once that folder is back", async () => {
    await withFolder("backup-folder-replaced", async (server, root) => {
      const id = await instanceIdOf(server);
      const area = join(root, "files", id);
      const moved = join(root, "moved files");
      expect(await referencesOf(server)).not.toContain("folder_lock_lost");

      renameSync(area, moved);
      mkdirSync(area);
      writeFileSync(
        join(area, ".marfa-store"),
        readFileSync(join(moved, ".marfa-store")),
      );
      const held = await fileItem(
        server,
        bytesOf("a file sent while another folder is in its place", 2048),
      );
      const refused = await runJob(
        clientsFor(server).operator,
        "blob-replicate",
        "failed",
      );
      expect(refused.error).toContain("is not the one the server took");
      expect(readdirSync(area)).toEqual([".marfa-store"]);
      expect(await referencesOf(server)).toContain("folder_lock_lost");

      rmSync(area, { recursive: true });
      renameSync(moved, area);
      await replicated(server);
      expect(existsSync(copyIn(root, id, held.hash))).toBe(true);
      expect(await referencesOf(server)).not.toContain("folder_lock_lost");
    });
  });

  it("makes a removed lock file in the files folder again and says so in attention", async () => {
    await withFolder("backup-folder-lock-file", async (server, root) => {
      const id = await instanceIdOf(server);
      const lock = join(root, "files", id, ".server-lock");
      expect(existsSync(lock)).toBe(true);
      expect(await referencesOf(server)).not.toContain("folder_lock_restored");

      rmSync(lock);
      const held = await fileItem(
        server,
        bytesOf("a file copied after the lock file went", 2048),
      );
      await replicated(server);
      expect(existsSync(copyIn(root, id, held.hash))).toBe(true);
      expect(existsSync(lock)).toBe(true);
      expect(await referencesOf(server)).toContain("folder_lock_restored");
    });
  });
});

describe("where backups may go", () => {
  const DISK = {
    MARFA_OBJECT_STORE_BUCKET: "",
    MARFA_BACKUP_INTERVAL_SECONDS: "0",
  };

  /** The `errors` a `400 validation_error` names, by path. */
  function refusedPaths(answer: { status: number; error?: unknown }) {
    expect(answer.status, JSON.stringify(answer.error)).toBe(400);
    const error = (
      answer.error as {
        error: {
          code: string;
          details?: { errors?: { path: string; message: string }[] };
        };
      }
    ).error;
    expect(error.code).toBe("validation_error");
    return error.details?.errors ?? [];
  }

  it("refuses a write to /config that would set both object_store_bucket and backup_path, and keeps what was stored", async () => {
    const server = await bootFreshServer("backup-folder-both", DISK);
    try {
      const { operator, local } = clientsFor(server);
      const taken = await local.patchConfig({ backup_path: folder });
      expect(taken.status, JSON.stringify(taken.error)).toBe(200);

      const errors = refusedPaths(
        await local.patchConfig({ object_store_bucket: "a-bucket" }),
      );
      expect(errors.map((error) => error.path)).toEqual([
        "object_store_bucket",
      ]);
      expect(errors[0]!.message).toContain("backup_path");

      const held = (await operator.getConfig()).data as Record<string, unknown>;
      expect(held.backup_path).toBe(folder);
      expect(held).not.toHaveProperty("object_store_bucket");
    } finally {
      await server.stop();
    }
  });

  it("refuses a backup folder inside its data directory or its blob folder, judged where links lead, and makes none", async () => {
    const blobs = tempFolder("marfa-backup-blobs-");
    const server = await bootFreshServer("backup-folder-inside", {
      ...DISK,
      MARFA_BLOB_PATH: blobs,
    });
    const outside = tempFolder("marfa-backup-outside-");
    try {
      const { operator, local } = clientsFor(server);
      const data = dirname(server.sqlitePath);
      const linked = join(outside, "into-the-blobs");
      symlinkSync(blobs, linked);
      for (const [path, says] of [
        [join(blobs, "backups"), "inside the blob folder"],
        [join(data, "backups"), "inside the data directory"],
        [join(linked, "backups"), "inside the blob folder"],
      ] as const) {
        const errors = refusedPaths(
          await local.patchConfig({ backup_path: path }),
        );
        expect(
          errors.map((error) => error.path),
          path,
        ).toEqual(["backup_path"]);
        expect(errors[0]!.message, path).toContain(says);
        expect(existsSync(path), path).toBe(false);
      }
      expect(await operator.getConfig()).toMatchObject({
        data: expect.not.objectContaining({ backup_path: expect.anything() }),
      });

      // The witness: a folder outside both is taken.
      const taken = await local.patchConfig({ backup_path: `${outside}/` });
      expect(taken.status, JSON.stringify(taken.error)).toBe(200);
      expect((taken.data as Record<string, unknown>).backup_path).toBe(outside);
    } finally {
      await server.stop();
      rmSync(outside, { recursive: true, force: true });
      rmSync(blobs, { recursive: true, force: true });
    }
  });

  it("reports a backup folder that does not exist as unusable, keeps serving files, makes none, and takes it once it exists", async () => {
    const server = await bootFreshServer("backup-folder-missing", DISK);
    const parent = tempFolder("marfa-backup-later-");
    const missing = join(parent, "not mounted");
    try {
      const { operator, working, local } = clientsFor(server);
      const owner = ownerOf(server);
      const set = await local.patchConfig({ backup_path: missing });
      expect(set.status, JSON.stringify(set.error)).toBe(200);

      const unusable = await waitFor(
        "the folder to be reported unusable",
        async () => {
          const backups = (await health(server)).backups;
          return backups.reason === "destination_unusable"
            ? backups
            : undefined;
        },
      );
      expect(unusable.status).toBe("failing");
      expect(String(unusable.store_error)).toContain("does not exist");
      const concerns = (await attentionOf(server)).filter(
        (concern) => concern.kind === "backup" && concern.reference === "store",
      );
      expect(concerns.map((concern) => concern.title)).toEqual([
        "The backup destination cannot be used",
      ]);

      const bytes = bytesOf("kept on the disk", 64);
      const upload = await working.uploadBlob(bytes, "text/plain");
      expect(upload.status, JSON.stringify(upload.error)).toBe(201);
      const read = await operator.downloadBlob(upload.data.hash);
      expect(new Uint8Array(read.data)).toEqual(bytes);
      expect(existsSync(missing)).toBe(false);

      mkdirSync(missing);
      const run = await owner.runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      const id = await instanceIdOf(server);
      expect(
        readdirSync(join(missing, "backups", id)).filter((name) =>
          name.endsWith(".json"),
        ),
      ).toHaveLength(1);
      expect((await health(server)).backups.reason).not.toBe(
        "destination_unusable",
      );
    } finally {
      await server.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
