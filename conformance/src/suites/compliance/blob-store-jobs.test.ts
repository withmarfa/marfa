import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BulkActionInput } from "../../client/types.js";
import { HOLD, queue } from "../../utils/bulk-jobs.js";
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

  describe("queued behind a job the worker has taken and not begun", () => {
    afterEach(async () => {
      await server!.clearFault();
    });

    /** Enqueues a job over no item and waits until the worker has taken it.
     *  The target holds the worker there until the fault is cleared, so a job
     *  queued meanwhile stays queued. */
    async function holdTheWorker(): Promise<string> {
      await server!.setFault(HOLD.claimed);
      const id = await queue(working, {
        action: "update_properties",
        patch: { note: "held by the first job" },
        filter: matchesNothing(),
      });
      await server!.waitForHold(HOLD.claimed);
      expect((await working.bulkActionStatus(id)).data.status).toBe(
        "in_progress",
      );
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
      await server!.clearFault();
      expect((await operator.pollBulkActionToTerminal(id)).status).toBe(
        "completed",
      );
    }

    it("reports a blob afresh once a queued job naming it is canceled", async () => {
      const hash = await upload("named by a job that is canceled");
      await runJob(operator, "blob-orphans");
      expect(await reported()).toContain(hash);

      const first = await holdTheWorker();
      const queued = await working.bulkAction({
        action: "update_properties",
        patch: { cover: hash },
        filter: matchesNothing(),
      });
      expect(queued.status, JSON.stringify(queued.error)).toBe(202);
      const id = (queued.data as { id: string }).id;
      expect((await statusOf(id)).status).toBe("queued");
      expect((await statusOf(first)).status).toBe("in_progress");

      const canceled = await working.bulkActionCancel(id);
      expect(canceled.status, JSON.stringify(canceled.error)).toBe(200);
      expect((await statusOf(id)).status).toBe("canceled");
      // Still held up behind the first job: the cancel ended a job that had
      // not started.
      expect((await statusOf(first)).status).toBe("in_progress");

      await release(first);
      await reportedAfterEnd(hash, "canceled");
    }, 60_000);

    it("reports a blob afresh once a queued job naming it fails", async () => {
      const hash = await upload("named by a job that fails");
      await runJob(operator, "blob-orphans");
      expect(await reported()).toContain(hash);

      const minted = await working.createKey({
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

      const first = await holdTheWorker();
      const queued = await queuer.bulkAction({
        action: "update_properties",
        patch: { cover: hash },
        filter: { tags: [own] },
      });
      expect(queued.status, JSON.stringify(queued.error)).toBe(202);
      const id = (queued.data as { id: string }).id;
      expect((await statusOf(id)).status).toBe("queued");
      expect((await statusOf(first)).status).toBe("in_progress");

      // The witness: a job whose key is gone but which has not yet run
      // still holds the blob, so it is the job's end that lifts the hold.
      const revoked = await operator.revokeKey(minted.data.id);
      expect(revoked.status, JSON.stringify(revoked.error)).toBe(200);
      expect((await statusOf(id)).status).toBe("queued");
      expect(await reported()).not.toContain(hash);

      // Freeing the worker lets it reach the job, which it ends `failed`
      // without writing: the key that queued it no longer authenticates.
      await release(first);
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

/** Where a job that has not ended is. */
type Stage = "queued" | "in progress";
const STAGES: readonly Stage[] = ["queued", "in progress"];

type PropertyUpdate = Extract<BulkActionInput, { action: "update_properties" }>;

describe("a property-update job that has not ended", () => {
  const queuedHere: string[] = [];

  afterEach(async () => {
    await server!.clearFault();
    for (const id of queuedHere.splice(0)) {
      await operator.pollBulkActionToTerminal(id);
    }
  });

  /**
   * Leaves a job holding `input` where `stage` says. The target holds the
   * worker at the start of the first job it takes: that job is the one
   * asked about when the stage is `in progress`, and one that matches
   * nothing, with the asked-about job behind it, when it is `queued`.
   */
  async function holdJob(stage: Stage, input: PropertyUpdate): Promise<string> {
    await server!.setFault(HOLD.claimed);
    if (stage === "queued") {
      queuedHere.push(
        await queue(working, {
          action: "update_properties",
          patch: { note: "ahead of the job asked about" },
          filter: matchesNothing(),
        }),
      );
      await server!.waitForHold(HOLD.claimed);
    }
    const id = await queue(working, input);
    queuedHere.push(id);
    if (stage === "in progress") await server!.waitForHold(HOLD.claimed);
    const read = (await working.bulkActionStatus(id)).data.status;
    expect(read).toBe(stage === "queued" ? "queued" : "in_progress");
    return id;
  }

  /** Lets the held jobs end. */
  async function end(): Promise<void> {
    await server!.clearFault();
    for (const id of queuedHere) {
      expect((await operator.pollBulkActionToTerminal(id)).status).toBe(
        "completed",
      );
    }
  }

  /**
   * One run reports a blob nothing references and the next purges it, so two
   * runs are what a blob must outlast to be kept.
   */
  async function sweepsTwice(): Promise<void> {
    await runJob(operator, "blob-orphans");
    await runJob(operator, "blob-orphans");
  }

  const SHAPES: [string, (hash: string) => Record<string, unknown>][] = [
    ["a string at the top of the patch", (hash) => ({ cover: hash })],
    [
      "a string in objects and arrays",
      (hash) => ({ outer: { inner: [{ cover: hash }] } }),
    ],
    ["a string in an array", (hash) => ({ covers: [hash] })],
    [
      "a link inside a longer text",
      (hash) => ({ body: `a note with ![a cover](${hash}) in it` }),
    ],
  ];

  const FILTERS: [
    string,
    (hash: string) => Record<string, string | string[]>,
  ][] = [
    ["its filter's tags", (hash: string) => ({ tags: [hash] })],
    ["its filter's source", (hash: string) => ({ source: hash })],
  ];

  describe.each(STAGES)("%s", (stage) => {
    it.each(SHAPES)(
      "keeps a blob the patch names as %s",
      async (_shape, patch) => {
        const hash = await upload(`named by a patch, ${stage}`);
        await runJob(operator, "blob-orphans");
        expect(await reported()).toContain(hash);

        await holdJob(stage, {
          action: "update_properties",
          patch: patch(hash),
          filter: matchesNothing(),
        });
        expect(await reported()).not.toContain(hash);
        await sweepsTwice();
        expect(await reported()).not.toContain(hash);
        expect((await operator.downloadBlob(hash)).status).toBe(200);

        // The witness: once the job ends its patch holds nothing, and the
        // same two runs report the blob and purge it.
        await end();
        await reportedAfterEnd(hash, stage);
      },
      60_000,
    );

    it.each(FILTERS)(
      "does not count a digest in %s as a reference",
      async (_input, filter) => {
        const hash = await upload(`named by a filter, ${stage}`);
        await runJob(operator, "blob-orphans");
        expect(await reported()).toContain(hash);

        await holdJob(stage, {
          action: "update_properties",
          patch: { note: "no digest here" },
          filter: filter(hash),
        });
        // The report stands through the job, and the next run purges.
        expect(await reported()).toContain(hash);
        await runJob(operator, "blob-orphans");
        expect((await operator.downloadBlob(hash)).status).toBe(404);
        await end();
      },
      60_000,
    );

    it("serves the blob its patch names to no key that did not already hold the bytes", async () => {
      const hash = await upload(`retained and not lent, ${stage}`);
      const reader = await working.createKey({
        label: `blob-store-jobs-reader-${stage.replace(" ", "-")}`,
        source: `blob-store-jobs-reader-${stage.replace(" ", "-")}`,
        type_permissions: { "core.file": "read" },
      });
      expect(reader.status, JSON.stringify(reader.error)).toBe(201);
      const other = new MarfaClient({
        baseUrl: server!.apiUrl,
        apiKey: reader.data.key,
      });

      await holdJob(stage, {
        action: "update_properties",
        patch: { cover: hash },
        filter: matchesNothing(),
      });
      // The uploader included: the uploader holds the bytes already, and no
      // row names them.
      expect(await readingDoors(working, hash)).toEqual(UNKNOWN);
      expect(await readingDoors(other, hash)).toEqual(UNKNOWN);

      // The witness: a row naming the blob lends it through the same doors
      // to the same two keys.
      const file = await working.createItem({
        type: "core.file",
        source: "blob-store-jobs",
        properties: { blob_ref: hash, mime_type: "text/plain", title: "lent" },
      });
      expect(file.status, JSON.stringify(file.error)).toBe(201);
      expect(await readingDoors(working, hash)).toEqual(SERVED);
      expect(await readingDoors(other, hash)).toEqual(SERVED);
      await end();
    }, 60_000);
  });
});

/** Each reading door's status and error code for one credential. */
async function readingDoors(
  reader: MarfaClient,
  hash: string,
): Promise<Record<string, [number, string | undefined]>> {
  const bytes = await reader.downloadBlob(hash);
  const head = await reader.headBlob(hash);
  const link = await reader.getBlobUrl(hash);
  const locations = await reader.listBlobLocations(hash);
  return {
    bytes: [bytes.status, bytes.error?.error.code],
    // A HEAD answer has no body to carry a code.
    head: [head.status, undefined],
    link: [link.status, link.error?.error.code],
    locations: [locations.status, locations.error?.error.code],
  };
}

const UNKNOWN = {
  bytes: [404, "blob_not_found"],
  head: [404, undefined],
  link: [404, "blob_not_found"],
  locations: [404, "blob_not_found"],
};

const SERVED = {
  bytes: [200, undefined],
  head: [200, undefined],
  link: [200, undefined],
  locations: [200, undefined],
};

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
