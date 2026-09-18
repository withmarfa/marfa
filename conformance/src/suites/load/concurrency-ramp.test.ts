/**
 * Concurrency ramp.
 *
 * Steps concurrency through a fixed ladder from the profile and records
 * latency, error rate, and throughput at each rung. Reads and writes are
 * ramped separately, because they respond to parallelism differently and one
 * curve would hide the other.
 *
 * **This does not look for a breaking point.** The ladder is bounded and every
 * rung is expected to pass; the output describes how the target behaves across
 * a range a real deployment sees, not where it fails. Finding a saturation
 * point means ramping until errors appear, which needs a target you are
 * willing to degrade and a ladder with no ceiling — neither is true here, and
 * reporting a limit that was never reached would be a fabrication. A rung that
 * does fail is a genuine finding, and the assertions below surface it.
 *
 * Self-cleaning: the seeded corpus and every item the write ramp creates are
 * tracked on the test context and removed by `cleanup(ctx)` in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { Corpus } from "../../generators/corpus.js";
import { rampUp } from "../../utils/pool.js";
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
const { corpusItems, batchSize, rampLevels, readSamples, writeSamples } =
  profile.bench;

const CORPUS_SIZE = Math.max(20, Math.round(corpusItems / 2));
/** Same run count at every rung, so rungs are directly comparable. */
const READ_RUNS_PER_LEVEL = Math.max(
  rampLevels[rampLevels.length - 1],
  Math.round(readSamples / 2),
);
/**
 * Writes cost an order of magnitude more per operation than reads, so the
 * write ladder is truncated and sampled thinly. Whether extra writers buy any
 * throughput is the question the rungs answer, not an assumption behind them.
 */
const WRITE_LEVELS = rampLevels.filter((level) => level <= 8);
const WRITE_RUNS_PER_LEVEL = Math.max(2, Math.round(writeSamples / 2));

interface RungSummary {
  concurrency: number;
  p50: number;
  p95: number;
  errors: number;
  throughput: number;
}

function summarize(
  levels: {
    concurrency: number;
    timings: number[];
    errors: number;
    durationMs: number;
  }[],
): {
  rungs: RungSummary[];
  breakdown: Record<string, LoadMetrics>;
  durations: number[];
  errors: number;
} {
  const rungs: RungSummary[] = [];
  const breakdown: Record<string, LoadMetrics> = {};
  const durations: number[] = [];
  let errors = 0;

  for (const level of levels) {
    const sorted = [...level.timings].sort((a, b) => a - b);
    const throughput = level.timings.length / (level.durationMs / 1000);
    const metrics = computeMetrics(sorted, level.errors, throughput);
    breakdown[`c=${level.concurrency}`] = metrics;
    durations.push(...level.timings);
    errors += level.errors;
    rungs.push({
      concurrency: level.concurrency,
      p50: metrics.p50,
      p95: metrics.p95,
      errors: level.errors,
      throughput,
    });
  }

  return { rungs, breakdown, durations, errors };
}

function logRungs(label: string, rungs: RungSummary[]): void {
  console.log(`  ${label} ramp (bounded ladder, no saturation claimed):`);
  for (const rung of rungs) {
    console.log(
      `    c=${String(rung.concurrency).padStart(3)} ` +
        `p50=${rung.p50.toFixed(0).padStart(6)}ms ` +
        `p95=${rung.p95.toFixed(0).padStart(6)}ms ` +
        `${rung.throughput.toFixed(1).padStart(6)} ops/s ` +
        `errors=${rung.errors}`,
    );
  }
}

describe("concurrency ramp", () => {
  let ctx: TestContext;
  let client: MarfaClient;
  let corpusIds: string[] = [];
  const corpus = new Corpus({ seed: 9901 });

  beforeAll(async () => {
    ({ ctx, client } = await createTestContext("load", "concurrency-ramp"));
    const warmMs = await warmTarget(client);
    const seeded = await seedCorpus(client, ctx, {
      count: CORPUS_SIZE,
      batchSize,
      seed: 9901,
    });
    corpusIds = seeded.ids;
    expect(seeded.errors).toBe(0);
    console.log(
      `  warm-up ${warmMs.toFixed(0)}ms, seeded ${corpusIds.length} items in ` +
        `${(seeded.durationMs / 1000).toFixed(1)}s — neither is sampled`,
    );
  });

  afterAll(async () => {
    await cleanup(ctx);
  });

  it("ramps read concurrency through the ladder", async () => {
    const targets = sampleIds(corpusIds, READ_RUNS_PER_LEVEL);
    let call = 0;

    const { levels } = await rampUp(
      async () => {
        const id = targets[call++ % targets.length];
        const response = await client.getItem(id);
        // Thrown so the pool counts it — the client returns errors as data.
        if (!response.ok) throw new Error(`get failed: ${response.status}`);
        return response.data.item.id;
      },
      rampLevels,
      READ_RUNS_PER_LEVEL,
    );

    const { rungs, breakdown, durations, errors } = summarize(levels);
    logRungs("read", rungs);

    await record({
      scenario: "load.concurrency-ramp.reads",
      profile,
      itemCount: corpusIds.length,
      durations,
      errors,
      throughput: Math.max(...rungs.map((r) => r.throughput)),
      breakdown,
    });

    expect(errors).toBe(0);
    expect(rungs.length).toBe(rampLevels.length);
    // Reads should get cheaper per unit time as readers are added. Comparing
    // the top rung against the single-client rung is a loose check that the
    // server serves them in parallel at all.
    const first = rungs[0];
    const last = rungs[rungs.length - 1];
    expect(last.throughput).toBeGreaterThan(first.throughput);
  });

  it("ramps write concurrency through a truncated ladder", async () => {
    let call = 0;

    const { levels } = await rampUp(
      async () => {
        const index = call++;
        const response = await client.createItem({
          type: "core.note",
          properties: { title: corpus.title(), body: corpus.body(15) },
          source_id: `ramp-${ctx.runId}-${index}`,
          tags: [LOAD_TAG],
        });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        trackItem(ctx, response.data.item.id);
        return response.data.item.id;
      },
      WRITE_LEVELS,
      WRITE_RUNS_PER_LEVEL,
    );

    const { rungs, breakdown, durations, errors } = summarize(levels);
    logRungs("write", rungs);

    await record({
      scenario: "load.concurrency-ramp.writes",
      profile,
      itemCount: WRITE_LEVELS.length * WRITE_RUNS_PER_LEVEL,
      durations,
      errors,
      throughput: Math.max(...rungs.map((r) => r.throughput)),
      breakdown,
    });

    expect(errors).toBe(0);
    expect(rungs.length).toBe(WRITE_LEVELS.length);
    // No throughput-scaling assertion for writes. A server that serializes
    // them will show flat throughput and rising latency, which is a valid
    // design, not a failure. What must hold is that every write succeeded.
    for (const rung of rungs) {
      expect(rung.errors).toBe(0);
      expect(rung.throughput).toBeGreaterThan(0);
    }
  });
});
