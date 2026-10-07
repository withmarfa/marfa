import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  DISK_ONLY,
  runJob,
} from "../../utils/own-blob-server.js";

/**
 * What a queued, running or ended property-update job does to the orphan
 * report, on a server of the fixture's own that keeps its bytes on one disk.
 *
 * **Why a server of its own.** The grace is zero, so the run after a report
 * purges, and the run's shared server runs the sweep for every file: a run
 * another file asks for between this file's report and its next step would
 * purge the blob or report it again. The sweep's first run on its own clock
 * comes thirty seconds after boot, so `beforeAll` runs it once, which moves
 * the next one a day away.
 */
let server: FreshServer | undefined;
let operator: MarfaClient;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("blob-store-jobs", {
    ...DISK_ONLY,
    MARFA_BLOB_CLEANUP_GRACE_MS: "0",
  });
  ({ operator, working } = clientsFor(server));
  await runJob(operator, "blob-orphans");
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function upload(words: string): Promise<string> {
  const res = await working.uploadBlob(bytesOf(words, 100), "text/plain");
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data.hash;
}

async function reported(): Promise<string[]> {
  const res = await operator.listBlobOrphans();
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data.data.map((row) => row.hash);
}

/** A filter that matches no item, so a job over it ends having changed
 *  nothing. */
function matchesNothing(): { tags: string[] } {
  return { tags: [`no-item-carries-this-${crypto.randomUUID()}`] };
}

describe("a property-update job and the orphan report", () => {
  it("lifts the report when an update_properties job naming the digest is enqueued", async () => {
    const hash = await upload("named by a job's patch");
    await runJob(operator, "blob-orphans");
    expect(await reported()).toContain(hash);

    // The witness: a digest in the job's filter is no reference, so the
    // report stands through an enqueued job that holds it there.
    const inFilter = await working.bulkAction({
      action: "update_properties",
      patch: { note: "no digest here" },
      filter: { tags: [hash] },
    });
    expect(inFilter.status, JSON.stringify(inFilter.error)).toBe(202);
    expect(await reported()).toContain(hash);

    const queued = await working.bulkAction({
      action: "update_properties",
      patch: { outer: { inner: [{ cover: hash }] } },
      filter: matchesNothing(),
    });
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    expect(await reported()).not.toContain(hash);
  });
});
