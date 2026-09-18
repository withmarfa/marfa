/**
 * Sustained write throughput.
 *
 * A bounded benchmark, not a stress test. It answers two questions and claims
 * nothing beyond them: what a bulk call costs per item as the batch grows, and
 * what a single-item write stream sustains. Whether a larger batch amortizes
 * per-item cost is a result to read off the breakdown, not an assumption baked
 * into the test. It does not push writes until they degrade, so no number here
 * describes a limit.
 *
 * Self-cleaning: every created id is tracked on the test context and removed
 * by `cleanup(ctx)` in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { Corpus } from "../../generators/corpus.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { measure } from "../../utils/timing.js";
import { LOAD_TAG, record, warmTarget } from "./bench.js";
import { getLoadProfile } from "./profiles.js";
import { computeMetrics, type LoadMetrics } from "./results.js";

const profile = getLoadProfile();
const { batchSize, writeSamples } = profile.bench;

/**
 * Three points on the batch-size curve. The smallest is where per-call
 * overhead is still visible; the largest is the profile's working batch size.
 */
const BATCH_SIZES = [
  Math.max(5, Math.round(batchSize / 4)),
  Math.max(10, Math.round(batchSize / 2)),
  batchSize,
];

describe("sustained write throughput", () => {
  let ctx: TestContext;
  let client: MarfaClient;
  const corpus = new Corpus({ seed: 1301 });

  beforeAll(async () => {
    ({ ctx, client } = await createTestContext("load", "write-throughput"));
    const warmMs = await warmTarget(client);
    console.log(
      `  warm-up ${warmMs.toFixed(0)}ms — excluded from every sample below`,
    );
  });

  afterAll(async () => {
    await cleanup(ctx);
  });

  it("measures bulk write cost across batch sizes", async () => {
    const breakdown: Record<string, LoadMetrics> = {};
    const perItemMs: number[] = [];
    let totalItems = 0;
    let errors = 0;

    for (const size of BATCH_SIZES) {
      const items = Array.from({ length: size }, (_, i) => ({
        type: "core.note",
        properties: { title: corpus.title(), body: corpus.body(25) },
        source_id: `wt-bulk-${size}-${ctx.runId}-${i}`,
        tags: [LOAD_TAG],
      }));

      const { result, durationMs } = await measure(() =>
        client.bulkItems({ items, mode: "create_only", atomic: false }),
      );

      expect(result.status).toBe(200);
      const created = result.data.counts.created;
      errors += result.data.counts.errored;
      totalItems += created;
      for (const entry of result.data.results) {
        if (entry.id) trackItem(ctx, entry.id);
      }

      const msPerItem = durationMs / Math.max(1, created);
      perItemMs.push(msPerItem);
      breakdown[`batch=${size}`] = computeMetrics(
        [durationMs],
        result.data.counts.errored,
        created / (durationMs / 1000),
      );
    }

    const result = await record({
      scenario: "load.write-throughput.bulk",
      profile,
      itemCount: totalItems,
      durations: perItemMs,
      errors,
      throughput:
        1000 / (perItemMs.reduce((a, b) => a + b, 0) / perItemMs.length),
      breakdown,
    });

    expect(errors).toBe(0);
    expect(totalItems).toBe(BATCH_SIZES.reduce((a, b) => a + b, 0));
    // Order-of-magnitude sanity only: whatever else the run is doing can halve
    // the rate at any moment, so this catches "writes stopped working", not a
    // service level.
    expect(result.metrics.throughput).toBeGreaterThan(0.2);
  });

  it("sustains a single-item write stream", async () => {
    const durations: number[] = [];
    let errors = 0;
    const start = performance.now();

    for (let i = 0; i < writeSamples; i++) {
      const { result, durationMs } = await measure(() =>
        client.createItem({
          type: "core.note",
          properties: { title: corpus.title(), body: corpus.body(25) },
          source_id: `wt-single-${ctx.runId}-${i}`,
          tags: [LOAD_TAG],
        }),
      );
      if (result.ok) {
        trackItem(ctx, result.data.item.id);
        durations.push(durationMs);
      } else {
        errors++;
      }
    }

    const elapsedSec = (performance.now() - start) / 1000;
    const result = await record({
      scenario: "load.write-throughput.single",
      profile,
      itemCount: durations.length,
      durations,
      errors,
      throughput: durations.length / elapsedSec,
    });

    expect(errors).toBe(0);
    expect(durations.length).toBe(writeSamples);
    // Wide bound: this catches a write path that hangs, not one that is merely
    // slower than the last run.
    expect(result.metrics.p95).toBeLessThan(60_000);
  });
});
