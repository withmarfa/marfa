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
  DISK_ONLY,
  runJob,
} from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What the orphan sweep does to a blob it purges when something goes wrong
 * on the way, on a server of the fixture's own that keeps its bytes on one
 * disk. The sweep reports a blob nothing references on one run and purges it
 * on the next, which the grace of zero makes the very next one. The fixtures
 * cut a purge short with the target interface's faults
 * (`conformance/README.md`, "Faults"): `fail:blob-delete` makes the store
 * refuse to delete the bytes after the blob has left the registry,
 * `fail:audit=blob.purge` fails the purge before it has removed anything, and
 * `hold:blob-orphans:purge` makes a run wait between choosing a blob to purge
 * and purging it.
 *
 * **Why a server of its own.** The run's server runs the sweep on its own
 * clock for every file; a run between this file's two steps would purge what
 * the file means to report. The sweep's first run on its own clock comes
 * thirty seconds after boot, so `beforeAll` waits for it to set the next one
 * a day away.
 */
let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("blob-purge-faults", {
    ...DISK_ONLY,
    MARFA_BLOB_CLEANUP_GRACE_MS: "0",
  });
  ({ operator, working } = clientsFor(server));
  await waitFor(
    "the sweep's first run on its own clock",
    async () => {
      const jobs = await operator.listHousekeeping();
      const sweep = jobs.data.data.find((job) => job.name === "blob-orphans");
      return sweep !== undefined &&
        sweep.running_since === null &&
        Date.parse(sweep.next_run_at) - Date.now() > sweep.interval_ms / 2
        ? sweep
        : undefined;
    },
    60_000,
  );
}, FRESH_SERVER_TIMEOUT_MS + 60_000);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

interface Bytes {
  hash: string;
  data: Uint8Array;
}

/** A blob nothing references. */
async function unreferenced(words: string): Promise<Bytes> {
  const data = bytesOf(words, 120);
  const upload = await working.uploadBlob(data, "text/plain");
  expect(upload.status, JSON.stringify(upload.error)).toBe(201);
  return { hash: upload.data.hash, data };
}

async function reported(): Promise<string[]> {
  return (await operator.listBlobOrphans()).data.data.map((row) => row.hash);
}

async function fired(name: string): Promise<number | undefined> {
  return (await server.faults()).find((fault) => fault.name === name)?.fired;
}

/** Reports `blob`, which the next run would purge. */
async function reportedBlob(words: string): Promise<Bytes> {
  const blob = await unreferenced(words);
  await runJob(operator, "blob-orphans");
  expect(await reported()).toContain(blob.hash);
  return blob;
}

/** Whether the registry lists the blob, and whether a link to it is minted. */
async function listed(hash: string): Promise<boolean> {
  const read = await operator.downloadBlob(hash);
  const link = await operator.getBlobUrl(hash);
  const locations = await operator.listBlobLocations(hash);
  // Listed and linked are one answer: a blob the registry has left is neither.
  expect(read.status === 200, "download").toBe(link.status === 200);
  expect(read.status === 200, "locations").toBe(
    locations.status === 200 && locations.data.data.length > 0,
  );
  return read.status === 200;
}

describe("an orphan purge that nothing stops", () => {
  it("purges the blob on the run after the report, from the registry and from the disk, which is the witness for the cases below", async () => {
    const blob = await reportedBlob("purged without a fault");
    expect(existsSync(diskPath(server, blob.hash))).toBe(true);
    const run = await runJob<{ purged: number }>(operator, "blob-orphans");
    expect(run.result.purged).toBe(1);
    expect(await listed(blob.hash)).toBe(false);
    expect(existsSync(diskPath(server, blob.hash))).toBe(false);
  });
});

describe("an orphan purge cut short after the blob left the registry", () => {
  it("finishes removing the bytes on the next run, and answers the run that was cut short ok", async () => {
    const blob = await reportedBlob("purge cut short at the delete");
    await server.setFault("fail:blob-delete");
    const cut = await runJob<{ purged: number }>(operator, "blob-orphans");
    expect(await fired("fail:blob-delete")).toBe(1);
    expect(cut.result.purged).toBe(0);

    // The registry has let go of the blob and the store has not.
    expect(await listed(blob.hash)).toBe(false);
    expect(await reported()).not.toContain(blob.hash);
    expect(existsSync(diskPath(server, blob.hash))).toBe(true);

    await runJob(operator, "blob-orphans");
    expect(existsSync(diskPath(server, blob.hash))).toBe(false);
    expect(await listed(blob.hash)).toBe(false);
  });

  it("does not take the bytes of a blob an upload has stored again since", async () => {
    const blob = await reportedBlob("purge cut short, then sent again");
    await server.setFault("fail:blob-delete");
    await runJob(operator, "blob-orphans");
    expect(existsSync(diskPath(server, blob.hash))).toBe(true);

    // The same bytes are sent before the next run finishes the purge. That
    // run reports the blob again and has no purge left to finish.
    const again = await working.uploadBlob(blob.data, "text/plain");
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    await runJob(operator, "blob-orphans");
    const read = await operator.downloadBlob(blob.hash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(blob.data);
  });
});

describe("an orphan purge that is cut short", () => {
  it("leaves no blob listed or linked with its bytes gone, whether it is cut before the registry lets go or after", async () => {
    // Cut before the registry lets go: the blob stays listed and linked, so
    // its bytes have to be there.
    const before = await reportedBlob("cut short before the registry lets go");
    await server.setFault("fail:audit=blob.purge");
    await runJob(operator, "blob-orphans");
    expect(await fired("fail:audit")).toBe(1);
    expect(await listed(before.hash)).toBe(true);
    expect(existsSync(diskPath(server, before.hash))).toBe(true);
    const read = await operator.downloadBlob(before.hash);
    expect(new Uint8Array(read.data)).toEqual(before.data);
    const link = await operator.getBlobUrl(before.hash);
    expect((await fetch(link.data.url)).status).toBe(200);
    expect(await reported()).toContain(before.hash);

    // Cut after: nothing lists or links the bytes that are left.
    const after = await reportedBlob("cut short after the registry lets go");
    await server.setFault("fail:blob-delete");
    await runJob(operator, "blob-orphans");
    expect(await fired("fail:blob-delete")).toBe(1);
    expect(await listed(after.hash)).toBe(false);
    expect(existsSync(diskPath(server, after.hash))).toBe(true);

    // The next run, with nothing in its way, purges both.
    await server.clearFault();
    await runJob(operator, "blob-orphans");
    await runJob(operator, "blob-orphans");
    for (const blob of [before, after]) {
      expect(await listed(blob.hash)).toBe(false);
      expect(existsSync(diskPath(server, blob.hash))).toBe(false);
    }
  });
});

describe("an orphan purge that a write names the blob under", () => {
  async function runHeldAt(between: () => Promise<void>) {
    await server.setFault("hold:blob-orphans:purge");
    const sweep = operator.runHousekeeping("blob-orphans");
    await server.waitForHold("hold:blob-orphans:purge");
    await between();
    await server.clearFault("hold:blob-orphans:purge");
    const run = await sweep;
    expect(run.status, JSON.stringify(run.error)).toBe(200);
    expect(run.data.outcome, run.data.error ?? "").toBe("ok");
    return run.data.result as { purged: number };
  }

  it("purges a blob that nothing names by the time the run reaches it, which is the witness for the case below", async () => {
    const blob = await reportedBlob("reported and left alone");
    const result = await runHeldAt(async () => {
      // Chosen for the purge, and waiting.
      expect(existsSync(diskPath(server, blob.hash))).toBe(true);
    });
    expect(result.purged).toBe(1);
    expect(await listed(blob.hash)).toBe(false);
    expect(existsSync(diskPath(server, blob.hash))).toBe(false);
  });

  it("keeps the blob when a write that names it commits after the run chose it and before the run purges it", async () => {
    const blob = await reportedBlob("reported, then named while the run waits");
    let itemId = "";
    const result = await runHeldAt(async () => {
      const created = await working.createItem({
        type: "core.file",
        properties: { blob_ref: blob.hash, mime_type: "text/plain" },
      });
      expect(created.status, JSON.stringify(created.error)).toBe(201);
      itemId = created.data.item.id;
    });
    expect(result.purged).toBe(0);

    const read = await operator.downloadBlob(blob.hash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(blob.data);
    expect(existsSync(diskPath(server, blob.hash))).toBe(true);
    expect((await working.getItem(itemId)).status).toBe(200);
    // The report no longer holds it, and a later run keeps it too.
    expect(await reported()).not.toContain(blob.hash);
    await runJob(operator, "blob-orphans");
    expect((await operator.downloadBlob(blob.hash)).status).toBe(200);
  });
});
