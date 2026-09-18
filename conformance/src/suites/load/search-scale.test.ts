/**
 * Full-text search against a seeded corpus.
 *
 * A bounded benchmark. It measures search latency across a handful of query
 * shapes and checks that the index returns exactly the rows it should. It does
 * not seed a corpus large enough to characterize how search degrades with
 * dataset size — that would need a target that can absorb a six-figure import,
 * which is what the larger `MARFA_LOAD_PROFILE` values are for.
 *
 * `GET /search` has no `source` filter and the index covers the whole dataset,
 * so exact result-count assertions ride on a token unique to this run rather
 * than on credential scoping. Everything else about the suite is
 * source-scoped.
 *
 * Self-cleaning: the seeded corpus is tracked on the test context and removed
 * by `cleanup(ctx)` in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext } from "../../utils/setup.js";
import { measure } from "../../utils/timing.js";
import { benchMarker, record, seedCorpus, warmTarget } from "./bench.js";
import { getLoadProfile } from "./profiles.js";
import { computeMetrics, type LoadMetrics } from "./results.js";

const profile = getLoadProfile();
const { corpusItems, batchSize, readSamples } = profile.bench;

const MARKER_EVERY = 4;
/** Samples per query shape. Enough for a p50 without spending the whole budget. */
const SAMPLES_PER_SHAPE = Math.max(3, Math.round(readSamples / 6));
/** Comfortably above the expected marked-item count so nothing is truncated. */
const SEARCH_LIMIT = Math.max(50, corpusItems);

/**
 * Newly written rows can take a moment to become visible to full-text search.
 * Poll for the expected count before measuring so an indexing lag shows up as
 * a clear failure here rather than as noise in every latency sample. Throws
 * once the deadline passes without reaching `expected`, naming the query, the
 * count actually observed, and how long it waited: a plain returned number
 * that a caller then compares would report only "wrong count," and the
 * failure message alone could not distinguish that from a real indexing bug.
 */
async function waitForIndexedCount(
  client: MarfaClient,
  query: string,
  expected: number,
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let observed = 0;
  for (;;) {
    const response = await client.search(query, { limit: SEARCH_LIMIT });
    observed = response.ok ? response.data.results.length : 0;
    if (observed >= expected) return observed;
    if (Date.now() >= deadline) {
      throw new Error(
        `search index only surfaced ${observed} of ${expected} items matching "${query}" after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe("search at scale", () => {
  let ctx: TestContext;
  let client: MarfaClient;
  let marker = "";
  let markedCount = 0;
  let corpusSize = 0;

  beforeAll(async () => {
    ({ ctx, client } = await createTestContext("load", "search-scale"));
    const warmMs = await warmTarget(client);
    marker = benchMarker(ctx, "search");

    // A single type keeps the count assertions exact: every row's marker
    // lands in the same searchable field, so a miss is an index problem
    // rather than an untested question about which fields a type indexes.
    const seeded = await seedCorpus(client, ctx, {
      count: corpusItems,
      batchSize,
      marker,
      markerEvery: MARKER_EVERY,
      types: ["core.note"],
      seed: 3301,
    });

    corpusSize = seeded.ids.length;
    markedCount = seeded.markedIds.length;
    expect(seeded.errors).toBe(0);
    console.log(
      `  warm-up ${warmMs.toFixed(0)}ms, seeded ${corpusSize} notes ` +
        `(${markedCount} carrying the run marker) in ${(seeded.durationMs / 1000).toFixed(1)}s`,
    );
  });

  afterAll(async () => {
    await cleanup(ctx);
  });

  it("returns every item carrying the run-unique marker", async () => {
    const observed = await waitForIndexedCount(client, marker, markedCount);
    expect(observed).toBe(markedCount);
  });

  it("measures latency across query shapes", async () => {
    const shapes: { label: string; run: () => Promise<number> }[] = [
      {
        label: "unique-token",
        run: async () => {
          const response = await client.search(marker, { limit: SEARCH_LIMIT });
          if (!response.ok)
            throw new Error(`search failed: ${response.status}`);
          return response.data.results.length;
        },
      },
      {
        label: "unique-token+type",
        run: async () => {
          const response = await client.search(marker, {
            type: "core.note",
            limit: SEARCH_LIMIT,
          });
          if (!response.ok)
            throw new Error(`search failed: ${response.status}`);
          return response.data.results.length;
        },
      },
      {
        label: "common-word",
        run: async () => {
          const response = await client.search("project", { limit: 20 });
          if (!response.ok)
            throw new Error(`search failed: ${response.status}`);
          return response.data.results.length;
        },
      },
      {
        label: "two-word",
        run: async () => {
          const response = await client.search("quarterly review", {
            limit: 20,
          });
          if (!response.ok)
            throw new Error(`search failed: ${response.status}`);
          return response.data.results.length;
        },
      },
      {
        label: "no-match",
        run: async () => {
          const response = await client.search(`${marker}notpresent`, {
            limit: 20,
          });
          if (!response.ok)
            throw new Error(`search failed: ${response.status}`);
          return response.data.results.length;
        },
      },
    ];

    const breakdown: Record<string, LoadMetrics> = {};
    const allDurations: number[] = [];
    let errors = 0;
    let noMatchHits = -1;

    for (const shape of shapes) {
      const durations: number[] = [];
      for (let i = 0; i < SAMPLES_PER_SHAPE; i++) {
        try {
          const { result, durationMs } = await measure(shape.run);
          durations.push(durationMs);
          if (shape.label === "no-match") noMatchHits = result;
        } catch {
          errors++;
        }
      }
      allDurations.push(...durations);
      breakdown[shape.label] = computeMetrics(durations);
    }

    const result = await record({
      scenario: "load.search-scale.queries",
      profile,
      itemCount: corpusSize,
      durations: allDurations,
      errors,
      breakdown,
    });

    expect(errors).toBe(0);
    expect(noMatchHits).toBe(0);
    // Wide bound: this catches a hung index, not a service level.
    expect(result.metrics.p95).toBeLessThan(30_000);
  });

  it("narrows search by state without losing the marked set", async () => {
    const response = await client.search(marker, {
      state: "active",
      limit: SEARCH_LIMIT,
    });
    expect(response.ok).toBe(true);
    // Every seeded row is active, so a state filter must not shrink the set.
    expect(response.data.results.length).toBe(markedCount);
    for (const hit of response.data.results) {
      expect(hit.item.state).toBe("active");
    }
  });
});
