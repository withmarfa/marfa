import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  diskPath,
  ownObjectStore,
  replicationIdle,
  runJob,
} from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What the server does with the bytes of a copy it dropped when the store
 * cannot delete them, on a server of the fixture's own that keeps its bytes
 * on a disk and in the run's object store, and runs an integrity check of one
 * copy at a time. A drop commits, takes the copy out of the copy record and
 * then deletes the bytes; the target interface's `fail:blob-delete` fault
 * (`conformance/README.md`, "Faults") makes the store refuse that deletion
 * once. What is left is the intent to delete the bytes, which the next run of
 * `blob-integrity` (and of `blob-replicate`) retries, a bounded number of
 * copies at a time.
 *
 * **Why a server of its own.** The scheduler runs the same jobs on its own
 * clock, and a run between two steps of a case would do the retry the case
 * means to watch for. The first run of each comes thirty seconds after boot,
 * so each boot waits for those and for the replication of what it holds.
 */
let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;
let diskStoreId: string;

const JOBS = ["blob-integrity", "blob-replicate", "blob-orphans"];

/** Waits until no job that retries a deletion runs, and the next run of each is a day away. */
async function jobsIdle(): Promise<void> {
  await waitFor(
    "the first scheduled run of each blob job",
    async () => {
      const jobs = (await operator.listHousekeeping()).data.data;
      return JOBS.every((name) => {
        const job = jobs.find((row) => row.name === name);
        return (
          job !== undefined &&
          job.running_since === null &&
          Date.parse(job.next_run_at) - Date.now() > job.interval_ms / 2
        );
      })
        ? true
        : undefined;
    },
    90_000,
  );
}

beforeAll(async () => {
  server = await bootFreshServer("blob-cleanup-faults", {
    ...ownObjectStore(),
    MARFA_BLOB_INTEGRITY_BATCH: "1",
  });
  ({ operator, working } = clientsFor(server));
  await jobsIdle();
  const stores = (await operator.listBlobStores()).data.data;
  diskStoreId = stores.find((store) => store.kind === "disk")!.id;
}, FRESH_SERVER_TIMEOUT_MS + 90_000);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** A blob in both stores, referenced so that nothing purges it. */
async function replicated(words: string): Promise<string> {
  const data = bytesOf(words, 120);
  const upload = await working.uploadBlob(data, "text/plain");
  expect(upload.status, JSON.stringify(upload.error)).toBe(201);
  const hash = upload.data.hash;
  const note = await working.createItem({
    type: "core.note",
    properties: { body: `![bytes](${hash})` },
  });
  expect(note.status, JSON.stringify(note.error)).toBe(201);
  await waitFor(`the object store's copy of ${hash}`, async () =>
    (await operator.listBlobCopies(hash)).data.data.length === 2
      ? true
      : undefined,
  );
  await replicationIdle(operator);
  expect(existsSync(diskPath(server, hash))).toBe(true);
  return hash;
}

async function fired(): Promise<number | undefined> {
  return (await server.faults()).find(
    (fault) => fault.name === "fail:blob-delete",
  )?.fired;
}

/** Drops the disk's copy while the store refuses to delete its bytes. The drop stands. */
async function dropWithTheStoreFailing(hash: string): Promise<void> {
  await server.setFault("fail:blob-delete");
  const dropped = await operator.deleteBlobCopy(hash, diskStoreId);
  expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
  expect(await fired()).toBe(1);
  const copies = (await operator.listBlobCopies(hash)).data.data;
  expect(copies.map((copy) => copy.kind)).toEqual(["s3"]);
  // The copy is out of the copy record and its bytes are still on the disk.
  expect(existsSync(diskPath(server, hash))).toBe(true);
}

describe("the bytes of a copy that was dropped", () => {
  it("are deleted when nothing stops the drop, which is the witness for the cases below", async () => {
    const hash = await replicated("dropped without a fault");
    const dropped = await operator.deleteBlobCopy(hash, diskStoreId);
    expect(dropped.status).toBe(200);
    expect(existsSync(diskPath(server, hash))).toBe(false);
  });

  it("are deleted on a later run once the store can, when it could not delete them at the drop", async () => {
    const hash = await replicated("dropped while the store failed");
    await dropWithTheStoreFailing(hash);

    await runJob(operator, "blob-integrity");
    expect(existsSync(diskPath(server, hash))).toBe(false);
    expect(await fired()).toBe(1);
  });
});

describe("the bytes of other copies, while a store keeps failing to delete one", () => {
  it("are deleted by the runs that follow, each run taking one copy, including after a restart", async () => {
    const stuck = await replicated("a copy whose delete fails");
    const other = await replicated("a copy queued behind it");
    await dropWithTheStoreFailing(stuck);
    await dropWithTheStoreFailing(other);

    // The run takes one copy, the one that has waited longest, and the store
    // refuses it again.
    await server.setFault("fail:blob-delete");
    await runJob(operator, "blob-integrity");
    expect(await fired()).toBe(1);
    expect(existsSync(diskPath(server, stuck))).toBe(true);
    expect(existsSync(diskPath(server, other))).toBe(true);

    // A restart forgets nothing the next run needs to know.
    await server.restart();
    ({ operator, working } = clientsFor(server));
    await jobsIdle();
    await runJob(operator, "blob-integrity");
    expect(existsSync(diskPath(server, other))).toBe(false);
    expect(existsSync(diskPath(server, stuck))).toBe(true);

    await runJob(operator, "blob-integrity");
    expect(existsSync(diskPath(server, stuck))).toBe(false);
  });
});
