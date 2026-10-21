import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
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
  leaveBacklog,
  ownObjectStore,
  replicationIdle,
  runJob,
} from "../../utils/own-blob-server.js";
import { TEST_OWNER } from "../../utils/target.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What `blob-integrity`, `blob-replicate`, a drop and a read of a blob's
 * bytes do when a store does not answer, on a server of the fixture's own
 * that keeps its bytes on a disk and in the run's object store. The `hold:blob-has`
 * and `hold:blob-read` faults (`conformance/README.md`, "Faults") make every
 * store hang before it answers whether it holds a blob or opens its bytes,
 * until the fault is cleared or the server gives the request up;
 * `hold:blob-write` and `hold:blob-delete` make a store's write or delete
 * hang until the fault is cleared, since a store can carry one out after
 * the server stops waiting. `store-check-deadline` shortens how long the
 * server waits for an answer, so a case tests the bound rather than waiting
 * out its 15 seconds.
 *
 * **Why a server of its own.** A hold acts on every store of the server it
 * is set on, and the scheduler runs the same jobs on its own clock. Each
 * boot waits for the first scheduled run of each job, so a run between two
 * steps of a case is never one the case did not ask for.
 */
let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;

const JOBS = ["blob-integrity", "blob-replicate", "blob-orphans"];
const HOLDS = ["hold:blob-has", "hold:blob-read"];

/** Waits until no blob job runs, and the next run of each is far away. */
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

/** Makes every store hang before it answers, and waits 200 ms for one. */
async function storesHang(): Promise<void> {
  await server.setFault("store-check-deadline=200");
  for (const hold of HOLDS) await server.setFault(hold);
}

/** How many requests wait at the holds now. */
async function waiting(): Promise<number> {
  return (await server.faults())
    .filter((fault) => HOLDS.includes(fault.name))
    .reduce((sum, fault) => sum + fault.waiting, 0);
}

/** How many store calls wait at the hold `name` now. */
async function waitingAt(name: string): Promise<number> {
  return (
    (await server.faults()).find((fault) => fault.name === name)?.waiting ?? 0
  );
}

/** The id of the run's object store. */
async function objectStore(): Promise<string> {
  const stores = (await operator.listBlobStores()).data.data;
  return stores.find((store) => store.kind === "s3")!.id;
}

/** A blob in both stores, referenced so that nothing purges it. */
async function replicated(
  words: string,
  content = bytesOf(words, 120),
): Promise<string> {
  const upload = await working.uploadBlob(content, "text/plain");
  expect(upload.status, JSON.stringify(upload.error)).toBe(201);
  const hash = upload.data.hash;
  const note = await working.createItem({
    type: "core.note",
    properties: { body: `![bytes](${hash})` },
  });
  expect(note.status, JSON.stringify(note.error)).toBe(201);
  await waitFor(`the object store's copy of ${hash}`, async () =>
    (await operator.listBlobLocations(hash)).data.data.length === 2
      ? true
      : undefined,
  );
  await replicationIdle(operator);
  return hash;
}

/** Alters the disk's copy of `hash` at its first byte, keeping its length,
 *  so the next integrity check strikes it. */
function corruptOnDisk(hash: string): void {
  const path = diskPath(server, hash);
  const bytes = readFileSync(path);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  writeFileSync(path, bytes);
}

/** Replicates until no store lacks a blob, once the stores answer again. */
async function replicatedAgain(what: string): Promise<void> {
  await waitFor(what, async () => {
    const run = await runJob<{ copied: number; remaining: number }>(
      operator,
      "blob-replicate",
    );
    return run.result.remaining === 0 ? true : undefined;
  });
}

/** The instance's owner, who alone may restore an archive. */
function owner(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: "",
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
  });
}

beforeAll(async () => {
  server = await bootFreshServer("blob-store-silent", ownObjectStore());
  ({ operator, working } = clientsFor(server));
  await jobsIdle();
}, FRESH_SERVER_TIMEOUT_MS + 90_000);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("an integrity check while no store answers", () => {
  it("finishes, counts each silent store as unreachable, strikes nothing, and checks the copies once the stores answer", async () => {
    const hash = await replicated("checked while the stores hang");
    // The witness: with the stores answering, both copies are checked.
    expect((await runJob(operator, "blob-integrity")).result).toMatchObject({
      verified: 2,
      struck: 0,
      unreachable: 0,
    });

    await storesHang();
    const run = await runJob(operator, "blob-integrity");
    expect(run.result).toEqual({
      verified: 0,
      struck: 0,
      bytes: 0,
      unreachable: 2,
    });
    // The questions the run gave up on wait at the holds no longer.
    expect(await waiting()).toBe(0);
    expect(
      (await operator.listBlobLocations(hash)).data.data.map(
        (location) => location.kind,
      ),
    ).toEqual(expect.arrayContaining(["disk", "s3"]));
    const struck = await operator.listAudit({
      action: "blob.copy_struck",
      resource_id: hash,
    });
    expect(struck.data.data).toEqual([]);

    await server.clearFault();
    expect((await runJob(operator, "blob-integrity")).result).toMatchObject({
      verified: 2,
      struck: 0,
      unreachable: 0,
    });
    expect((await operator.listBlobLocations(hash)).data.data).toHaveLength(2);
  });
});

describe("a replication run while no store answers", () => {
  it("finishes, copies nothing, counts the copy in remaining, and makes it once the stores answer", async () => {
    const [hash] = await leaveBacklog(operator, working, [
      bytesOf("copied while the stores hang", 120),
    ]);

    await storesHang();
    const run = await runJob(operator, "blob-replicate");
    expect(run.result).toMatchObject({ copied: 0, remaining: 1 });
    expect(await waiting()).toBe(0);
    expect(
      (await operator.listBlobLocations(hash!)).data.data.map(
        (location) => location.kind,
      ),
    ).toEqual(["disk"]);

    await server.clearFault();
    expect((await runJob(operator, "blob-replicate")).result).toMatchObject({
      copied: 1,
      remaining: 0,
    });
    expect((await operator.listBlobLocations(hash!)).data.data).toHaveLength(2);
  });
});

describe("a store's delete that does not answer", () => {
  it("leaves the deletion queued, skips the blob in later runs without waiting, refuses an upload and a restore of its bytes, and keeps the copy made once the delete ends", async () => {
    const content = bytesOf("deleted while the store hangs", 120);
    const hash = await replicated("deleted while the store hangs", content);
    const s3 = await objectStore();
    const exported = await owner().exportArchive();
    expect(exported.status, JSON.stringify(exported.error)).toBe(200);
    const archive = exported.data;
    // The drop's own delete fails, so the deletion stays queued for a run.
    await server.setFault("fail:blob-delete=1");
    const dropped = await operator.deleteBlobLocation(hash, s3);
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    await server.clearFault();

    await server.setFault("store-check-deadline=200");
    await server.setFault("hold:blob-delete");
    const checked = await runJob(operator, "blob-integrity");
    // The object store is the one counted: the disk answers.
    expect(checked.result).toMatchObject({ struck: 0, unreachable: 1 });
    // The delete the run gave up on is still out.
    expect(await waitingAt("hold:blob-delete")).toBe(1);

    const copied = await runJob(operator, "blob-replicate");
    expect(copied.result).toMatchObject({ copied: 0, remaining: 1 });
    // Skipped rather than asked again: no second delete waits.
    expect(await waitingAt("hold:blob-delete")).toBe(1);
    expect(
      (await operator.listBlobLocations(hash)).data.data.map(
        (location) => location.kind,
      ),
    ).toEqual(["disk"]);

    const refused = await working.uploadBlob(content, "text/plain");
    expect(refused.status).toBe(503);
    expect(refused.error?.error.code).toBe("blob_store_unavailable");
    // A restore of an archive carrying the blob is refused at once too.
    const restoreRefused = await owner().restoreArchive(archive);
    expect(restoreRefused.status).toBe(503);
    expect(restoreRefused.error?.error.code).toBe("blob_store_unavailable");

    await server.clearFault();
    await waitFor("the object store's copy made again", async () => {
      const run = await runJob<{ copied: number; remaining: number }>(
        operator,
        "blob-replicate",
      );
      return run.result.remaining === 0 ? true : undefined;
    });
    expect((await operator.listBlobLocations(hash)).data.data).toHaveLength(2);
    // The late delete took nothing the copy made after it holds: the check
    // takes the copy never checked first, and would strike it if gone.
    expect((await runJob(operator, "blob-integrity")).result).toMatchObject({
      struck: 0,
      unreachable: 0,
    });
    expect((await operator.listBlobLocations(hash)).data.data).toHaveLength(2);
    const again = await working.uploadBlob(content, "text/plain");
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    // The witness: the same archive restores once the store has answered.
    const restored = await owner().restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
  });
});

describe("a strike whose delete does not answer", () => {
  it("counts the store as unreachable, asks it nothing more in the run, and keeps the copy struck", async () => {
    const hashes = [
      await replicated("struck while the disk's delete hangs, first"),
      await replicated("struck while the disk's delete hangs, second"),
    ];
    for (const hash of hashes) corruptOnDisk(hash);

    await server.setFault("store-check-deadline=200");
    await server.setFault("hold:blob-delete");
    const run = await runJob(operator, "blob-integrity");
    // One copy struck; the disk, whose delete of it hangs, is asked about
    // nothing else, so the other altered copy waits for a later run.
    expect(run.result).toMatchObject({ struck: 1, unreachable: 1 });
    expect(await waitingAt("hold:blob-delete")).toBe(1);
    const kinds = async (hash: string) =>
      (await operator.listBlobLocations(hash)).data.data
        .map((location) => location.kind)
        .sort();
    const left = await Promise.all(hashes.map(kinds));
    expect(left).toEqual(expect.arrayContaining([["s3"], ["disk", "s3"]]));

    // The witness: once the disk answers, the next run strikes the other.
    await server.clearFault();
    const next = await runJob(operator, "blob-integrity");
    expect(next.result).toMatchObject({ struck: 1, unreachable: 0 });
    await replicatedAgain("the disk's copies made again");
    for (const hash of hashes)
      expect(await kinds(hash)).toEqual(["disk", "s3"]);
  });
});

describe("an upload while the disk does not finish a queued deletion of its bytes", () => {
  it("answers 503 blob_store_unavailable, and stores the bytes once the disk answers", async () => {
    const content = bytesOf("uploaded while the disk's deletion hangs", 120);
    const hash = await replicated(
      "uploaded while the disk's deletion hangs",
      content,
    );
    const disk = (await operator.listBlobStores()).data.data.find(
      (store) => store.kind === "disk",
    )!.id;
    // The drop's own delete fails, so the deletion stays queued and the
    // blob's lock is free.
    await server.setFault("fail:blob-delete=1");
    const dropped = await operator.deleteBlobLocation(hash, disk);
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    await server.clearFault();

    await server.setFault("store-check-deadline=200");
    await server.setFault("hold:blob-delete");
    const refused = await working.uploadBlob(content, "text/plain");
    expect(refused.status).toBe(503);
    expect(refused.error?.error.code).toBe("blob_store_unavailable");
    expect(await waitingAt("hold:blob-delete")).toBe(1);

    await server.clearFault();
    await waitFor("the upload stored once the disk answers", async () => {
      const stored = await working.uploadBlob(content, "text/plain");
      return stored.status === 201 ? true : undefined;
    });
    await replicatedAgain("the copies of the uploaded blob");
    expect(
      (await operator.listBlobLocations(hash)).data.data
        .map((location) => location.kind)
        .sort(),
    ).toEqual(["disk", "s3"]);
  });
});

describe("a store's write that does not answer", () => {
  it("finishes the run, counts the copy in remaining, skips the blob in later runs without waiting, and refuses an upload of its bytes", async () => {
    const content = bytesOf("written while the store hangs", 120);
    const [hash] = await leaveBacklog(operator, working, [content]);

    await server.setFault("store-check-deadline=200");
    await server.setFault("hold:blob-write");
    const run = await runJob(operator, "blob-replicate");
    expect(run.result).toMatchObject({ copied: 0, remaining: 1 });
    // The write the run gave up on is still out.
    expect(await waitingAt("hold:blob-write")).toBe(1);

    const later = await runJob(operator, "blob-replicate");
    expect(later.result).toMatchObject({ copied: 0, remaining: 1 });
    expect(await waitingAt("hold:blob-write")).toBe(1);
    expect(
      (await operator.listBlobLocations(hash!)).data.data.map(
        (location) => location.kind,
      ),
    ).toEqual(["disk"]);

    const refused = await working.uploadBlob(content, "text/plain");
    expect(refused.status).toBe(503);
    expect(refused.error?.error.code).toBe("blob_store_unavailable");

    await server.clearFault();
    await waitFor("the object store's copy", async () => {
      const copied = await runJob<{ copied: number; remaining: number }>(
        operator,
        "blob-replicate",
      );
      return copied.result.remaining === 0 ? true : undefined;
    });
    expect((await operator.listBlobLocations(hash!)).data.data).toHaveLength(2);
  });
});

describe("a drop while a store does not finish a write of the blob's bytes", () => {
  it("answers 503 blob_store_unavailable at once, keeps the copy, and drops it once the store answers", async () => {
    const content = bytesOf("dropped while the store's write hangs", 120);
    const [hash] = await leaveBacklog(operator, working, [content]);
    const disk = (await operator.listBlobStores()).data.data.find(
      (store) => store.kind === "disk",
    )!.id;

    await server.setFault("store-check-deadline=200");
    await server.setFault("hold:blob-write");
    const run = await runJob(operator, "blob-replicate");
    expect(run.result).toMatchObject({ copied: 0, remaining: 1 });
    expect(await waitingAt("hold:blob-write")).toBe(1);

    // The write is held until the fault is cleared, so a drop that waited
    // on it would not answer at all.
    const refused = await operator.deleteBlobLocation(hash!, disk);
    expect(refused.status).toBe(503);
    expect(refused.error?.error.code).toBe("blob_store_unavailable");
    expect(await waitingAt("hold:blob-write")).toBe(1);
    expect(
      (await operator.listBlobLocations(hash!)).data.data.map(
        (location) => location.kind,
      ),
    ).toEqual(["disk"]);

    // The witness: once the store answers and the copy is made, the same
    // drop goes through.
    await server.clearFault();
    await replicatedAgain("the object store's copy");
    const dropped = await operator.deleteBlobLocation(hash!, disk);
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    expect(
      (await operator.listBlobLocations(hash!)).data.data.map(
        (location) => location.kind,
      ),
    ).toEqual(["s3"]);
  });
});

describe("a read of a blob's bytes while a store does not open them", () => {
  it("answers 503 blob_store_unavailable when no store opens the bytes, and serves them from a store that does", async () => {
    const content = bytesOf("read while the stores hang", 120);
    const hash = await replicated("read while the stores hang", content);

    await storesHang();
    const refused = await working.downloadBlob(hash);
    expect(refused.status).toBe(503);
    expect(refused.error?.error.code).toBe("blob_store_unavailable");
    expect(await waiting()).toBe(0);

    // Only the first store asked, the disk, hangs; the object store answers.
    await server.clearFault();
    await server.setFault("store-check-deadline=200");
    await server.setFault("hold:blob-read=1");
    const served = await working.downloadBlob(hash);
    expect(served.status, JSON.stringify(served.error)).toBe(200);
    expect(new Uint8Array(served.data)).toEqual(content);
    // The read the server passed over waits at the hold no longer.
    expect(await waitingAt("hold:blob-read")).toBe(0);
  });
});
