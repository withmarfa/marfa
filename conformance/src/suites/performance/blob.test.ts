import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getClientFromEnv,
} from "../../utils/setup.js";
import {
  PERF_SCALES,
  logPerf,
  measureSeries,
  type PerfSeries,
} from "../../utils/perf.js";
import {
  getFixtureByName,
  type BlobFixture,
} from "../../generators/blob-fixtures.js";

/**
 * Blob upload and download latency at three payload sizes, from a few
 * kilobytes to a few megabytes.
 *
 * Blobs are content-addressed and the API exposes no delete, so a suite that
 * uploaded fresh bytes on every run would grow the target's storage without
 * bound and could never clean up after itself. This file therefore uploads the
 * byte-identical fixtures every time: repeat runs deduplicate onto the same
 * objects and the footprint stays flat. The consequence is that upload here
 * measures the steady-state path — hash the payload, transfer it, resolve it
 * to an existing object — which is also the path a sync client hits most,
 * since re-offering content the server already has is the common case.
 */

/** Transfer of the largest fixture is a few megabytes; on any link a
 *  conformance run is realistically made over, that is a fraction of a second
 *  of wire time, so one bound covers all three sizes without hiding a
 *  size-specific regression. */
const BLOB_P50_CEILING_MS = 3_000;
/** The tail absorbs request queueing behind the larger transfers. */
const BLOB_P95_CEILING_MS = 7_000;

/** Small, medium, and multi-megabyte. Spanning three orders of magnitude is
 *  what makes a per-byte cost visible against the fixed per-request cost. */
const FIXTURE_NAMES = ["text-note", "mac-screenshot", "iphone-photo"] as const;

const scale = getClientFromEnv().perfScale;
const config = PERF_SCALES[scale];

let client: MarfaClient;
let ctx: TestContext;

interface PreparedFixture {
  fixture: BlobFixture;
  bytes: Uint8Array;
  hash: string;
}
const prepared: PreparedFixture[] = [];

function sizeLabel(bytes: number): string {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)}MB`
    : `${Math.round(bytes / 1024).toString()}KB`;
}

/** Kilobytes per second at the median. One unit across three orders of
 *  magnitude of payload keeps the per-byte cost comparable between rows. */
function throughputNote(bytes: number, p50Ms: number): string {
  if (p50Ms <= 0) return "";
  return `${(bytes / 1024 / (p50Ms / 1000)).toFixed(0)} KB/s at p50`;
}

function assertHealthySeries(series: PerfSeries, runs: number): void {
  expect(series.errors).toBe(0);
  expect(series.samples.length).toBeGreaterThanOrEqual(Math.ceil(runs * 0.6));
  expect(series.summary.p50).toBeLessThan(BLOB_P50_CEILING_MS);
  expect(series.summary.p95).toBeLessThan(BLOB_P95_CEILING_MS);
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("performance", "blob"));

  for (const name of FIXTURE_NAMES) {
    const fixture = getFixtureByName(name);
    if (!fixture) throw new Error(`Missing blob fixture: ${name}`);

    // Synthesized once — generating a multi-megabyte fixture is pure CPU work
    // and would otherwise be timed as part of every upload sample.
    const bytes = fixture.generate();
    const upload = await client.uploadBlob(bytes, fixture.mimeType);
    if (!upload.ok) {
      throw new Error(
        `Failed to seed ${name} blob: ${String(upload.status)} ${JSON.stringify(upload.error)}`,
      );
    }
    prepared.push({ fixture, bytes, hash: upload.data.hash });
  }
});

afterAll(async () => {
  await cleanup(ctx);
});

describe(`blob performance (scale: ${scale})`, () => {
  it("upload latency across payload sizes", async () => {
    for (const { fixture, bytes, hash } of prepared) {
      const series = await measureSeries(
        `POST /blobs (${sizeLabel(bytes.length)})`,
        async () => {
          const res = await client.uploadBlob(bytes, fixture.mimeType);
          // Content addressing is the invariant worth checking while timing:
          // the same bytes must always resolve to the same hash.
          return res.ok && res.data.hash === hash;
        },
        { runs: config.blobRuns },
      );

      logPerf(series, throughputNote(bytes.length, series.summary.p50));
      assertHealthySeries(series, config.blobRuns);
    }
  });

  it("download latency across payload sizes", async () => {
    for (const { bytes, hash } of prepared) {
      const series = await measureSeries(
        `GET /blobs/:hash (${sizeLabel(bytes.length)})`,
        async () => {
          const res = await client.downloadBlob(hash);
          // Byte count, not just status: a truncated or empty body would
          // otherwise register as an impressively fast download.
          return res.ok && res.data.byteLength === bytes.length;
        },
        { runs: config.blobRuns },
      );

      logPerf(series, throughputNote(bytes.length, series.summary.p50));
      assertHealthySeries(series, config.blobRuns);
    }
  });

  it("miss on an unknown hash is not slower than a hit", async () => {
    // A 404 should be decided from the content address alone. If it costs as
    // much as serving a real object, the lookup is doing work it should not.
    const missHash = `sha256:${"b".repeat(64)}`;

    const series = await measureSeries(
      "GET /blobs/:hash (404)",
      async () => {
        const res = await client.downloadBlob(missHash);
        return res.status === 404;
      },
      { runs: config.blobRuns },
    );

    logPerf(series);
    assertHealthySeries(series, config.blobRuns);
  });
});
