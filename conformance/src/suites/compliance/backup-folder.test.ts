import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  archiveLines,
  archiveManifest,
  listEntries,
  type LineFile,
} from "../../utils/archive.js";
import {
  afterFirstScheduledBackup,
  instanceIdOf,
  ownerOf,
} from "../../utils/backups.js";
import { same } from "../../utils/drill.js";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { bytesOf, clientsFor, runJob } from "../../utils/own-blob-server.js";

/**
 * Backups to a folder the owner names with `MARFA_BACKUP_PATH`: one file per
 * backup under `backups/<instance id>/`, a copy of each file a backup names
 * under `files/<instance id>/`, and a restore from the folder alone into a
 * fresh server on another data path.
 */
const LINE_FILES: readonly LineFile[] = ["instance", "items", "edges", "rows"];
const folder = mkdtempSync(join(tmpdir(), "marfa-backup-folder-"));
const away = `${folder}-away`;
const FOLDER_ONLY = {
  S3_BUCKET: "",
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

async function health(server: FreshServer) {
  const answer = await clientsFor(server).operator.rawRequest<{
    status: string;
    backups: Record<string, unknown>;
  }>("/health");
  expect(answer.status, JSON.stringify(answer.data)).toBe(200);
  return answer.data;
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
  it("writes each backup as one file named for its created_at in the folder's backups folder for its instance, and a copy of each file it names in the folder's files area", async () => {
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
    const bytes = bytesOf("a file the backup copies", 4096);
    const uploaded = await working.uploadBlob(bytes, "text/plain");
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    const file = await working.createItem({
      type: "core.file",
      properties: { blob_ref: uploaded.data.hash, mime_type: "text/plain" },
    });
    expect(file.status, JSON.stringify(file.error)).toBe(201);
    const edge = await working.createEdge({
      source_id: ledger.data.item.id,
      target_id: file.data.item.id,
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
    expect(name).toBe(`${run.data.backup.created_at}.tar`);
    expect(readdirSync(join(folder, "backups", originId)).sort()).toEqual(
      [...scheduled, name].sort(),
    );
    const archive = new Uint8Array(
      readFileSync(join(folder, "backups", originId, name)),
    );
    const manifest = archiveManifest<{
      missing_blobs: Record<string, unknown>;
    }>(archive);
    expect(Object.keys(manifest.missing_blobs)).toContain(made.hash);
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

    await origin.setFault("fail:backup-folder-write");
    const full = await owner.runBackup();
    expect(full.status, JSON.stringify(full.data)).toBe(503);
    expect(full.error?.error.message).toMatch(/No space left on device/);
    expect(readdirSync(own).sort()).toEqual(before);
    await origin.clearFault();

    await origin.setFault("hold:backup:put");
    void ownerOf(origin).runBackup();
    await origin.waitForHold("hold:backup:put");
    const writing = readdirSync(own).filter((entry) => !before.includes(entry));
    expect(writing).toHaveLength(1);
    expect(writing[0]).toMatch(/^\..*\.partial$/);
    await origin.restart({ signal: "SIGKILL" });
    expect(readdirSync(own).sort()).toEqual([...before, ...writing].sort());
    const listed = await ownerOf(origin).listBackups();
    expect(listed.data.data.map((backup) => backup.name).sort()).toEqual(
      before,
    );

    const next = await ownerOf(origin).runBackup();
    expect(next.status, JSON.stringify(next.error)).toBe(200);
    expect(readdirSync(own).sort()).toEqual(
      [...before, next.data.backup.name].sort(),
    );
  });
});

describe("a backup folder that lacks a file or its disk", () => {
  /** A server backing up to a folder of its own, stopped and removed after `body`. */
  async function withFolder(
    label: string,
    body: (server: FreshServer, root: string) => Promise<void>,
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), `marfa-${label}-`));
    const server = await bootFreshServer(label, {
      ...FOLDER_ONLY,
      MARFA_BACKUP_PATH: root,
    });
    try {
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

  it("puts a backup past a file no store can give, names it in lost_blobs and in health, and a restore goes ahead without it", async () => {
    await withFolder("backup-folder-lost", async (server, root) => {
      const id = await instanceIdOf(server);
      const lost = await fileItem(
        server,
        bytesOf("a file whose copy went", 4096),
      );
      const kept = await fileItem(server, bytesOf("a file still held", 4096));
      await server.setFault(`lose:blob=${lost.hash}`);
      const run = await ownerOf(server).runBackup();
      expect(run.status, JSON.stringify(run.error)).toBe(200);
      expect(run.data.blobs_lost).toEqual([lost.hash]);
      const archive = new Uint8Array(
        readFileSync(join(root, "backups", id, run.data.backup.name)),
      );
      const manifest = archiveManifest<{ lost_blobs: string[] }>(archive);
      expect(manifest.lost_blobs).toEqual([lost.hash]);
      expect(existsSync(copyIn(root, id, kept.hash))).toBe(true);
      const answer = await health(server);
      expect(answer.backups.status).toBe("failing");
      expect(answer.backups.last_error).toContain(lost.hash);

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
    });
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
    const parent = mkdtempSync(join(tmpdir(), "marfa-backup-folder-adopt-"));
    const root = join(parent, "disk");
    const replaced = join(parent, "old disk");
    mkdirSync(root);
    const server = await bootFreshServer("backup-folder-adopt", {
      ...FOLDER_ONLY,
      MARFA_BACKUP_PATH: root,
    });
    try {
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
      expect(copies.data.data.map((copy) => copy.store_id)).toEqual([disk.id]);

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

  it("refuses a key at the adopt door", async () => {
    await withFolder("backup-folder-adopt-key", async (server) => {
      const refused = await clientsFor(server).operator.adoptBackupFolder();
      expect(refused.status, JSON.stringify(refused.data)).toBe(403);
      expect(refused.error?.error.details).toEqual({ needs: "local" });
    });
  });
});

describe("where backups may go", () => {
  it("refuses to start with both S3_BUCKET and MARFA_BACKUP_PATH set", async () => {
    const refused = await bootRefused("backup-folder-both", {
      extraEnv: { S3_BUCKET: "a-bucket", MARFA_BACKUP_PATH: folder },
    });
    try {
      expect(refused.code).toBe(1);
      expect(refused.output).toMatch(
        /S3_BUCKET and MARFA_BACKUP_PATH are both set/,
      );
    } finally {
      await refused.stop();
    }
  });

  it("refuses to start with a backup folder inside its blob folder, or one that does not exist, and makes none", async () => {
    const blobs = mkdtempSync(join(tmpdir(), "marfa-backup-blobs-"));
    const missing = join(folder, "not mounted");
    try {
      for (const [path, says] of [
        [join(blobs, "backups"), /inside the blob folder/],
        [missing, /does not exist/],
      ] as const) {
        const refused = await bootRefused("backup-folder-refused", {
          extraEnv: {
            S3_BUCKET: "",
            MARFA_BLOB_PATH: blobs,
            MARFA_BACKUP_PATH: path,
          },
        });
        try {
          expect(refused.code).toBe(1);
          expect(refused.output).toMatch(says);
        } finally {
          await refused.stop();
        }
      }
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(blobs, { recursive: true, force: true });
    }
  });
});
