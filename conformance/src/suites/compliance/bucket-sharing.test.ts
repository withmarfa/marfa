import { cpSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { type MarfaClient } from "../../client/api.js";
import { bucketAt, instanceIdOf, ownerOf } from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  ownObjectStore,
  runJob,
} from "../../utils/own-blob-server.js";

/**
 * Two servers on one prefix of one bucket, as when a server replaces another
 * that may still run, and a server started again on an image of its data
 * directory: each deletes only the objects it wrote (`stores/delete-only-written`
 * and `instance/backup-thinning-only-backups`), writes its own copy of a file a
 * restore found (`stores/replicate-own-copy`), and keeps the files a backup
 * in its folder names though its database never recorded that backup
 * (`instance/backup-found-keeps-files`).
 */

const DAY = 24 * 3_600_000;
const SETTINGS = {
  MARFA_BACKUP_INTERVAL_MS: "0",
  MARFA_BLOB_CLEANUP_GRACE_MS: "0",
};
const servers: FreshServer[] = [];
const images: string[] = [];

afterAll(async () => {
  for (const server of servers) await server.stop();
  for (const image of images) rmSync(image, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

async function boot(
  name: string,
  store: Record<string, string>,
): Promise<FreshServer> {
  const server = await bootFreshServer(name, { ...store, ...SETTINGS });
  servers.push(server);
  return server;
}

async function replicated(operator: MarfaClient): Promise<void> {
  for (let run = 0; run < 20; run++) {
    const { result } = await runJob<{ remaining: number }>(
      operator,
      "blob-replicate",
    );
    if (result.remaining === 0) return;
  }
  throw new Error("replication did not finish");
}

/** A file the server holds and replicates, named by a `core.file` item unless `named` is false. */
async function file(server: FreshServer, words: string, named = true) {
  const { operator, working } = clientsFor(server);
  const bytes = bytesOf(words, 4096);
  const uploaded = await working.uploadBlob(bytes, "text/plain");
  expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
  let item: string | undefined;
  if (named) item = await name(server, uploaded.data.hash);
  await replicated(operator);
  return { hash: uploaded.data.hash, bytes, item };
}

async function name(server: FreshServer, hash: string): Promise<string> {
  const created = await clientsFor(server).working.createItem({
    type: "core.file",
    properties: { blob_ref: hash, mime_type: "text/plain" },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.item.id;
}

/** Trashes and purges the item, which takes its history with it. */
async function unname(server: FreshServer, id: string): Promise<void> {
  const { working } = clientsFor(server);
  expect((await working.deleteItem(id)).status).toBe(200);
  const purged = await working.purgeItem(id);
  expect(purged.status, JSON.stringify(purged.error)).toBe(200);
}

async function purgeOrphans(server: FreshServer): Promise<void> {
  const { operator } = clientsFor(server);
  await runJob(operator, "blob-orphans");
  await runJob(operator, "blob-orphans");
}

/** Every clean-up a server runs on its own, and a backup with thinning. */
async function cleanEverything(server: FreshServer): Promise<void> {
  const { operator } = clientsFor(server);
  await purgeOrphans(server);
  await runJob(operator, "blob-integrity");
  await replicated(operator);
  const backup = await ownerOf(server).runBackup();
  expect(backup.status, JSON.stringify(backup.error)).toBe(200);
}

async function download(server: FreshServer, hash: string) {
  const read = await clientsFor(server).operator.downloadBlob(hash);
  return { status: read.status, bytes: new Uint8Array(read.data ?? []) };
}

describe("an object store's layout under its prefix", () => {
  it("keeps the files and the store's marker under the prefix's blobs folder and the backups under its backups folder", async () => {
    const store = ownObjectStore();
    const bucket = bucketAt(store.S3_PREFIX);
    const server = await boot("bucket-layout", store);
    const id = await instanceIdOf(server);
    const kept = await file(server, "a file under the blobs folder");
    const run = await ownerOf(server).runBackup();
    expect(run.status, JSON.stringify(run.error)).toBe(200);

    const hex = kept.hash.replace(/^sha256:/, "");
    const keys = await bucket.keys();
    const files = keys.filter((key) => key.includes(hex));
    expect(files.length).toBe(1);
    expect(files[0]!.startsWith(`${store.S3_PREFIX}/blobs/${hex}/`)).toBe(true);
    expect(keys).toContain(`${store.S3_PREFIX}/blobs/.marfa-store`);
    expect(keys).toContain(
      `${store.S3_PREFIX}/backups/${id}/${run.data.backup.name}`,
    );
    expect(
      keys.filter(
        (key) =>
          !key.startsWith(`${store.S3_PREFIX}/blobs/`) &&
          !key.startsWith(`${store.S3_PREFIX}/backups/`),
      ),
    ).toEqual([]);
  });

  it("starts beside objects an older layout left at the prefix's root, and never reads or deletes them", async () => {
    const store = ownObjectStore();
    const bucket = bucketAt(store.S3_PREFIX);
    const bytes = bytesOf("a file an older layout kept", 4096);
    const hex = createHash("sha256").update(bytes).digest("hex");
    const left = [
      `${store.S3_PREFIX}/.marfa-store`,
      `${store.S3_PREFIX}/${hex}/${randomUUID().replaceAll("-", "")}`,
    ];
    await bucket.put(left[0]!, randomUUID());
    await bucket.put(left[1]!, bytes);

    const server = await boot("bucket-older-layout", store);
    const { operator, working } = clientsFor(server);
    const s3 = (await operator.listBlobStores()).data.data.find(
      (found) => found.kind === "s3",
    )!;
    const marker = new TextDecoder().decode(
      await bucket.get(`${store.S3_PREFIX}/blobs/.marfa-store`),
    );
    expect(marker.trim()).toBe(s3.id);
    const uploaded = await working.uploadBlob(bytes, "text/plain");
    expect(uploaded.status).toBe(201);
    await replicated(operator);
    const written = (await bucket.keys()).filter((key) =>
      key.startsWith(`${store.S3_PREFIX}/blobs/${hex}/`),
    );
    expect(written.length).toBe(1);

    await purgeOrphans(server);
    expect((await download(server, uploaded.data.hash)).status).toBe(404);
    const after = await bucket.keys();
    expect(after).not.toContain(written[0]);
    for (const key of left) expect(after).toContain(key);
  });
});

describe("two servers on one prefix", () => {
  it("deletes none of the first server's objects from a server restored from its backup, through every clean-up, so the first server's backup still restores", async () => {
    const store = ownObjectStore();
    const bucket = bucketAt(store.S3_PREFIX);
    const first = await boot("bucket-first", store);
    const firstId = await instanceIdOf(first);
    const both = await file(first, "a file both servers wrote");
    const adopted = await file(first, "a file only the first server wrote");
    const dropped = await file(first, "a file whose copy the second drops");
    const backup = await ownerOf(first).runBackup();
    expect(backup.status, JSON.stringify(backup.error)).toBe(200);
    const backupName = backup.data.backup.name;
    const written = await bucket.keys();

    const second = await boot("bucket-second", store);
    const { operator } = clientsFor(second);
    const own = await clientsFor(second).working.uploadBlob(
      both.bytes,
      "text/plain",
    );
    expect(own.status).toBe(201);
    await replicated(operator);
    const ownObjects = (await bucket.keys()).filter(
      (key) => !written.includes(key),
    );
    expect(
      ownObjects.some((key) =>
        key.includes(`/blobs/${both.hash.replace(/^sha256:/, "")}/`),
      ),
    ).toBe(true);

    // A restore interrupted before its write, then every clean-up.
    await second.setFault("hold:restore:before-commit");
    const interrupted = ownerOf(second)
      .restoreBackup(firstId, backupName)
      .catch(() => undefined);
    await second.waitForHold("hold:restore:before-commit");
    await second.restart({ signal: "SIGKILL" });
    await interrupted;
    await cleanEverything(second);
    expect(await bucket.keys()).toEqual(expect.arrayContaining(written));

    const restored = await ownerOf(second).restoreBackup(firstId, backupName);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([]);
    for (const kept of [both, adopted, dropped]) {
      expect(await download(second, kept.hash)).toEqual({
        status: 200,
        bytes: kept.bytes,
      });
    }

    // The witness: a file the second server wrote alone goes from the bucket.
    const witness = await file(second, "a file only the second server wrote");
    const witnessObjects = (await bucket.keys()).filter((key) =>
      key.includes(`/blobs/${witness.hash.replace(/^sha256:/, "")}/`),
    );
    expect(witnessObjects.length).toBe(1);

    const { operator: restarted } = clientsFor(second);
    const s3 = (await restarted.listBlobStores()).data.data.find(
      (found) => found.kind === "s3",
    )!;
    const drop = await restarted.deleteBlobCopy(dropped.hash, s3.id);
    expect(drop.status, JSON.stringify(drop.error)).toBe(200);
    for (const gone of [both, adopted, witness]) {
      await unname(second, gone.item!);
    }
    await cleanEverything(second);
    for (const gone of [both, adopted, witness]) {
      expect((await download(second, gone.hash)).status).toBe(404);
    }
    await second.pauseClock(true);
    try {
      for (const days of [2, 40]) {
        await second.advanceClock(days * DAY);
        await cleanEverything(second);
      }
    } finally {
      await second.pauseClock(false);
    }

    const left = await bucket.keys();
    expect(left).toEqual(expect.arrayContaining(written));
    for (const key of [...ownObjects, ...witnessObjects]) {
      expect(left).not.toContain(key);
    }

    const { operator: firstOperator } = clientsFor(first);
    const integrity = await runJob<{ struck: number }>(
      firstOperator,
      "blob-integrity",
    );
    expect(integrity.result.struck).toBe(0);
    const third = await boot("bucket-third", store);
    const again = await ownerOf(third).restoreBackup(firstId, backupName);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.blobs_missing).toEqual([]);
    for (const kept of [both, adopted, dropped]) {
      expect(await download(third, kept.hash)).toEqual({
        status: 200,
        bytes: kept.bytes,
      });
    }
  });

  it("writes a copy of its own of each file a restore found in the bucket, and then drops the disk copy", async () => {
    const store = ownObjectStore();
    const bucket = bucketAt(store.S3_PREFIX);
    const first = await boot("bucket-own-first", store);
    const firstId = await instanceIdOf(first);
    const kept = await file(first, "a file the second server copies for itself");
    const backup = await ownerOf(first).runBackup();
    expect(backup.status, JSON.stringify(backup.error)).toBe(200);
    const hex = kept.hash.replace(/^sha256:/, "");
    const objects = async () =>
      (await bucket.keys()).filter((key) =>
        key.startsWith(`${store.S3_PREFIX}/blobs/${hex}/`),
      );
    const firsts = await objects();
    expect(firsts.length).toBe(1);

    const second = await boot("bucket-own-second", store);
    const restored = await ownerOf(second).restoreBackup(
      firstId,
      backup.data.backup.name,
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([]);
    const { operator } = clientsFor(second);
    await replicated(operator);
    const both = await objects();
    expect(both.length).toBe(2);
    expect(both).toEqual(expect.arrayContaining(firsts));

    const stores = (await operator.listBlobStores()).data.data;
    const disk = stores.find((found) => found.kind === "disk")!;
    const s3 = stores.find((found) => found.kind === "s3")!;
    const drop = await operator.deleteBlobCopy(kept.hash, disk.id);
    expect(drop.status, JSON.stringify(drop.error)).toBe(200);
    expect(await download(second, kept.hash)).toEqual({
      status: 200,
      bytes: kept.bytes,
    });
    const last = await operator.deleteBlobCopy(kept.hash, s3.id);
    expect(last.status).toBe(409);
    expect(last.error?.error.code).toBe("copies_below_minimum");
    expect(await objects()).toEqual(expect.arrayContaining(both));
  });

  it("keeps the files a backup in its folder names when its database never recorded that backup, and deletes only the backups it recorded", async () => {
    const store = ownObjectStore();
    const bucket = bucketAt(store.S3_PREFIX);
    const server = await boot("bucket-image", store);
    const id = await instanceIdOf(server);
    const early = await ownerOf(server).runBackup();
    expect(early.status, JSON.stringify(early.error)).toBe(200);
    const later = await file(server, "a file only a later backup names", false);
    const witness = await file(server, "a file no backup names", false);
    const image = await server.image();
    images.push(image);

    await name(server, later.hash);
    const unrecorded = await ownerOf(server).runBackup();
    expect(unrecorded.status, JSON.stringify(unrecorded.error)).toBe(200);
    const unrecordedKey = `${store.S3_PREFIX}/backups/${id}/${unrecorded.data.backup.name}`;
    const earlyKey = `${store.S3_PREFIX}/backups/${id}/${early.data.backup.name}`;

    await server.restart(() => {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${server.sqlitePath}${suffix}`, { force: true });
      }
      cpSync(image, server.stateDir, { recursive: true, force: true });
    });
    await purgeOrphans(server);
    expect((await download(server, witness.hash)).status).toBe(404);
    expect(await download(server, later.hash)).toEqual({
      status: 200,
      bytes: later.bytes,
    });

    await server.pauseClock(true);
    try {
      await server.advanceClock(40 * DAY);
      const thinned = await ownerOf(server).runBackup();
      expect(thinned.status, JSON.stringify(thinned.error)).toBe(200);
      const backups = await bucket.backupKeys();
      expect(backups).not.toContain(earlyKey);
      expect(backups).toContain(unrecordedKey);
      await purgeOrphans(server);
      expect((await download(server, later.hash)).status).toBe(200);
    } finally {
      await server.pauseClock(false);
    }

    const fresh = await boot("bucket-image-fresh", store);
    const restored = await ownerOf(fresh).restoreBackup(
      id,
      unrecorded.data.backup.name,
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([]);
    expect(await download(fresh, later.hash)).toEqual({
      status: 200,
      bytes: later.bytes,
    });
  });
});
