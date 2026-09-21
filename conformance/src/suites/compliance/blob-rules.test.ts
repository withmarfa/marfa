import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
  trackItem,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let operator: MarfaClient;

/** One of the values the run booted the server with. A run without it was
 *  booted without `pnpm marfa:up` or `pnpm garage:up`, which is a failure
 *  here rather than a skip. */
function bootEnv(name: "MARFA_API_URL" | "MARFA_BLOB_PATH" | "S3_ENDPOINT") {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required for the copy-rule fixtures: source the env files \`pnpm marfa:up\` and \`pnpm garage:up\` write.`,
    );
  }
  return value;
}

/**
 * Runs a housekeeping job through its door and answers the run's result.
 * The server this fixture shares runs the same housekeeping jobs on its
 * own schedule,
 * and an upload wakes replication, so a run asked for while the scheduler
 * holds the name answers 409; the in-flight run is the same work, and the
 * ask is repeated once it has finished.
 */
async function run<T>(name: string): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const res = await operator.runHousekeeping(name);
    if (res.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    expect(res.status, `${name}: ${JSON.stringify(res.error)}`).toBe(200);
    expect(res.data.outcome, res.data.error ?? "").toBe("ok");
    return res.data.result as T;
  }
  throw new Error(`${name} was held by a run for five seconds`);
}

/** Replicates until no store lacks a blob, bounded so a sweep that never
 *  drains fails the test rather than hanging it. */
async function replicateToZero(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const result = await run<{ remaining: number }>("blob-replicate");
    if (result.remaining === 0) return;
  }
  throw new Error("blob-replicate never reached remaining: 0");
}

/** Checks until the predicate holds of the blob's locations, bounded the
 *  same way: one run checks a bounded batch, least recently checked first,
 *  and this blob's copies may not be in it. */
async function checkUntil(
  hash: string,
  done: (locations: LocationRow[]) => boolean,
): Promise<LocationRow[]> {
  let locations: LocationRow[] = [];
  for (let i = 0; i < 20; i++) {
    await run("blob-integrity");
    locations = (await client.listBlobLocations(hash)).data.data;
    if (done(locations)) return locations;
  }
  throw new Error(
    `blob-integrity never reached the expected state for ${hash}: ${JSON.stringify(locations)}`,
  );
}

interface LocationRow {
  store_id: string;
  kind: "disk" | "s3";
  verified_at: string | null;
}

function kinds(locations: readonly { kind: string }[]): string[] {
  return locations.map((location) => location.kind).sort();
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Where the referee's own server keeps a disk copy: the store the run
 *  booted, in a directory named by the hex's first four characters. */
function diskPathFor(hash: string): string {
  const hex = hash.slice("sha256:".length);
  return join(bootEnv("MARFA_BLOB_PATH"), hex.slice(0, 4), hex);
}

/** This run's own bytes, so a state directory reused across runs holds no
 *  earlier copy, row or audit entry for them. */
function text(words: string): string {
  return `${words} ${ctx.runId}`;
}

async function uploadText(words: string) {
  const upload = await client.uploadBlob(
    new TextEncoder().encode(text(words)),
    "text/plain",
  );
  expect(upload.ok, JSON.stringify(upload.error)).toBe(true);
  return upload.data.hash;
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "blob-rules"));
  operator = getOperatorClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("the rules that keep a blob's bytes", () => {
  it("replicates every blob to the object store and records the copies, and the link becomes the store's own", async () => {
    const hashes = [];
    for (const word of ["one", "two", "three"]) {
      hashes.push(await uploadText(`replicated ${word}`));
    }
    // A run answers what it did, and the last one has nothing left.
    let result = { copied: -1, bytes: -1, remaining: -1 };
    for (let i = 0; i < 20 && result.remaining !== 0; i++) {
      result = await run<{ copied: number; bytes: number; remaining: number }>(
        "blob-replicate",
      );
      expect(result.copied).toBeGreaterThanOrEqual(0);
      expect(result.bytes).toBeGreaterThanOrEqual(0);
    }
    expect(result.remaining).toBe(0);

    const stores = await operator.listBlobStores();
    const s3 = stores.data.data.find((store) => store.kind === "s3")!;
    for (const hash of hashes) {
      const locations = (await client.listBlobLocations(hash)).data.data;
      expect(kinds(locations)).toEqual(["disk", "s3"]);
      const copy = locations.find((location) => location.kind === "s3");
      expect(copy?.store_id).toBe(s3.id);
      expect(Date.parse(copy?.recorded_at ?? "")).not.toBeNaN();
    }
    // The link is the object store's own: its host is the store's, not the
    // instance's, and it fetches the bytes with no credential.
    const first = hashes[0]!;
    const link = await client.getBlobUrl(first);
    expect(link.status).toBe(200);
    expect(new URL(link.data.url).host).toBe(
      new URL(bootEnv("S3_ENDPOINT")).host,
    );
    const fetched = await fetch(link.data.url);
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(
      new TextEncoder().encode(text("replicated one")),
    );
    // The witness for the preference: with the object store's copy dropped
    // the link is the instance's own again (its host the instance's, and
    // it still fetches), and replication makes it the store's once more.
    // Through the drop door rather than the instant after an upload,
    // because the server's own scheduler replicates an upload within a
    // second of it.
    expect((await operator.dropBlobLocation(first, s3.id)).status).toBe(200);
    const served = await client.getBlobUrl(first);
    expect(served.status).toBe(200);
    expect(new URL(served.data.url).host).toBe(
      new URL(bootEnv("MARFA_API_URL")).host,
    );
    const fetchedFromInstance = await fetch(served.data.url);
    expect(fetchedFromInstance.status).toBe(200);
    expect(new Uint8Array(await fetchedFromInstance.arrayBuffer())).toEqual(
      new TextEncoder().encode(text("replicated one")),
    );
    await replicateToZero();
    expect(new URL((await client.getBlobUrl(first)).data.url).host).toBe(
      new URL(bootEnv("S3_ENDPOINT")).host,
    );
  });

  it("drops a copy while the minimum holds and refuses the drop that would break it", async () => {
    const hash = await uploadText("two copies, then one");
    await replicateToZero();
    const stores = await operator.listBlobStores();
    await expectMatchesSchema("GET", "/blobs/stores", 200, stores.data);
    expect(stores.data.min_copies).toBe(1);
    const s3 = stores.data.data.find((store) => store.kind === "s3")!;
    const disk = stores.data.data.find((store) => store.kind === "disk")!;
    expect(kinds((await client.listBlobLocations(hash)).data.data)).toEqual([
      "disk",
      "s3",
    ]);

    // Two copies: a working key is refused the drop the minimum would
    // allow, and the copy stays; the operator's drop takes the object
    // store's copy, bytes and row, which replication then puts back.
    const workingFirst = await client.dropBlobLocation(hash, s3.id);
    expect(workingFirst.status).toBe(403);
    expect(workingFirst.error?.error.code).toBe("forbidden");
    expect(kinds((await client.listBlobLocations(hash)).data.data)).toEqual([
      "disk",
      "s3",
    ]);
    const dropped = await operator.dropBlobLocation(hash, s3.id);
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    await expectMatchesSchema(
      "DELETE",
      "/blobs/{hash}/locations/{store}",
      200,
      dropped.data,
    );
    expect(kinds((await client.listBlobLocations(hash)).data.data)).toEqual([
      "disk",
    ]);
    await replicateToZero();
    expect(kinds((await client.listBlobLocations(hash)).data.data)).toEqual([
      "disk",
      "s3",
    ]);

    // One copy left after the next drop: the last is refused and the
    // bytes still answer.
    expect((await operator.dropBlobLocation(hash, s3.id)).status).toBe(200);
    const refused = await operator.dropBlobLocation(hash, disk.id);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("copies_below_minimum");
    expect(kinds((await client.listBlobLocations(hash)).data.data)).toEqual([
      "disk",
    ]);
    expect((await client.downloadBlob(hash)).status).toBe(200);

    // A store that no longer holds a copy, one that is not attached, and a
    // working key.
    const nowhere = await operator.dropBlobLocation(hash, s3.id);
    expect(nowhere.status).toBe(404);
    expect(nowhere.error?.error.code).toBe("blob_location_not_found");
    const unattached = await operator.dropBlobLocation(hash, "no-such-store");
    expect(unattached.status).toBe(404);
    expect(unattached.error?.error.code).toBe("blob_location_not_found");
  });

  it("stamps a good copy and strikes a corrupt one, which replication then restores", async () => {
    const content = text("checked, corrupted, restored");
    const hash = await uploadText("checked, corrupted, restored");
    const missing = await uploadText("checked, removed, restored");
    await replicateToZero();
    // A check over sound pairs stamps every copy and strikes none.
    for (const each of [hash, missing]) {
      const stamped = await checkUntil(
        each,
        (locations) =>
          locations.length === 2 &&
          locations.every((location) => location.verified_at !== null),
      );
      expect(kinds(stamped)).toEqual(["disk", "s3"]);
    }
    const before = await client.listAudit({
      action: "blob.copy_struck",
      resource_id: hash,
    });
    expect(before.data.data).toHaveLength(0);

    // The disk copy overwritten under the referee's own server, at its own
    // length so only the digest can tell, and another's removed: the check
    // strikes both with an audit row each, replication brings the right
    // bytes back from the object store, and the download reads them.
    writeFileSync(diskPathFor(hash), content.replace("corrupted", "CORRUPTED"));
    unlinkSync(diskPathFor(missing));
    for (const each of [hash, missing]) {
      const struck = await checkUntil(
        each,
        (locations) => !locations.some((location) => location.kind === "disk"),
      );
      expect(kinds(struck)).toEqual(["s3"]);
      const audited = await client.listAudit({
        action: "blob.copy_struck",
        resource_id: each,
      });
      expect(audited.status).toBe(200);
      expect(audited.data.data).toHaveLength(1);
    }

    await replicateToZero();
    for (const each of [hash, missing]) {
      expect(kinds((await client.listBlobLocations(each)).data.data)).toEqual([
        "disk",
        "s3",
      ]);
      expect(sha256(readFileSync(diskPathFor(each)))).toBe(each);
    }
    const download = await client.downloadBlob(hash);
    expect(download.status).toBe(200);
    expect(new Uint8Array(download.data)).toEqual(
      new TextEncoder().encode(content),
    );
  });

  it("reports an unreferenced blob on one run and purges it on the next, never one an item names", async () => {
    const orphan = await uploadText("nothing names me");
    const kept = await uploadText("an item names me");
    const late = await uploadText("an item names me after the report");
    const item = await client.createItem({
      type: "core.file",
      source: ctx.source,
      properties: { blob_ref: kept, mime_type: "text/plain" },
    });
    expect(item.ok, JSON.stringify(item.error)).toBe(true);
    trackItem(ctx, item.data.item.id);

    await run("blob-orphans");
    const report = await operator.listBlobOrphans();
    expect(report.status).toBe(200);
    await expectMatchesSchema("GET", "/blobs/orphans", 200, report.data);
    const reported = report.data.data.map((row) => row.hash);
    expect(reported).toContain(orphan);
    expect(reported).toContain(late);
    expect(reported).not.toContain(kept);
    expect(report.data.data.find((row) => row.hash === orphan)).toMatchObject({
      mime_type: "text/plain",
      size_bytes: text("nothing names me").length,
    });
    // Reported is not deleted: the bytes still answer.
    expect((await client.downloadBlob(orphan)).status).toBe(200);

    // A reported blob an item names before the next run leaves the report
    // and stays; the one still unreferenced goes.
    const lateItem = await client.createItem({
      type: "core.file",
      source: ctx.source,
      properties: { blob_ref: late, mime_type: "text/plain" },
    });
    expect(lateItem.ok, JSON.stringify(lateItem.error)).toBe(true);
    trackItem(ctx, lateItem.data.item.id);
    await run("blob-orphans");
    expect((await client.downloadBlob(orphan)).status).toBe(404);
    expect((await client.downloadBlob(kept)).status).toBe(200);
    expect((await client.downloadBlob(late)).status).toBe(200);
    const after = (await operator.listBlobOrphans()).data.data.map(
      (row) => row.hash,
    );
    expect(after).not.toContain(orphan);
    expect(after).not.toContain(late);
    const working = await client.listBlobOrphans();
    expect(working.status).toBe(403);
    expect(working.error?.error.code).toBe("forbidden");
  });
});
