import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  leaveBacklog,
  ownObjectStore,
  replicationIdle,
  runJob,
} from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What `blob-integrity` and `blob-replicate` do when a store does not answer,
 * on a server of the fixture's own that keeps its bytes on a disk and in the
 * run's object store. The `hold:blob-has` and `hold:blob-read` faults
 * (`conformance/README.md`, "Faults") make every store hang before it
 * answers whether it holds a blob or opens its bytes, until the fault is
 * cleared or the server gives the request up, and `store-check-deadline`
 * shortens how long the server waits for an answer, so a case tests the
 * bound rather than waiting out its 15 seconds.
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

/** A blob in both stores, referenced so that nothing purges it. */
async function replicated(words: string): Promise<string> {
  const upload = await working.uploadBlob(bytesOf(words, 120), "text/plain");
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
