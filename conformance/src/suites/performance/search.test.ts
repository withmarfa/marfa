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
import { Corpus } from "../../generators/corpus.js";

/**
 * Full-text search latency across three selectivities: a token that matches
 * only this run's rows, a common word that matches whatever else is in the
 * index, and a type-narrowed query.
 *
 * Selectivity is the axis that matters — an FTS implementation that scans
 * instead of using its index shows the difference between a one-row match and
 * a broad match as an order-of-magnitude latency gap. Absolute numbers depend
 * on how much content the dataset already holds, so the thresholds below are
 * sanity bounds and the printed distribution is the comparable artifact.
 */

/** Search does more work than a keyed read, so its median gets more room than
 *  the list benchmarks; still far below anything a user would call slow. */
const SEARCH_P50_CEILING_MS = 3_000;
/** The tail absorbs request queueing. */
const SEARCH_P95_CEILING_MS = 6_000;

/** A word from the corpus vocabulary, so it matches every seeded row broadly
 *  rather than selectively. */
const BROAD_TERM = "meeting";

const scale = getClientFromEnv().perfScale;
const config = PERF_SCALES[scale];

let client: MarfaClient;
let ctx: TestContext;
/** Single alphanumeric token unique to this run — hyphens and other
 *  punctuation are tokenizer boundaries, so they cannot appear in a term that
 *  has to match as one word in the full-text index. */
let runToken = "";

function assertHealthySeries(series: PerfSeries, runs: number): void {
  expect(series.errors).toBe(0);
  expect(series.samples.length).toBeGreaterThanOrEqual(Math.ceil(runs * 0.6));
  expect(series.summary.p50).toBeLessThan(SEARCH_P50_CEILING_MS);
  expect(series.summary.p95).toBeLessThan(SEARCH_P95_CEILING_MS);
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("performance", "search"));

  runToken = `perfsearch${ctx.runId.replace(/[^a-z0-9]/gi, "")}`;

  const corpus = new Corpus({ seed: 7 });
  const build = (index: number): BulkItemInput => ({
    type: index % 4 === 0 ? "core.bookmark" : "core.note",
    properties:
      index % 4 === 0
        ? {
            url: corpus.url(),
            title: corpus.title(),
            description: `${corpus.paragraph()} ${runToken}`,
          }
        : {
            title: corpus.title(),
            // Bodies are multi-paragraph rather than one line: an index that
            // only ever sees short documents will not show the cost of ranking
            // real content.
            body: `${corpus.body(200)}\n\n${runToken}`,
          },
  });

  await seedWorkingSet(client, ctx, config.seedItems, build, {
    label: "search",
  });
});

afterAll(async () => {
  await cleanup(ctx);
});

describe(`search performance (scale: ${scale})`, () => {
  it("selective term matching only this run", async () => {
    // Prove the term is actually indexed before timing it. A search that
    // returns nothing is fast for the wrong reason, and would turn this into a
    // measurement of the empty-result path.
    const probe = await client.search(runToken, { limit: 50 });
    expect(probe.ok).toBe(true);
    expect(probe.data.data.length).toBeGreaterThan(0);

    const series = await measureSeries(
      "GET /search (selective)",
      async () => {
        const res = await client.search(runToken, { limit: 20 });
        return res.ok && res.data.data.length > 0;
      },
      { runs: config.runs },
    );

    logPerf(series, `${String(probe.data.data.length)} hits`);
    assertHealthySeries(series, config.runs);
  });

  it("broad term matching across the index", async () => {
    const probe = await client.search(BROAD_TERM, { limit: 50 });
    expect(probe.ok).toBe(true);
    // Against an unseeded index a broad term and a term that matches nothing
    // measure the same empty path, and both look fast. Each arm has to prove
    // its own term matches before timing it.
    expect(probe.data.data.length).toBeGreaterThan(0);

    const series = await measureSeries(
      "GET /search (broad)",
      async () => {
        const res = await client.search(BROAD_TERM, { limit: 20 });
        return res.ok;
      },
      { runs: config.runs },
    );

    logPerf(series, `${String(probe.data.data.length)} hits`);
    assertHealthySeries(series, config.runs);
  });

  it("search narrowed by type", async () => {
    const series = await measureSeries(
      "GET /search?type=core.note",
      async () => {
        const res = await client.search(runToken, {
          type: "core.note",
          limit: 20,
        });
        return (
          res.ok && res.data.data.every((r) => r.item.type === "core.note")
        );
      },
      { runs: config.runs },
    );

    logPerf(series);
    assertHealthySeries(series, config.runs);
  });

  it("term that matches nothing", async () => {
    // The empty-result path is the cheapest thing search can do. Measuring it
    // gives the floor the other two benchmarks are read against: if a
    // guaranteed-miss costs the same as a broad match, the index is not being
    // consulted before the scan.
    const missToken = `${runToken}nomatch`;

    const series = await measureSeries(
      "GET /search (no matches)",
      async () => {
        const res = await client.search(missToken, { limit: 20 });
        return res.ok && res.data.data.length === 0;
      },
      { runs: config.runs },
    );

    logPerf(series);
    assertHealthySeries(series, config.runs);
  });
});
