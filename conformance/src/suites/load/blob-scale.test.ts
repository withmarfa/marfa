/**
 * Blob storage round-trips.
 *
 * A bounded benchmark over blob upload and download across a spread of file
 * sizes, plus a check that content addressing actually dedupes. It uploads a
 * fixed number of fixtures from the profile rather than pushing until storage
 * or bandwidth complains, so nothing here describes a capacity limit.
 *
 * **Cleanup contract.** Blobs are content-addressed and the public API exposes
 * no delete, so the bytes this suite writes are not removable the way items
 * are. That is deliberate rather than a leak: fixture bytes are generated from
 * fixed seeds, so every run converges on the same handful of hashes instead of
 * accumulating new ones. Each upload is named by a note, untimed, because a
 * key reads only bytes an item it may read references (`blobs.md` 15); the
 * notes and the key this suite mints go in `cleanup(ctx)` in `afterAll`.
 */

import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  BLOB_FIXTURES,
  type BlobFixture,
} from "../../generators/blob-fixtures.js";
import { benchmarkConcurrent } from "../../utils/pool.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { measure } from "../../utils/timing.js";
import { record, warmTarget } from "./bench.js";
import { getLoadProfile } from "./profiles.js";
import { computeMetrics, type LoadMetrics } from "./results.js";

const profile = getLoadProfile();
const { blobUploads, concurrency } = profile.bench;

/**
 * Smallest fixtures first, so a small profile exercises the size spread it can
 * afford before reaching the multi-megabyte photo fixtures. Cycling with a
 * varying seed keeps larger profiles from re-uploading identical bytes and
 * measuring the dedup path instead of the write path.
 */
const BY_SIZE = [...BLOB_FIXTURES].sort(
  (a, b) => a.targetBytes - b.targetBytes,
);
const PLAN: { fixture: BlobFixture; seed: number }[] = Array.from(
  { length: blobUploads },
  (_, i) => ({
    fixture: BY_SIZE[i % BY_SIZE.length],
    seed: 100 + Math.floor(i / BY_SIZE.length),
  }),
);

describe("blob storage at scale", () => {
  let ctx: TestContext;

  async function nameInANote(hash: string): Promise<void> {
    const note = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: `![bytes](${hash})` },
    });
    if (!note.ok) {
      throw new Error(`could not name ${hash}: ${JSON.stringify(note.error)}`);
    }
    trackItem(ctx, note.data.item.id);
  }
  let client: MarfaClient;
  const uploaded: { hash: string; bytes: number }[] = [];

  beforeAll(async () => {
    ({ ctx, client } = await createTestContext("load", "blob-scale"));
    const warmMs = await warmTarget(client);
    console.log(
      `  warm-up ${warmMs.toFixed(0)}ms — excluded from every sample below`,
    );
  });

  afterAll(async () => {
    await cleanup(ctx);
  });

  it("round-trips fixtures byte-for-byte across the size spread", async () => {
    const uploadDurations: number[] = [];
    const downloadDurations: number[] = [];
    const breakdown: Record<string, LoadMetrics> = {};
    let totalBytes = 0;
    let errors = 0;
    let mismatches = 0;

    for (const { fixture, seed } of PLAN) {
      const bytes = fixture.generate(seed);

      const upload = await measure(() =>
        client.uploadBlob(bytes, fixture.mimeType),
      );
      if (!upload.result.ok) {
        errors++;
        continue;
      }
      const hash = upload.result.data.hash;
      await nameInANote(hash);
      uploaded.push({ hash, bytes: bytes.byteLength });
      uploadDurations.push(upload.durationMs);
      totalBytes += bytes.byteLength;

      const download = await measure(() => client.downloadBlob(hash));
      if (!download.result.ok) {
        errors++;
        continue;
      }
      downloadDurations.push(download.durationMs);
      if (!Buffer.from(download.result.data).equals(Buffer.from(bytes)))
        mismatches++;

      const label = `${fixture.name}:${(bytes.byteLength / 1024).toFixed(0)}KB`;
      breakdown[label] = computeMetrics(
        [upload.durationMs, download.durationMs],
        0,
        bytes.byteLength / 1024 / (upload.durationMs / 1000),
      );
    }

    const uploadSeconds = uploadDurations.reduce((a, b) => a + b, 0) / 1000;
    await record({
      scenario: "load.blob-scale.round-trip",
      profile,
      itemCount: PLAN.length,
      durations: [...uploadDurations, ...downloadDurations],
      errors,
      throughput: totalBytes / 1024 / 1024 / uploadSeconds,
      breakdown,
    });

    console.log(
      `  uploaded ${(totalBytes / 1024 / 1024).toFixed(2)}MB across ${uploadDurations.length} blobs`,
    );

    expect(errors).toBe(0);
    expect(mismatches).toBe(0);
    expect(uploadDurations.length).toBe(PLAN.length);
  });

  it("dedupes identical bytes onto one hash and separates different bytes", async () => {
    const fixture = BY_SIZE[0];
    const bytes = fixture.generate(4242);

    const first = await client.uploadBlob(bytes, fixture.mimeType);
    const second = await client.uploadBlob(bytes, fixture.mimeType);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.data.hash).toBe(first.data.hash);

    const different = await client.uploadBlob(
      fixture.generate(4343),
      fixture.mimeType,
    );
    expect(different.ok).toBe(true);
    expect(different.data.hash).not.toBe(first.data.hash);
  });

  it("serves parallel downloads without corruption", async () => {
    expect(uploaded.length).toBeGreaterThan(0);

    const runs = Math.max(uploaded.length, concurrency);
    const { timings, errors, totalDurationMs } = await benchmarkConcurrent(
      async (index) => {
        const target = uploaded[index % uploaded.length];
        const response = await client.downloadBlob(target.hash);
        if (!response.ok)
          throw new Error(`download failed: ${response.status}`);
        if (response.data.byteLength !== target.bytes) {
          throw new Error(
            `short read: ${response.data.byteLength} of ${target.bytes} bytes`,
          );
        }
        return response.data.byteLength;
      },
      runs,
      concurrency,
    );

    const bytesRead = timings.reduce((sum, t) => sum + t.result, 0);
    await record({
      scenario: "load.blob-scale.parallel-download",
      profile,
      itemCount: uploaded.length,
      durations: timings.map((t) => t.durationMs),
      errors: errors.length,
      throughput: bytesRead / 1024 / 1024 / (totalDurationMs / 1000),
    });

    expect(errors.length).toBe(0);
    expect(timings.length).toBe(runs);
  });
});
