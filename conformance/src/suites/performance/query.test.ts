import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BulkItemInput, TestContext } from "../../client/types.js";
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
  type PerfSeries,
} from "../../utils/perf.js";

/**
 * Read-path latency: point reads, first-page lists, filtered lists, and a
 * multi-id fetch, measured against a seeded working set that belongs to this
 * file's credential.
 *
 * Thresholds are deliberately loose. An assertion here is an order-of-magnitude
 * sanity check — "reads are still interactive" — not a service-level
 * objective. Tightening these to real SLO numbers would make the suite a
 * flakiness generator without catching anything a loose bound misses.
 */

/**
 * A warm read of a small page is a sub-second operation on every backend this
 * suite targets. A median past this means something structural regressed (a
 * lost index, an N+1 hydration), not that the server was busy.
 */
const READ_P50_CEILING_MS = 2_000;
/** The tail absorbs request queueing. */
const READ_P95_CEILING_MS = 5_000;

const scale = getClientFromEnv().perfScale;
const config = PERF_SCALES[scale];

let client: MarfaClient;
let ctx: TestContext;
let seededIds: string[] = [];

/**
 * Every seeded item carries this tag so the tag-filter benchmark reads a
 * populated result set rather than an empty one.
 */
const FILTER_TAG = "perf-query";

function buildSeedItem(index: number): BulkItemInput {
  // A mixed type distribution keeps the type-filter benchmark honest: filtering
  // on core.note has to actually exclude rows rather than return everything.
  return index % 3 === 0
    ? {
        type: "core.bookmark",
        properties: {
          url: `https://example.com/perf/${String(index)}`,
          title: `Query perf bookmark ${String(index)}`,
        },
        tags: [FILTER_TAG],
      }
    : {
        type: "core.note",
        properties: {
          title: `Query perf note ${String(index)}`,
          body: `Seeded row ${String(index)} for read-path latency measurement.`,
        },
        tags: [FILTER_TAG],
      };
}

/**
 * Shared shape for every benchmark in this file: percentiles printed, the
 * tail bounded, and every call required to have succeeded so a series that is
 * fast because the server is erroring cannot pass.
 */
function assertHealthySeries(series: PerfSeries, runs: number): void {
  expect(series.errors).toBe(0);
  expect(series.samples.length).toBe(runs);
  expect(series.summary.p50).toBeLessThan(READ_P50_CEILING_MS);
  expect(series.summary.p95).toBeLessThan(READ_P95_CEILING_MS);
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("performance", "query"));

  seededIds = await seedWorkingSet(
    client,
    ctx,
    config.seedItems,
    buildSeedItem,
    {
      label: "query",
    },
  );
});

afterAll(async () => {
  await cleanup(ctx);
});

describe(`query performance (scale: ${scale})`, () => {
  it("point read by id", async () => {
    const series = await measureSeries(
      "GET /items/:id",
      async () => {
        // Rotate through the seeded set so a per-row cache cannot flatter the
        // measurement.
        const id = seededIds[Math.floor(Math.random() * seededIds.length)];
        const res = await client.getItem(id);
        return res.ok;
      },
      { runs: config.runs },
    );

    logPerf(series);
    assertHealthySeries(series, config.runs);
  });

  it("first page of a source-scoped list", async () => {
    const series = await measureSeries(
      "GET /items (page 1)",
      async () => {
        const res = await client.listItems({ source: ctx.source, limit: 20 });
        return res.ok && res.data.data.length > 0;
      },
      { runs: config.runs },
    );

    logPerf(series);
    assertHealthySeries(series, config.runs);
  });

  it("list filtered by type", async () => {
    const series = await measureSeries(
      "GET /items?type=core.note",
      async () => {
        const res = await client.listItems({
          source: ctx.source,
          type: "core.note",
          limit: 20,
        });
        return (
          res.ok && res.data.data.every((item) => item.type === "core.note")
        );
      },
      { runs: config.runs },
    );

    logPerf(series);
    assertHealthySeries(series, config.runs);
  });

  it("list filtered by tag", async () => {
    const series = await measureSeries(
      "GET /items?tags=…",
      async () => {
        const res = await client.listItems({
          source: ctx.source,
          tags: [FILTER_TAG],
          limit: 20,
        });
        return res.ok && res.data.data.length > 0;
      },
      { runs: config.runs },
    );

    logPerf(series);
    assertHealthySeries(series, config.runs);
  });

  it("list filtered by state", async () => {
    const series = await measureSeries(
      "GET /items?state=active",
      async () => {
        const res = await client.listItems({
          source: ctx.source,
          state: "active",
          limit: 20,
        });
        return res.ok && res.data.data.every((item) => item.state === "active");
      },
      { runs: config.runs },
    );

    logPerf(series);
    assertHealthySeries(series, config.runs);
  });

  it("multi-id read in one round trip", async () => {
    // Twenty ids is the point where a client reaches for bulk-get instead of a
    // loop; the property worth measuring is that it stays one round trip rather
    // than degrading toward twenty sequential point reads.
    const ids = seededIds.slice(0, Math.min(20, seededIds.length));

    const series = await measureSeries(
      "POST /items/bulk-get (20 ids)",
      async () => {
        const res = await client.bulkGet(ids);
        return res.ok && res.data.items.length === ids.length;
      },
      { runs: config.runs },
    );

    logPerf(series);
    assertHealthySeries(series, config.runs);
  });
});
