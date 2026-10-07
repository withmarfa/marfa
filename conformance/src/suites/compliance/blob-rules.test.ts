import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
import { uploadReferenced } from "../../utils/blobs.js";
import { waitFor } from "../../utils/wait.js";

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
 * The server this fixture shares runs the same housekeeping jobs on its own
 * schedule,
 * and an upload wakes replication, so a run asked for while the scheduler
 * holds the name answers 409; the in-flight run is the same work, and the
 * ask is repeated once it has finished.
 */
async function run<T>(name: string): Promise<T> {
  return (await runRecorded<T>(name)).result;
}

/** A run as the door answered it: its result, and when it started and
 *  finished. */
async function runRecorded<T>(
  name: string,
): Promise<{ result: T; started_at: string; finished_at: string }> {
  for (let i = 0; i < 50; i++) {
    const res = await operator.runHousekeeping(name);
    if (res.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    expect(res.status, `${name}: ${JSON.stringify(res.error)}`).toBe(200);
    expect(res.data.outcome, res.data.error ?? "").toBe("ok");
    return {
      result: res.data.result as T,
      started_at: res.data.started_at,
      finished_at: res.data.finished_at,
    };
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

/** This run's own bytes, named by a note so the suite's key reads them. */
async function uploadReferencedText(words: string) {
  const upload = await uploadReferenced(
    client,
    ctx,
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
      hashes.push(await uploadReferencedText(`replicated ${word}`));
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
    expect((await operator.deleteBlobLocation(first, s3.id)).status).toBe(200);
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

  it("answers a dead store link with the store's own status, not the instance's", async () => {
    // A dead link gets its signer's status, and there are two signers: the
    // instance (`blobs/link-instance-altered`) and the object store once it
    // holds the blob (`blobs/link-store-altered`), whose link the instance
    // never sees fetched. This is the store's half, taken here because this
    // file provably holds a store-signed link. In
    // `correctness/blob-correctness.test.ts` the replication scheduler
    // decides which signer answered, within a second of the upload, so
    // which status that case measures is a race.
    const hash = await uploadReferencedText("a link that dies");
    await replicateToZero();
    const link = await client.getBlobUrl(hash);
    expect(link.status).toBe(200);
    const url = new URL(link.data.url);
    expect(url.host).toBe(new URL(bootEnv("S3_ENDPOINT")).host);

    // The witness: the link works before it is altered, so the refusal
    // below is about the alteration and not about a link that was never
    // going to fetch.
    const before = await fetch(url);
    expect(before.status).toBe(200);
    expect(new Uint8Array(await before.arrayBuffer())).toEqual(
      new TextEncoder().encode(text("a link that dies")),
    );

    const altered = new URL(url);
    const signature = altered.searchParams.get("X-Amz-Signature");
    expect(
      signature,
      "the store's link carries no SigV4 signature to alter",
    ).toBeTruthy();
    altered.searchParams.set(
      "X-Amz-Signature",
      `${(signature ?? "").slice(0, -1)}${(signature ?? "").endsWith("0") ? "1" : "0"}`,
    );
    const dead = await fetch(altered);
    expect(dead.status).toBe(403);
    expect(new Uint8Array(await dead.arrayBuffer())).not.toEqual(
      new TextEncoder().encode(text("a link that dies")),
    );
  });

  it("drops a copy while the minimum holds and refuses the drop that would break it", async () => {
    const hash = await uploadReferencedText("two copies, then one");
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
    const workingFirst = await client.deleteBlobLocation(hash, s3.id);
    expect(workingFirst.status).toBe(403);
    expect(workingFirst.error?.error.code).toBe("forbidden");
    expect(kinds((await client.listBlobLocations(hash)).data.data)).toEqual([
      "disk",
      "s3",
    ]);
    const dropped = await operator.deleteBlobLocation(hash, s3.id);
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
    expect((await operator.deleteBlobLocation(hash, s3.id)).status).toBe(200);
    const refused = await operator.deleteBlobLocation(hash, disk.id);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("copies_below_minimum");
    expect(kinds((await client.listBlobLocations(hash)).data.data)).toEqual([
      "disk",
    ]);
    expect((await client.downloadBlob(hash)).status).toBe(200);

    // A store that no longer holds a copy, one that is not attached, and a
    // working key.
    const nowhere = await operator.deleteBlobLocation(hash, s3.id);
    expect(nowhere.status).toBe(404);
    expect(nowhere.error?.error.code).toBe("blob_location_not_found");
    const unattached = await operator.deleteBlobLocation(hash, "no-such-store");
    expect(unattached.status).toBe(404);
    expect(unattached.error?.error.code).toBe("blob_location_not_found");
  });

  it("stamps a good copy and strikes a corrupt one, which replication then restores", async () => {
    const content = text("checked, corrupted, restored");
    const hash = await uploadReferencedText("checked, corrupted, restored");
    const missing = await uploadReferencedText("checked, removed, restored");
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
    //
    // The strike is read off the audit rows, not off the location log: a
    // strike wakes replication, which the server runs on its own poll, so
    // the struck location can be back before a listing sees it gone.
    writeFileSync(diskPathFor(hash), content.replace("corrupted", "CORRUPTED"));
    unlinkSync(diskPathFor(missing));
    const struckRows = async (each: string) =>
      (
        await client.listAudit({
          action: "blob.copy_struck",
          resource_id: each,
        })
      ).data.data;
    for (let i = 0; i < 20; i++) {
      await run("blob-integrity");
      if (
        (await struckRows(hash)).length === 1 &&
        (await struckRows(missing)).length === 1
      ) {
        break;
      }
    }
    for (const each of [hash, missing]) {
      const audited = await struckRows(each);
      expect(audited).toHaveLength(1);
      expect(audited[0]?.details).toMatchObject({ kind: "disk" });
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
    // Through the operator key, which reads every blob, so each status says
    // whether the bytes are held rather than whether a key may read them.
    // Reported is not deleted: the bytes still answer.
    expect((await operator.downloadBlob(orphan)).status).toBe(200);

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
    expect((await operator.downloadBlob(orphan)).status).toBe(404);
    expect((await operator.downloadBlob(kept)).status).toBe(200);
    expect((await operator.downloadBlob(late)).status).toBe(200);
    const after = (await operator.listBlobOrphans()).data.data.map(
      (row) => row.hash,
    );
    expect(after).not.toContain(orphan);
    expect(after).not.toContain(late);
    const working = await client.listBlobOrphans();
    expect(working.status).toBe(403);
    expect(working.error?.error.code).toBe("forbidden");
  });

  it("lifts the report on an upload of the same bytes, so the next run keeps them", async () => {
    const words = "uploaded, reported, uploaded again";
    const hash = await uploadText(words);
    await run("blob-orphans");
    const reported = (await operator.listBlobOrphans()).data.data.map(
      (row) => row.hash,
    );
    expect(reported).toContain(hash);

    // Sent again: the answer says the bytes are stored, and the report no
    // longer names them.
    expect(await uploadText(words)).toBe(hash);
    const lifted = (await operator.listBlobOrphans()).data.data.map(
      (row) => row.hash,
    );
    expect(lifted).not.toContain(hash);

    // The run that would have purged the earlier report reports them afresh
    // and keeps them.
    await run("blob-orphans");
    const kept = await operator.downloadBlob(hash);
    expect(kept.status).toBe(200);
    expect(new TextDecoder().decode(kept.data)).toBe(text(words));
    const again = (await operator.listBlobOrphans()).data.data.map(
      (row) => row.hash,
    );
    expect(again).toContain(hash);

    // Still named by nothing once the grace has passed since that report,
    // they go: the witness that the run above could have purged them.
    await run("blob-orphans");
    expect((await operator.downloadBlob(hash)).status).toBe(404);
  });

  it("lifts the report on a reference added and removed between runs", async () => {
    const hash = await uploadText("named, then unnamed, between runs");
    await run("blob-orphans");
    expect(
      (await operator.listBlobOrphans()).data.data.map((row) => row.hash),
    ).toContain(hash);

    // A file item names it, and the report lets it go at once.
    const file = await client.createItem({
      type: "core.file",
      source: ctx.source,
      properties: { blob_ref: hash, mime_type: "text/plain" },
    });
    expect(file.ok, JSON.stringify(file.error)).toBe(true);
    expect(
      (await operator.listBlobOrphans()).data.data.map((row) => row.hash),
    ).not.toContain(hash);
    const id = file.data.item.id;
    expect((await client.deleteItem(id)).status).toBe(200);
    const purged = await client.purgeItem(id);
    expect(purged.status, JSON.stringify(purged.error)).toBe(200);

    // Unnamed again, it waits a fresh grace rather than going on the old
    // report.
    await run("blob-orphans");
    expect((await operator.downloadBlob(hash)).status).toBe(200);
    await run("blob-orphans");
    expect((await operator.downloadBlob(hash)).status).toBe(404);
  });

  it("keeps a blob a note links in its body after the file item naming it is purged", async () => {
    // Two images, each named by a file item that is trashed and purged; a
    // note links only the first in its body. The second is the witness
    // that the purge left nothing else naming either.
    const linked = await uploadText("an image a note links in its body");
    const unlinked = await uploadText("an image nothing links any more");
    for (const hash of [linked, unlinked]) {
      const file = await client.createItem({
        type: "core.file",
        source: ctx.source,
        properties: { blob_ref: hash, mime_type: "text/plain" },
      });
      expect(file.ok, JSON.stringify(file.error)).toBe(true);
      const id = file.data.item.id;
      expect((await client.deleteItem(id)).status).toBe(200);
      const purged = await client.purgeItem(id);
      expect(purged.status, JSON.stringify(purged.error)).toBe(200);
    }
    const note = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: `A chart:\n\n![chart](${linked})\n` },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    trackItem(ctx, note.data.item.id);

    await run("blob-orphans");
    await run("blob-orphans");

    expect((await operator.downloadBlob(unlinked)).status).toBe(404);
    const download = await operator.downloadBlob(linked);
    expect(download.status).toBe(200);
    expect(new TextDecoder().decode(download.data)).toBe(
      text("an image a note links in its body"),
    );
  });

  it("keeps a blob named only in an edge's properties", async () => {
    const whole = await uploadText("an edge property is this hash");
    const linked = await uploadText("an edge property links this");
    const unreferenced = await uploadText("no edge or item names this");
    const ids: string[] = [];
    for (const body of ["one end", "the other end"]) {
      const note = await client.createItem({
        type: "core.note",
        source: ctx.source,
        properties: { body },
      });
      expect(note.ok, JSON.stringify(note.error)).toBe(true);
      trackItem(ctx, note.data.item.id);
      ids.push(note.data.item.id);
    }
    const edge = await client.createEdge({
      source_id: ids[0]!,
      target_id: ids[1]!,
      edge_type: "about",
      properties: { cover: whole, caption: `see ![it](${linked})` },
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);

    await run("blob-orphans");
    await run("blob-orphans");

    expect((await operator.downloadBlob(unreferenced)).status).toBe(404);
    expect((await operator.downloadBlob(whole)).status).toBe(200);
    expect((await operator.downloadBlob(linked)).status).toBe(200);
  });

  it("keeps a blob only an earlier version of an item names, and purges one nothing names", async () => {
    const inHistory = await uploadText("only an earlier version names this");
    const unnamed = await uploadText("no version names this");
    const note = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: `![it](${inHistory})` },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    trackItem(ctx, note.data.item.id);
    const moved = await client.updateItem(note.data.item.id, {
      properties: { body: "no longer links anything" },
      version: note.data.item.version,
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    const versions = await client.getVersions(note.data.item.id);
    expect(JSON.stringify(versions.data)).toContain(inHistory);

    await run("blob-orphans");
    await run("blob-orphans");

    // The witness: two runs purge a blob nothing names, so the one kept
    // was kept by its history.
    expect((await operator.downloadBlob(unnamed)).status).toBe(404);
    const kept = await operator.downloadBlob(inHistory);
    expect(kept.status).toBe(200);
    expect(new TextDecoder().decode(kept.data)).toBe(
      text("only an earlier version names this"),
    );
    const reported = (await operator.listBlobOrphans()).data.data.map(
      (row) => row.hash,
    );
    expect(reported).not.toContain(inHistory);
  });

  it("keeps the bytes of an upload that races the run that would purge them", async () => {
    // The witness: with no upload in the way, a reported blob is purged by
    // the next run, so the races below have something to lose.
    const idle = await uploadText("reported and left alone");
    await run("blob-orphans");
    await run("blob-orphans");
    expect((await operator.downloadBlob(idle)).status).toBe(404);

    for (let round = 0; round < 8; round++) {
      const words = `reported, then sent while the run purges, round ${String(round)}`;
      const hash = await uploadText(words);
      await run("blob-orphans");

      // Either order is allowed: the upload lands first and the run keeps
      // the bytes, or the run purges them and the upload stores them again.
      // A run the scheduler holds answers 409 and purges nothing.
      const [sent, swept] = await Promise.all([
        client.uploadBlob(new TextEncoder().encode(text(words)), "text/plain"),
        operator.runHousekeeping("blob-orphans"),
      ]);
      expect(sent.status, JSON.stringify(sent.error)).toBe(201);
      expect(sent.data.hash).toBe(hash);
      expect([200, 409]).toContain(swept.status);

      const read = await operator.downloadBlob(hash);
      expect(read.status, `round ${String(round)}`).toBe(200);
      expect(new TextDecoder().decode(read.data)).toBe(text(words));
    }
  });

  it("keeps the bytes a restore stores while a purge of them races it", async () => {
    // An archive that carries one file item and its bytes, taken before the
    // item is purged: nothing names the bytes afterwards, and a restore
    // brings both back.
    async function archiveThenPurge(words: string) {
      const since = new Date(Date.now() - 1).toISOString();
      const hash = await uploadText(words);
      const file = await client.createItem({
        type: "core.file",
        source: ctx.source,
        properties: { blob_ref: hash, mime_type: "text/plain" },
      });
      expect(file.ok, JSON.stringify(file.error)).toBe(true);
      const id = file.data.item.id;
      trackItem(ctx, id);
      const archive = await client.exportArchive({
        source: ctx.source,
        occurred_after: since,
      });
      expect(archive.status).toBe(200);
      expect((await client.deleteItem(id)).status).toBe(200);
      expect((await client.purgeItem(id)).status).toBe(200);
      return { hash, archive: archive.data };
    }

    // The witness: with no restore in the way, the report and the next run
    // purge the bytes, so the races below have something to lose.
    const idle = await archiveThenPurge("restorable and left alone");
    await run("blob-orphans");
    expect(
      (await operator.listBlobOrphans()).data.data.map((row) => row.hash),
    ).toContain(idle.hash);
    await run("blob-orphans");
    expect((await operator.downloadBlob(idle.hash)).status).toBe(404);

    for (let round = 0; round < 8; round++) {
      const words = `reported, then restored while the run purges, round ${String(round)}`;
      const { hash, archive } = await archiveThenPurge(words);
      await run("blob-orphans");
      expect(
        (await operator.listBlobOrphans()).data.data.map((row) => row.hash),
      ).toContain(hash);

      // Either order is allowed: the restore lands first and the run keeps
      // the bytes, or the run purges them and the restore stores them again.
      // A run the scheduler holds answers 409 and purges nothing.
      const [restored, swept] = await Promise.all([
        operator.restoreArchive(archive),
        operator.runHousekeeping("blob-orphans"),
      ]);
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.blobs_imported).toBe(1);
      expect([200, 409]).toContain(swept.status);

      const read = await operator.downloadBlob(hash);
      expect(read.status, `round ${String(round)}`).toBe(200);
      expect(new TextDecoder().decode(read.data)).toBe(text(words));
    }
  });

  it("answers a link to a blob the sweep has purged as an unknown blob", async () => {
    const hash = await uploadText("linked, then purged");
    const file = await client.createItem({
      type: "core.file",
      source: ctx.source,
      properties: { blob_ref: hash, mime_type: "text/plain" },
    });
    expect(file.ok, JSON.stringify(file.error)).toBe(true);
    // The link the instance serves itself, so it does not depend on the
    // object store's copy.
    for (const location of (await client.listBlobLocations(hash)).data.data) {
      if (location.kind !== "s3") continue;
      expect(
        (await operator.deleteBlobLocation(hash, location.store_id)).status,
      ).toBe(200);
    }
    const link = await client.getBlobUrl(hash, 3600);
    expect(link.status).toBe(200);
    expect(new URL(link.data.url).host).toBe(
      new URL(bootEnv("MARFA_API_URL")).host,
    );
    const witness = await fetch(link.data.url);
    expect(witness.status).toBe(200);
    await witness.arrayBuffer();

    const id = file.data.item.id;
    expect((await client.deleteItem(id)).status).toBe(200);
    expect((await client.purgeItem(id)).status).toBe(200);
    await run("blob-orphans");
    await run("blob-orphans");

    const gone = await fetch(link.data.url);
    expect(gone.status).toBe(404);
    const body = (await gone.json()) as { error: { code: string } };
    expect(body.error.code).toBe("blob_not_found");
  });
});

describe("what the orphan sweep keeps", () => {
  /** A file item naming the bytes, as the whole value of `blob_ref`. */
  async function fileNaming(hash: string): Promise<string> {
    const file = await client.createItem({
      type: "core.file",
      source: ctx.source,
      properties: { blob_ref: hash, mime_type: "text/plain" },
    });
    expect(file.ok, JSON.stringify(file.error)).toBe(true);
    trackItem(ctx, file.data.item.id);
    return file.data.item.id;
  }

  async function noteSaying(
    body: string,
  ): Promise<{ id: string; version: number }> {
    const note = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    trackItem(ctx, note.data.item.id);
    return { id: note.data.item.id, version: note.data.item.version };
  }

  it("keeps a blob that only an item in the bin, an archived item, an extension or an earlier version names", async () => {
    const binned = await uploadText("named by an item in the bin");
    const archived = await uploadText("named by an archived item");
    const extended = await uploadText("named by a metadata extension");
    const versioned = await uploadText("named by an earlier version");
    const unnamed = await uploadText("named by nothing at all");

    const binnedId = await fileNaming(binned);
    expect((await client.deleteItem(binnedId)).status).toBe(200);
    const archivedId = await fileNaming(archived);
    const moved = await client.transitionItem(archivedId, "archived");
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    const extension = await noteSaying("an extension names a blob");
    const written = await client.setItemExtension(
      extension.id,
      `blobrules.${ctx.runId}`,
      { cover: extended },
    );
    expect(written.ok, JSON.stringify(written.error)).toBe(true);
    const earlier = await noteSaying(`was ![it](${versioned})`);
    const rewritten = await client.updateItem(earlier.id, {
      properties: { body: "no longer links anything" },
      version: earlier.version,
    });
    expect(rewritten.ok, JSON.stringify(rewritten.error)).toBe(true);
    expect(
      JSON.stringify((await client.getVersions(earlier.id)).data),
    ).toContain(versioned);

    await run("blob-orphans");
    const reported = (await operator.listBlobOrphans()).data.data.map(
      (row) => row.hash,
    );
    await run("blob-orphans");

    // The witness: the blob nothing names is reported and then purged by the
    // same two runs, so they could have taken the others.
    expect(reported).toContain(unnamed);
    expect((await operator.downloadBlob(unnamed)).status).toBe(404);
    for (const hash of [binned, archived, extended, versioned]) {
      expect(reported, hash).not.toContain(hash);
      expect((await operator.downloadBlob(hash)).status, hash).toBe(200);
    }
  });

  it("counts a digest as a reference by its run of lowercase hex, whatever form it is written in", async () => {
    const hexOf = (hash: string) => hash.slice("sha256:".length);
    const forms: Array<[string, (hex: string) => string]> = [
      ["bare hex", (hex) => `see ${hex} here`],
      ["a link", (hex) => `![it](sha256:${hex})`],
      ["a url-encoded colon in capitals", (hex) => `?hash=sha256%3A${hex}&x=1`],
      [
        "a url-encoded colon in lowercase",
        (hex) => `?hash=sha256%3a${hex}&x=1`,
      ],
      [
        "a backslash escape beside it",
        (hex) => String.raw`line one\n${hex}\nline two`,
      ],
      ["letters that are not hex beside it", (hex) => `Z${hex}Z`],
      ["underscores beside it", (hex) => `_${hex}_`],
    ];
    const notReferences: Array<[string, (hex: string) => string]> = [
      ["63 characters", (hex) => hex.slice(0, 63)],
      ["63 characters from the end", (hex) => hex.slice(1)],
      ["a hex character before it", (hex) => `0${hex}`],
      ["a hex character after it", (hex) => `${hex}0`],
    ];
    const kept: Array<[string, string]> = [];
    for (const [name, write] of forms) {
      const hash = await uploadText(`named by ${name}`);
      await noteSaying(write(hexOf(hash)));
      kept.push([name, hash]);
    }
    const dropped: Array<[string, string]> = [];
    for (const [name, write] of notReferences) {
      const hash = await uploadText(`named by ${name}`);
      await noteSaying(write(hexOf(hash)));
      dropped.push([name, hash]);
    }

    await run("blob-orphans");
    await run("blob-orphans");

    for (const [name, hash] of kept) {
      expect((await operator.downloadBlob(hash)).status, name).toBe(200);
    }
    // Reported and purged by the same two runs that kept the rest, so each
    // of these was producible as a purge.
    for (const [name, hash] of dropped) {
      expect((await operator.downloadBlob(hash)).status, name).toBe(404);
    }
  });

  it("records when a run first reported a blob", async () => {
    const hash = await uploadText("reported with the time of the run");
    const first = await runRecorded<{ reported: number; purged: number }>(
      "blob-orphans",
    );
    expect(first.result.reported).toBeGreaterThanOrEqual(1);
    const row = (await operator.listBlobOrphans()).data.data.find(
      (each) => each.hash === hash,
    );
    expect(row).toBeDefined();
    expect(Date.parse(row!.reported_at)).not.toBeNaN();
    expect(row!.reported_at >= first.started_at).toBe(true);
    expect(row!.reported_at <= first.finished_at).toBe(true);
  });
});

describe("how the copies are placed and removed", () => {
  it("replicates an upload on its own, each copy with its own recorded time", async () => {
    const before = Date.now();
    const hash = await uploadReferencedText("copied with no run asked for");
    // No run is asked for: the housekeeping cadence is an hour, so a second
    // copy can only come from the wake the upload sent.
    const locations = await waitFor("the object store's copy", async () => {
      const rows = (await client.listBlobLocations(hash)).data.data;
      return rows.length === 2 ? rows : undefined;
    });
    const after = Date.now();
    expect(kinds(locations)).toEqual(["disk", "s3"]);
    const disk = locations.find((row) => row.kind === "disk")!;
    const copy = locations.find((row) => row.kind === "s3")!;
    for (const row of [disk, copy]) {
      expect(Date.parse(row.recorded_at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(row.recorded_at)).toBeLessThanOrEqual(after);
    }
    expect(copy.recorded_at >= disk.recorded_at).toBe(true);
    // Oldest first.
    expect(locations.map((row) => row.recorded_at)).toEqual(
      locations.map((row) => row.recorded_at).sort(),
    );
  });

  it("removes a dropped copy's bytes from its store", async () => {
    const hash = await uploadReferencedText("dropped from each store in turn");
    await replicateToZero();
    const stores = (await operator.listBlobStores()).data.data;
    const disk = stores.find((store) => store.kind === "disk")!;
    const s3 = stores.find((store) => store.kind === "s3")!;
    const link = (await client.getBlobUrl(hash)).data.url;
    // The witness: both stores hold the bytes before either is dropped.
    expect(existsSync(diskPathFor(hash))).toBe(true);
    expect((await fetch(link)).status).toBe(200);

    expect((await operator.deleteBlobLocation(hash, disk.id)).status).toBe(200);
    expect(existsSync(diskPathFor(hash))).toBe(false);
    await replicateToZero();
    expect(existsSync(diskPathFor(hash))).toBe(true);

    expect((await operator.deleteBlobLocation(hash, s3.id)).status).toBe(200);
    expect((await fetch(link)).status).toBe(404);
    await replicateToZero();
  });

  it("removes a purged blob's bytes from every store", async () => {
    const hash = await uploadText("purged from the disk and the object store");
    await replicateToZero();
    const link = (await operator.getBlobUrl(hash)).data.url;
    expect(existsSync(diskPathFor(hash))).toBe(true);
    expect((await fetch(link)).status).toBe(200);

    await run("blob-orphans");
    await run("blob-orphans");

    expect((await operator.downloadBlob(hash)).status).toBe(404);
    expect(existsSync(diskPathFor(hash))).toBe(false);
    expect((await fetch(link)).status).toBe(404);
  });

  it("never lets two concurrent drops take both copies", async () => {
    const hash = await uploadReferencedText("two copies, two drops at once");
    await replicateToZero();
    const stores = (await operator.listBlobStores()).data.data;

    const answers = await Promise.all(
      stores.map((store) => operator.deleteBlobLocation(hash, store.id)),
    );

    const statuses = answers.map((answer) => answer.status).sort();
    for (const answer of answers) {
      expect([200, 409]).toContain(answer.status);
      if (answer.status === 409) {
        expect(answer.error?.error.code).toBe("copies_below_minimum");
      }
    }
    expect(statuses).toContain(200);
    expect(
      (await client.listBlobLocations(hash)).data.data.length,
    ).toBeGreaterThanOrEqual(1);
    expect((await client.downloadBlob(hash)).status).toBe(200);
    await replicateToZero();
  });

  it("answers the drop door's refusals in their order", async () => {
    const hash = await uploadReferencedText("dropped through a bare hex");
    await replicateToZero();
    const stores = (await operator.listBlobStores()).data.data;
    const s3 = stores.find((store) => store.kind === "s3")!;
    const base = bootEnv("MARFA_API_URL");
    const drop = (path: string, key?: string) =>
      fetch(`${base}/blobs/${path}`, {
        method: "DELETE",
        headers: key === undefined ? {} : { Authorization: `Bearer ${key}` },
      });
    const code = async (response: Response) =>
      ((await response.json()) as { error: { code: string } }).error.code;
    const malformed = "not-a-hash";
    const unregistered = `sha256:${"0".repeat(64)}`;
    const operatorKey = process.env.MARFA_OPERATOR_KEY!;
    const working = await client.deleteBlobLocation(malformed, "no-such-store");

    // No credential first, then a credential that is not the operator key,
    // whatever the hash and the store are.
    const anonymous = await drop(`${malformed}/locations/no-such-store`);
    expect(anonymous.status).toBe(401);
    expect(await code(anonymous)).toBe("unauthorized");
    expect(working.status).toBe(403);
    expect(working.error?.error.code).toBe("forbidden");

    // The operator key reaches the hash: malformed, then unregistered, then
    // the store, whatever the store is.
    const bad = await drop(`${malformed}/locations/${s3.id}`, operatorKey);
    expect(bad.status).toBe(400);
    expect(await code(bad)).toBe("validation_error");
    const unknownBlob = await drop(
      `${unregistered}/locations/no-such-store`,
      operatorKey,
    );
    expect(unknownBlob.status).toBe(404);
    expect(await code(unknownBlob)).toBe("blob_not_found");
    const unknownStore = await drop(
      `${hash}/locations/no-such-store`,
      operatorKey,
    );
    expect(unknownStore.status).toBe(404);
    expect(await code(unknownStore)).toBe("blob_location_not_found");

    // The witness for all of them: the copy is still there, and the same
    // door drops it once the hash is the bare hex of a registered blob.
    expect(kinds((await client.listBlobLocations(hash)).data.data)).toEqual([
      "disk",
      "s3",
    ]);
    const bare = await drop(
      `${hash.slice("sha256:".length)}/locations/${s3.id}`,
      operatorKey,
    );
    expect(bare.status).toBe(200);
    expect(kinds((await client.listBlobLocations(hash)).data.data)).toEqual([
      "disk",
    ]);
    // Last, the minimum: every check above it passed for this copy too.
    const disk = stores.find((store) => store.kind === "disk")!;
    const last = await drop(`${hash}/locations/${disk.id}`, operatorKey);
    expect(last.status).toBe(409);
    expect(await code(last)).toBe("copies_below_minimum");
    await replicateToZero();
  });
});
