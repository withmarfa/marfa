import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const DAY = 24 * 3_600_000;
const store = ownObjectStore();
const bucket = bucketAt(store.S3_PREFIX);
let origin: FreshServer;
let originId: string;
let fresh: FreshServer | undefined;

beforeAll(async () => {
  origin = await bootFreshServer("backup-files", {
    ...store,
    MARFA_BACKUP_INTERVAL_MS: "0",
  });
  originId = await instanceIdOf(origin);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await fresh?.stop();
  await origin?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** A file the bucket holds, named by a `core.file` item. */
async function namedFile(server: FreshServer, words: string) {
  const { operator, working } = clientsFor(server);
  const bytes = bytesOf(words, 4096);
  const uploaded = await working.uploadBlob(bytes, "text/plain");
  expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
  const item = await working.createItem({
    type: "core.file",
    properties: { blob_ref: uploaded.data.hash, mime_type: "text/plain" },
  });
  expect(item.status, JSON.stringify(item.error)).toBe(201);
  for (let run = 0; run < 20; run++) {
    const { result } = await runJob<{ remaining: number }>(
      operator,
      "blob-replicate",
    );
    if (result.remaining === 0) break;
  }
  return { hash: uploaded.data.hash, item: item.data.item.id, bytes };
}

/** Trashes and purges the item, which takes its history with it. */
async function unname(server: FreshServer, id: string) {
  const { working } = clientsFor(server);
  expect((await working.deleteItem(id)).status).toBe(200);
  const purged = await working.purgeItem(id);
  expect(purged.status, JSON.stringify(purged.error)).toBe(200);
}

async function objectsOf(hash: string): Promise<string[]> {
  const hex = hash.replace(/^sha256:/, "");
  return (await bucket.keys()).filter((key) =>
    key.startsWith(`${store.S3_PREFIX}/${hex}/`),
  );
}

let kept: Awaited<ReturnType<typeof namedFile>>;
let backupName: string;

describe("the files a backup names", () => {
  it("keeps a file a retained backup names once nothing else names it, across a restart, so a fresh server on the bucket restores it whole", async () => {
    kept = await namedFile(origin, "a file only a backup names");
    const run = await ownerOf(origin).runBackup();
    expect(run.status, JSON.stringify(run.error)).toBe(200);
    expect(run.data.outcome).toBe("put");
    backupName = run.data.backup.name;
    const witness = await namedFile(origin, "a file no backup names");

    await unname(origin, kept.item);
    await unname(origin, witness.item);
    await runJob(clientsFor(origin).operator, "blob-orphans");
    const report = await clientsFor(origin).operator.listBlobOrphans();
    expect(report.data.data.map((row) => row.hash)).toEqual(
      expect.arrayContaining([kept.hash, witness.hash]),
    );

    await origin.restart();
    const { operator } = clientsFor(origin);
    await runJob(operator, "blob-orphans");
    expect((await operator.downloadBlob(witness.hash)).status).toBe(404);
    expect(await objectsOf(witness.hash)).toEqual([]);
    expect((await operator.downloadBlob(kept.hash)).status).toBe(200);
    expect((await objectsOf(kept.hash)).length).toBeGreaterThan(0);

    fresh = await bootFreshServer("backup-files-fresh", {
      ...store,
      MARFA_BACKUP_INTERVAL_MS: "0",
    });
    const restored = await ownerOf(fresh).restoreBackup(originId, backupName);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([]);
    const read = await clientsFor(fresh).operator.downloadBlob(kept.hash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(kept.bytes);
    await fresh.stop();
    fresh = undefined;
  });

  it("refuses to drop the object store's copy of a file a retained backup names, and drops its disk copy", async () => {
    const { operator } = clientsFor(origin);
    const stores = (await operator.listBlobStores()).data.data;
    const s3 = stores.find((store) => store.kind === "s3")!;
    const disk = stores.find((store) => store.kind === "disk")!;
    const witness = await namedFile(origin, "a file no backup holds a copy of");
    const dropped = await operator.deleteBlobCopy(witness.hash, s3.id);
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    expect(await objectsOf(witness.hash)).toEqual([]);

    const refused = await operator.deleteBlobCopy(kept.hash, s3.id);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("copy_held_by_backup");
    expect((await objectsOf(kept.hash)).length).toBeGreaterThan(0);

    const fromDisk = await operator.deleteBlobCopy(kept.hash, disk.id);
    expect(fromDisk.status, JSON.stringify(fromDisk.error)).toBe(200);
    const read = await operator.downloadBlob(kept.hash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(kept.bytes);
  });

  it("refuses a backup with 409 conflict and puts no object when the object store's copy of a file it names is dropped while it is read", async () => {
    const { operator } = clientsFor(origin);
    const s3 = (await operator.listBlobStores()).data.data.find(
      (store) => store.kind === "s3",
    )!;
    const named = await namedFile(
      origin,
      "a file dropped during a backup read",
    );
    const before = await bucket.backupKeys();
    const owner = ownerOf(origin);

    await origin.setFault("hold:backup:read");
    const running = owner.runBackup();
    await origin.waitForHold("hold:backup:read");
    const dropped = await operator.deleteBlobCopy(named.hash, s3.id);
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    await origin.clearFault();
    const refused = await running;
    expect(refused.status, JSON.stringify(refused.data)).toBe(409);
    expect(refused.error?.error.code).toBe("conflict");
    expect(await bucket.backupKeys()).toEqual(before);
    await unname(origin, named.item);
  });

  it("purges a file once thinning has deleted every backup that names it", async () => {
    const { operator } = clientsFor(origin);
    await runJob(operator, "blob-orphans");
    expect((await operator.downloadBlob(kept.hash)).status).toBe(200);

    await origin.pauseClock(true);
    try {
      await origin.advanceClock(40 * DAY);
      const later = await ownerOf(origin).runBackup();
      expect(later.status, JSON.stringify(later.error)).toBe(200);
      expect(later.data.removed).toBe(1);
      expect(await bucket.backupKeys()).toEqual([
        `${store.S3_PREFIX}/backups/${originId}/${later.data.backup.name}`,
      ]);

      await runJob(operator, "blob-orphans");
      expect((await operator.downloadBlob(kept.hash)).status).toBe(404);
      expect(await objectsOf(kept.hash)).toEqual([]);
    } finally {
      await origin.pauseClock(false);
    }
  });
});
