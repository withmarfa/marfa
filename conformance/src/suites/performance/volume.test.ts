import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  BulkItemInput,
  PerfResult,
  TestContext,
} from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getClientFromEnv,
} from "../../utils/setup.js";
import {
  PERF_SCALES,
  logPerf,
  measureSeries,
  seedWorkingSet,
  summarize,
  type PerfSeries,
} from "../../utils/perf.js";
import { measure } from "../../utils/timing.js";

/**
 * How read latency behaves as the working set grows.
 *
 * The property under test is that a bounded read stays bounded: fetching one
 * page, or one item by id, should cost the same whether the caller owns forty
 * rows or six hundred. A query plan that scans instead of seeking shows up as
 * latency tracking the row count.
 *
 * The working set is scoped to this file's credential rather than to the whole
 * dataset, and the comparable signal is each step measured against the step
 * before it, in the same window, under the same conditions. Growth is
 * deliberately modest — sustained high-volume behavior belongs to the load
 * suites, which are built to run for far longer than a per-change check.
 */

/** Same order-of-magnitude sanity bound the other read benchmarks use: a
 *  bounded page read is interactive on the database this suite targets. */
const READ_P50_CEILING_MS = 2_000;
/** The tail absorbs request queueing. */
const READ_P95_CEILING_MS = 5_000;
/**
 * How much slower the largest working set is allowed to be than the smallest.
 * Four times absorbs ordinary noise while still failing a read whose cost
 * tracks the row count — a scan over fifteen times the rows cannot hide under
 * this. The absolute floor stops a fast baseline from turning normal jitter
 * into a failure.
 */
const GROWTH_FACTOR = 4;
/**
 * Absolute floor, so a fast baseline does not turn ordinary jitter into a
 * failure.
 *
 * It must stay well below `READ_P50_CEILING_MS`. `assertHealthySeries` already
 * requires every recorded point to be under that ceiling, so a floor at or
 * above it would be a bound the last point had passed before the comparison
 * ran, and the growth assertion — the one question this file exists to answer
 * — could not fail.
 */
const GROWTH_FLOOR_MS = 250;

const scale = getClientFromEnv().perfScale;
const config = PERF_SCALES[scale];
const PAGE_SIZE = 20;

let client: MarfaClient;
let ctx: TestContext;
let seeded = 0;

interface VolumePoint {
  items: number;
  list: PerfResult;
  read: PerfResult;
}
const points: VolumePoint[] = [];
let sampleIds: string[] = [];

function buildSeedItem(index: number): BulkItemInput {
  // Short bodies on purpose: this suite measures reads, and a fat payload
  // would push the seeding cost past the measurement it is there to support.
  return {
    type: "core.note",
    properties: {
      title: `Volume perf note ${String(index)}`,
      body: `Row ${String(index)} of a growing working set.`,
    },
  };
}

function assertHealthySeries(series: PerfSeries, runs: number): void {
  expect(series.errors).toBe(0);
  expect(series.samples.length).toBeGreaterThanOrEqual(Math.ceil(runs * 0.6));
  expect(series.summary.p50).toBeLessThan(READ_P50_CEILING_MS);
  expect(series.summary.p95).toBeLessThan(READ_P95_CEILING_MS);
}

/** One measurement point: a bounded page read and a point read, both scoped to
 *  this file's own rows. */
async function measurePoint(items: number): Promise<void> {
  const list = await measureSeries(
    `GET /items (${String(items)} in set)`,
    async () => {
      const res = await client.listItems({
        source: ctx.source,
        limit: PAGE_SIZE,
      });
      return res.ok;
    },
    { runs: config.runs },
  );
  logPerf(list);
  assertHealthySeries(list, config.runs);

  const read = await measureSeries(
    `GET /items/:id (${String(items)} in set)`,
    async () => {
      if (sampleIds.length === 0) return true;
      const id = sampleIds[Math.floor(Math.random() * sampleIds.length)];
      const res = await client.getItem(id);
      return res.ok;
    },
    { runs: config.runs },
  );
  logPerf(read);
  assertHealthySeries(read, config.runs);

  points.push({ items, list: list.summary, read: read.summary });
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("performance", "volume"));

  // One row before the first measurement so the baseline exercises the same
  // code path as every later step rather than the empty-result path.
  sampleIds = await seedWorkingSet(client, ctx, 1, buildSeedItem, {
    label: "v0",
  });
  seeded = 1;
});

afterAll(async () => {
  await cleanup(ctx);
});

describe(`volume performance (scale: ${scale})`, () => {
  it("baseline at a single item", async () => {
    await measurePoint(seeded);
  });

  for (const target of config.volumeSteps) {
    it(`working set of ${String(target)} items`, async () => {
      const delta = target - seeded;
      if (delta > 0) {
        const ids = await seedWorkingSet(client, ctx, delta, buildSeedItem, {
          label: `v${String(target)}`,
        });
        sampleIds = sampleIds.concat(ids);
        seeded = target;
      }
      await measurePoint(seeded);
    });
  }

  it("cursor paging cost does not track page depth", async () => {
    // Cursor pagination is meant to seek, not to skip: page twenty should cost
    // what page one costs. An offset-based implementation degrades with depth,
    // and that is invisible to a benchmark that only ever reads the first page.
    const walks = 3;
    const perPosition: number[][] = [];

    for (let walk = 0; walk < walks; walk++) {
      let cursor: string | undefined;
      let position = 0;
      for (;;) {
        const { result, durationMs } = await measure(() =>
          client.listItems({ source: ctx.source, limit: PAGE_SIZE, cursor }),
        );
        expect(result.ok).toBe(true);
        perPosition[position] ??= [];
        perPosition[position].push(durationMs);
        position++;
        if (!result.data.has_more || !result.data.cursor) break;
        cursor = result.data.cursor;
      }
    }

    // At least a handful of pages, or the comparison says nothing.
    expect(perPosition.length).toBeGreaterThanOrEqual(3);

    const firstPage = summarize("cursor page 1", perPosition[0]);
    const lastIndex = perPosition.length - 1;
    const lastPage = summarize(
      `cursor page ${String(lastIndex + 1)}`,
      perPosition[lastIndex],
    );

    console.log(
      `  cursor walk over ${String(seeded)} items: ` +
        `page 1 p50=${firstPage.p50.toFixed(0)}ms, ` +
        `page ${String(lastIndex + 1)} p50=${lastPage.p50.toFixed(0)}ms ` +
        `(${String(perPosition.length)} pages x ${String(walks)} walks)`,
    );

    expect(lastPage.p50).toBeLessThan(
      Math.max(firstPage.p50 * GROWTH_FACTOR, GROWTH_FLOOR_MS),
    );
  });

  it("read latency has not grown with the working set", () => {
    expect(points.length).toBeGreaterThanOrEqual(2);

    const first = points[0];
    const last = points[points.length - 1];

    console.log(
      `  working set ${String(first.items)} -> ${String(last.items)} items: ` +
        `list p50 ${first.list.p50.toFixed(0)}ms -> ${last.list.p50.toFixed(0)}ms, ` +
        `read p50 ${first.read.p50.toFixed(0)}ms -> ${last.read.p50.toFixed(0)}ms`,
    );

    expect(last.list.p50).toBeLessThan(
      Math.max(first.list.p50 * GROWTH_FACTOR, GROWTH_FLOOR_MS),
    );
    expect(last.read.p50).toBeLessThan(
      Math.max(first.read.p50 * GROWTH_FACTOR, GROWTH_FLOOR_MS),
    );
  });
});
