/**
 * The blob cache's eviction rule, and the bytes it must never take.
 *
 * The rule is stated in `blobs.ts` beside the code that enforces it: the
 * cache is bounded by total bytes on disk, a write past the ceiling evicts
 * the least recently read cached blobs until it fits, and bytes staged for
 * upload are never candidates because they are the only copy anywhere.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient } from "../client.js";
import {
  createKeysModeFixture,
  type KeysModeFixture,
} from "../test-harness.js";
import {
  collectBlobHashes,
  createBlobStore,
  hashBlob,
  type LocalBlobs,
} from "./blobs.js";
import { openLocalStore, type LocalStore } from "./store/index.js";
import { SINGLE_ACCOUNT, SINGLE_SPACE } from "./types.js";

/** Two blobs' worth of room, so the third read is what has to displace
 *  something. Small enough that the arithmetic is readable. */
const BLOB_BYTES = 32;
const CEILING = BLOB_BYTES * 2;

let fixture: KeysModeFixture;
let client: MarfaClient;
let store: LocalStore;
let blobs: LocalBlobs;
let dir: string;
let tick: number;

/**
 * A clock that moves on every read.
 *
 * The eviction order is by last read, and the wall clock this store
 * stamps with has millisecond resolution — four cache writes in one
 * millisecond is the ordinary case, not the unlucky one, and the order
 * then falls to the tie-break rather than to the rule. That makes the
 * assertion below pass or fail on how fast the machine is, which is the
 * shape of a test that reports on the runner. Stepping the clock puts the
 * rule back in charge of the answer.
 */
const steppingClock = (): string =>
  new Date(Date.UTC(2026, 8, 4) + (tick += 1000)).toISOString();

const filled = (value: number): Uint8Array =>
  new Uint8Array(BLOB_BYTES).fill(value);

beforeEach(async () => {
  fixture = await createKeysModeFixture();
  client = fixture.client;
  dir = mkdtempSync(join(tmpdir(), "marfa-local-blob-cache-"));
  store = await openLocalStore({
    path: join(dir, "store.db"),
    identity: {
      origin: "http://localhost",
      spaceId: SINGLE_SPACE,
      accountId: SINGLE_ACCOUNT,
    },
  });
  tick = 0;
  blobs = createBlobStore({
    store,
    client,
    maxCacheBytes: CEILING,
    now: steppingClock,
  });
});

afterEach(() => {
  store.close();
  fixture.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("the blob cache", () => {
  it("reads through to the server and holds what it read", async () => {
    const bytes = filled(1);
    const { hash } = await client.blobs.upload(bytes, "image/png");

    expect(blobs.held(hash)).toBe(false);
    expect(await blobs.read(hash)).toEqual(bytes);
    expect(blobs.held(hash)).toBe(true);
    expect(await store.blobs.cache.totalBytes()).toBe(BLOB_BYTES);

    // A second read is served from disk. Asserted through the store rather
    // than through a call count because the point is the bytes, and a
    // cache that re-downloaded them would still return the right ones.
    const cached = await store.blobs.cache.get(hash);
    expect(cached).toMatchObject({ size: BLOB_BYTES });
    expect(await blobs.read(hash)).toEqual(bytes);
  });

  it("evicts the least recently read, not the first read", async () => {
    const first = await client.blobs.upload(filled(1), "image/png");
    const second = await client.blobs.upload(filled(2), "image/png");
    const third = await client.blobs.upload(filled(3), "image/png");

    await blobs.read(first.hash);
    await blobs.read(second.hash);
    expect(await store.blobs.cache.totalBytes()).toBe(CEILING);

    // Reaching for the older one again is what separates least-recently-read
    // from first-in. Without the touch, the next read displaces `first` and
    // every assertion below still reads plausibly.
    await blobs.read(first.hash);

    await blobs.read(third.hash);

    expect(await store.blobs.cache.totalBytes()).toBe(CEILING);
    expect(blobs.held(first.hash)).toBe(true);
    expect(blobs.held(second.hash)).toBe(false);
    expect(blobs.held(third.hash)).toBe(true);
    expect(await store.blobs.cache.get(second.hash)).toBeUndefined();

    // Evicted is not lost: the server still holds it, which is the whole
    // reason a downloaded blob may be evicted and a staged one may not.
    expect(await blobs.read(second.hash)).toEqual(filled(2));
  });

  it("never evicts bytes that are still owed to the server", async () => {
    const staged = filled(9);
    const { hash } = await blobs.stage(staged, "image/png");

    // Enough reads to turn the cache over twice. The staged bytes have no
    // row in the cache table at all, so the walk cannot reach them — the
    // exclusion is structural rather than a condition that could be
    // forgotten.
    for (const fill of [1, 2, 3, 4]) {
      const uploaded = await client.blobs.upload(filled(fill), "image/png");
      await blobs.read(uploaded.hash);
    }

    // Exactly full, not merely within the ceiling. Four 32-byte reads
    // against a 64-byte bound settle at 64 every time, so `<=` would also
    // be satisfied by an evictor that emptied the cache — which is the
    // failure this test is closest to.
    expect(await store.blobs.cache.totalBytes()).toBe(CEILING);
    expect(blobs.held(hash)).toBe(true);
    expect(await blobs.read(hash)).toEqual(staged);
    expect(await store.blobs.get(hash)).toMatchObject({ state: "pending" });
  });

  it("does not cache a blob larger than the whole ceiling", async () => {
    const kept = await client.blobs.upload(filled(1), "image/png");
    await blobs.read(kept.hash);

    const huge = new Uint8Array(CEILING * 4).fill(5);
    const { hash } = await client.blobs.upload(
      huge,
      "application/octet-stream",
    );

    // Returned in full, and not written down. Caching it would evict
    // everything else and still not fit, so the cache would end up empty
    // and without the blob that emptied it.
    expect(await blobs.read(hash)).toEqual(huge);
    expect(blobs.held(hash)).toBe(false);
    expect(blobs.held(kept.hash)).toBe(true);
    expect(await store.blobs.cache.totalBytes()).toBe(BLOB_BYTES);
  });

  it("refuses an upload whose bytes have left the disk", async () => {
    const { hash } = await blobs.stage(filled(7), "image/png");
    // The row survives its file: a store copied without its blob
    // directory, or a sweep that took the bytes and not the queue. Nothing
    // can be sent and nothing later will make it sendable, so holding the
    // row would hold every write naming it for ever.
    rmSync(blobs.pathFor(hash));

    const flushed = await blobs.flush();

    expect(flushed.uploaded).toEqual([]);
    expect(flushed.refused).toHaveLength(1);
    const refusal = flushed.refused[0];
    expect(refusal).toMatchObject({
      hash,
      code: "blob_bytes_missing",
      httpStatus: null,
    });
    // The message names the hash, because the message is what a person
    // reads on the dead letter the refusal produces.
    expect(refusal?.message).toContain(hash);
    // Recorded as a refusal rather than left pending, which is what lets
    // the drain dead-letter the writes waiting on it with a reason.
    expect(await store.blobs.get(hash)).toMatchObject({
      state: "failed",
      code: "blob_bytes_missing",
    });
  });
});

/**
 * The scan that decides which uploads a write waits for.
 *
 * A hash can sit anywhere a type puts a string, so the scan recurses. Both
 * recursive arms are exercised here because neither is reachable from the
 * top-level `blob_ref` string every other test seeds, and a miss is the
 * single failure this scanning exists to prevent: the write that names the
 * blob does not wait for its upload, and lands referencing nothing.
 */
describe("the scan for blob references", () => {
  const hashOf = (letter: string): string => `sha256:${letter.repeat(64)}`;

  it("reaches a hash nested in an array and behind an object", () => {
    const found = new Set<string>();
    collectBlobHashes(
      {
        blob_ref: hashOf("a"),
        attachments: [hashOf("b"), { thumbnail: hashOf("c") }],
        nested: { deeper: { list: [{ ref: hashOf("d") }] } },
        // None of these is a blob reference, and a scan that treated any
        // of them as one would make the drain wait on an upload nothing
        // ever staged.
        not_a_hash: "sha256:tooshort",
        prose: "a sentence",
        count: 3,
        absent: null,
      },
      found,
    );

    expect([...found].sort()).toEqual(
      [hashOf("a"), hashOf("b"), hashOf("c"), hashOf("d")].sort(),
    );
  });

  it("agrees with the hash the staged bytes are named by", () => {
    const found = new Set<string>();
    collectBlobHashes({ blob_ref: hashBlob(filled(1)) }, found);
    expect([...found]).toEqual([hashBlob(filled(1))]);
  });
});
