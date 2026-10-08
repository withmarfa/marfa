import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { createHash } from "node:crypto";
import {
  bytesOf,
  clientsFor,
  DISK_ONLY,
  runJob,
} from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What a queued, running or ended property-update job does to the orphan
 * report, on a server of the fixture's own that keeps its bytes on one disk.
 *
 * **Why a server of its own.** The grace is zero, so the run after a report
 * purges, and the run's shared server runs the sweep for every file: a run
 * another file asks for between this file's report and its next step would
 * purge the blob or report it again. The sweep's first run on its own clock
 * comes thirty seconds after boot, and a run asked for earlier leaves that
 * time where it was, so `beforeAll` waits for that first run to set the next
 * one a day away.
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

describe("a property-update job that has ended", () => {
  /** The run after a report purges, so this answers what became of the
   *  bytes once the job could no longer hold them. */
  async function reportedAfterEnd(hash: string, ended: string) {
    expect(await reported(), ended).not.toContain(hash);
    await runJob(operator, "blob-orphans");
    expect(await reported(), ended).toContain(hash);
    expect((await operator.downloadBlob(hash)).status, ended).toBe(200);
    await runJob(operator, "blob-orphans");
    expect((await operator.downloadBlob(hash)).status, ended).toBe(404);
  }

  it("reports a blob afresh once the job whose patch named it ends", async () => {
    const hash = await upload("named by a job that completes");
    await runJob(operator, "blob-orphans");
    expect(await reported()).toContain(hash);

    const queued = await working.bulkAction({
      action: "update_properties",
      patch: { cover: hash },
      filter: matchesNothing(),
    });
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const job = await working.pollBulkActionToTerminal(
      (queued.data as { id: string }).id,
    );
    expect(job.status).toBe("completed");

    await reportedAfterEnd(hash, "completed");
  });

  describe("queued behind a job that holds the worker", () => {
    /**
     * The bulk worker runs one job at a time, in chunks of a hundred items,
     * so a job over this many items holds it for seconds, where a request
     * takes milliseconds.
     */
    const HELD_ITEMS = 5000;
    let tag: string;

    beforeAll(async () => {
      tag = `holds-the-worker-${crypto.randomUUID()}`;
      for (let from = 0; from < HELD_ITEMS; from += 2500) {
        const created = await working.bulkItems({
          atomic: false,
          items: Array.from({ length: 2500 }, (_, i) => ({
            type: "core.note",
            source: "blob-store-jobs",
            properties: { body: `held ${String(from + i)}` },
            tags: [tag],
          })),
        });
        expect(created.status, JSON.stringify(created.error)).toBe(200);
      }
    }, 120_000);

    /** Enqueues the job over every item the tag matches and waits until
     *  the worker has taken it and not yet finished it. */
    async function holdTheWorker(): Promise<string> {
      const queued = await working.bulkAction({
        action: "update_properties",
        patch: { note: "held by the long job" },
        filter: { tags: [tag] },
      });
      expect(queued.status, JSON.stringify(queued.error)).toBe(202);
      const id = (queued.data as { id: string }).id;
      await waitFor("the worker to take the long job", async () => {
        const job = (await working.bulkActionStatus(id)).data;
        expect(job.status, job.error ?? "").not.toBe("completed");
        return job.status === "in_progress" ? job : undefined;
      });
      return id;
    }

    /** Read as the operator, which may read any job, so a job whose key is
     *  revoked can still be asked about. */
    async function statusOf(id: string) {
      const res = await operator.bulkActionStatus(id);
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      return res.data;
    }

    async function release(id: string): Promise<void> {
      expect((await working.bulkActionCancel(id)).status).toBe(200);
      expect((await operator.pollBulkActionToTerminal(id)).status).toBe(
        "canceled",
      );
    }

    it("reports a blob afresh once a queued job naming it is canceled", async () => {
      const hash = await upload("named by a job that is canceled");
      await runJob(operator, "blob-orphans");
      expect(await reported()).toContain(hash);

      const long = await holdTheWorker();
      const queued = await working.bulkAction({
        action: "update_properties",
        patch: { cover: hash },
        filter: matchesNothing(),
      });
      expect(queued.status, JSON.stringify(queued.error)).toBe(202);
      const id = (queued.data as { id: string }).id;
      expect((await statusOf(id)).status).toBe("queued");
      expect((await statusOf(long)).status).toBe("in_progress");

      const canceled = await working.bulkActionCancel(id);
      expect(canceled.status, JSON.stringify(canceled.error)).toBe(200);
      expect((await statusOf(id)).status).toBe("canceled");
      // Still held up behind the long job: the cancel ended a job that had
      // not started.
      expect((await statusOf(long)).status).toBe("in_progress");

      await release(long);
      await reportedAfterEnd(hash, "canceled");
    }, 60_000);

    it("reports a blob afresh once a queued job naming it fails", async () => {
      const hash = await upload("named by a job that fails");
      await runJob(operator, "blob-orphans");
      expect(await reported()).toContain(hash);

      const minted = await operator.createKey({
        label: "blob-store-jobs-queued",
        source: "blob-store-jobs-queued",
      });
      expect(minted.status, JSON.stringify(minted.error)).toBe(201);
      const queuer = new MarfaClient({
        baseUrl: server!.apiUrl,
        apiKey: minted.data.key,
      });

      // The credential is asked after the job's first chunk begins, and a
      // job matching no item has none, so this one matches a single note.
      const own = `awaits-its-first-chunk-${crypto.randomUUID()}`;
      const note = await working.createItem({
        type: "core.note",
        source: "blob-store-jobs",
        properties: { body: "left as it was" },
        tags: [own],
      });
      expect(note.status, JSON.stringify(note.error)).toBe(201);

      const long = await holdTheWorker();
      const queued = await queuer.bulkAction({
        action: "update_properties",
        patch: { cover: hash },
        filter: { tags: [own] },
      });
      expect(queued.status, JSON.stringify(queued.error)).toBe(202);
      const id = (queued.data as { id: string }).id;
      expect((await statusOf(id)).status).toBe("queued");
      expect((await statusOf(long)).status).toBe("in_progress");

      // The witness: a job whose key is gone but which has not yet run
      // still holds the blob, so it is the job's end that lifts the hold.
      const revoked = await operator.revokeKey(minted.data.id);
      expect(revoked.status, JSON.stringify(revoked.error)).toBe(200);
      expect((await statusOf(id)).status).toBe("queued");
      expect(await reported()).not.toContain(hash);

      // Freeing the worker lets it reach the job, which it ends `failed`
      // without writing: the key that queued it no longer authenticates.
      await release(long);
      const job = await operator.pollBulkActionToTerminal(id);
      expect(job.status).toBe("failed");
      expect(job.error).toMatch(/no longer authenticates/);
      expect(
        (await working.getItem(note.data.item.id)).data.item.properties,
      ).toEqual({ body: "left as it was" });

      await reportedAfterEnd(hash, "failed");
    }, 60_000);
  });
});

describe("a property-update job whose patch names a digest no blob holds", () => {
  it("completes a job whose patch names a digest no blob holds", async () => {
    const unknown = `sha256:${createHash("sha256")
      .update(`held by no blob ${crypto.randomUUID()}`)
      .digest("hex")}`;
    // The witness: the registry holds no blob under the name.
    expect((await operator.downloadBlob(unknown)).status).toBe(404);

    const tag = `holds-an-unknown-digest-${crypto.randomUUID()}`;
    const note = await working.createItem({
      type: "core.note",
      source: "blob-store-jobs",
      properties: { body: "waiting for a digest" },
      tags: [tag],
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);

    const queued = await working.bulkAction({
      action: "update_properties",
      patch: { body: unknown },
      filter: { tags: [tag] },
    });
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const job = await working.pollBulkActionToTerminal(
      (queued.data as { id: string }).id,
    );
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.result).toMatchObject({ matched: 1, succeeded: 1, errored: 0 });
    expect(
      (await working.getItem(note.data.item.id)).data.item.properties.body,
    ).toBe(unknown);
  });
});
