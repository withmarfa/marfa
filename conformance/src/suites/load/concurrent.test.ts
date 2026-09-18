/**
 * Concurrent client scaling.
 *
 * A bounded benchmark: several simulated clients issue the same operation in
 * parallel and the suite records how aggregate throughput and per-request
 * latency move as the client count rises. Concurrency stays in single digits
 * to low double digits, because the point is the shape of the curve over a
 * range a real deployment actually sees, not the point where the server gives
 * up.
 *
 * Reads and writes are measured separately and deliberately: they behave
 * differently under parallelism, and averaging them together would hide that.
 *
 * Self-cleaning: the seeded corpus and every item written during the run are
 * tracked on the test context and removed by `cleanup(ctx)` in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { Corpus } from "../../generators/corpus.js";
import { benchmarkConcurrent } from "../../utils/pool.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import {
  LOAD_TAG,
  record,
  sampleIds,
  seedCorpus,
  warmTarget,
} from "./bench.js";
import { getLoadProfile } from "./profiles.js";
import { computeMetrics, type LoadMetrics } from "./results.js";

const profile = getLoadProfile();
const { concurrency, readSamples, writeSamples, batchSize, corpusItems } =
  profile.bench;

const CORPUS_SIZE = Math.max(20, Math.round(corpusItems * 0.75));

/** One client, half the ceiling, the ceiling. Enough to see the trend. */
const READ_LEVELS = [1, Math.max(2, Math.round(concurrency / 2)), concurrency];

describe("concurrent client scaling", () => {
  let ctx: TestContext;
  let client: MarfaClient;
  let corpusIds: string[] = [];
  const corpus = new Corpus({ seed: 2207 });

  beforeAll(async () => {
    ({ ctx, client } = await createTestContext("load", "concurrent"));
    const warmMs = await warmTarget(client);
    const seeded = await seedCorpus(client, ctx, {
      count: CORPUS_SIZE,
      batchSize,
    });
    corpusIds = seeded.ids;
    console.log(
      `  warm-up ${warmMs.toFixed(0)}ms, seeded ${seeded.ids.length} items in ` +
        `${(seeded.durationMs / 1000).toFixed(1)}s — neither is sampled`,
    );
  });

  afterAll(async () => {
    await cleanup(ctx);
  });

  it("scales list throughput with parallel readers", async () => {
    const breakdown: Record<string, LoadMetrics> = {};
    const allDurations: number[] = [];
    const throughputByLevel: number[] = [];
    let errors = 0;

    for (const level of READ_LEVELS) {
      const {
        timings,
        errors: failures,
        totalDurationMs,
      } = await benchmarkConcurrent(
        async () => {
          const response = await client.listItems({
            limit: 25,
            source: ctx.source,
          });
          if (!response.ok) throw new Error(`list failed: ${response.status}`);
          return response.data.data.length;
        },
        readSamples,
        level,
      );

      const durations = timings.map((t) => t.durationMs);
      const throughput = timings.length / (totalDurationMs / 1000);
      allDurations.push(...durations);
      throughputByLevel.push(throughput);
      errors += failures.length;
      breakdown[`readers=${level}`] = computeMetrics(
        durations,
        failures.length,
        throughput,
      );
    }

    await record({
      scenario: "load.concurrent.reads",
      profile,
      itemCount: corpusIds.length,
      durations: allDurations,
      errors,
      throughput: Math.max(...throughputByLevel),
      breakdown,
    });

    expect(errors).toBe(0);
    // Reads are the half that should benefit from parallelism. A generous
    // 1.5x floor between one reader and the ceiling proves the server is
    // serving them concurrently without asserting a specific speedup.
    const [single] = throughputByLevel;
    const highest = throughputByLevel[throughputByLevel.length - 1];
    expect(highest).toBeGreaterThan(single * 1.5);
  });

  it("records write throughput under parallel writers without claiming a ceiling", async () => {
    const writes = Math.max(4, writeSamples);
    const {
      timings,
      errors: failures,
      totalDurationMs,
    } = await benchmarkConcurrent(
      async (index) => {
        const response = await client.createItem({
          type: "core.note",
          properties: { title: corpus.title(), body: corpus.body(20) },
          source_id: `conc-write-${ctx.runId}-${index}`,
          tags: [LOAD_TAG],
        });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        trackItem(ctx, response.data.item.id);
        return response.data.item.id;
      },
      writes,
      concurrency,
    );

    const durations = timings.map((t) => t.durationMs);
    const result = await record({
      scenario: "load.concurrent.writes",
      profile,
      itemCount: timings.length,
      durations,
      errors: failures.length,
      throughput: timings.length / (totalDurationMs / 1000),
    });

    expect(failures.length).toBe(0);
    expect(timings.length).toBe(writes);
    // No scaling assertion: parallel writers may simply queue behind a
    // serialized write path, which is a legitimate implementation choice.
    // What must hold is that every write lands and none is dropped.
    expect(new Set(timings.map((t) => t.result)).size).toBe(writes);
    expect(result.metrics.errors).toBe(0);
  });

  it("keeps reads correct while writes are in flight", async () => {
    const readTargets = sampleIds(corpusIds, readSamples);
    let sawWrongItem = 0;

    const {
      timings,
      errors: failures,
      totalDurationMs,
    } = await benchmarkConcurrent(
      async (index) => {
        // Every fourth operation is a write, so the reads below are competing
        // with real mutation rather than running against a quiet server.
        if (index % 4 === 3) {
          const response = await client.createItem({
            type: "core.task",
            properties: {
              title: corpus.title(),
              description: corpus.sentence(),
              status: "pending",
              priority: "low",
            },
            source_id: `conc-mixed-${ctx.runId}-${index}`,
            tags: [LOAD_TAG],
          });
          if (!response.ok)
            throw new Error(`create failed: ${response.status}`);
          trackItem(ctx, response.data.item.id);
          return "write";
        }

        const id = readTargets[index % readTargets.length];
        const response = await client.getItem(id);
        if (!response.ok) throw new Error(`get failed: ${response.status}`);
        if (response.data.item.id !== id) sawWrongItem++;
        return "read";
      },
      readSamples,
      concurrency,
    );

    const durations = timings.map((t) => t.durationMs);
    const reads = timings.filter((t) => t.result === "read");
    const writes = timings.filter((t) => t.result === "write");

    await record({
      scenario: "load.concurrent.mixed",
      profile,
      itemCount: corpusIds.length,
      durations,
      errors: failures.length,
      throughput: timings.length / (totalDurationMs / 1000),
      breakdown: {
        reads: computeMetrics(reads.map((t) => t.durationMs)),
        writes: computeMetrics(writes.map((t) => t.durationMs)),
      },
    });

    expect(failures.length).toBe(0);
    expect(sawWrongItem).toBe(0);
  });
});
