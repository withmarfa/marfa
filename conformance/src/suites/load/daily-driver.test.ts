/**
 * Daily driver simulation.
 *
 * A bounded mixed-workload benchmark: a few simulated clients run the request
 * mix a real Marfa client produces — mostly browsing and opening items, some
 * searching, occasional writes — for a fixed wall-clock budget from the
 * profile. The value is the shape of the result: how a read-dominant mix
 * behaves when writes are interleaved with it, per operation.
 *
 * The mix is a fixed rotation rather than a random draw, so two runs issue the
 * same proportions and are comparable. The run stops on the clock, not on an
 * error, and makes no claim about sustainable load beyond the window measured.
 *
 * Self-cleaning: the seeded corpus and every item the workload writes are
 * tracked on the test context and removed by `cleanup(ctx)` in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { Corpus } from "../../generators/corpus.js";
import { runForDuration } from "../../utils/pool.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import {
  LOAD_TAG,
  benchMarker,
  record,
  sampleIds,
  seedCorpus,
  warmTarget,
} from "./bench.js";
import { getLoadProfile } from "./profiles.js";
import { computeMetrics, type LoadMetrics } from "./results.js";

const profile = getLoadProfile();
const { corpusItems, batchSize, concurrency, mixedDurationMs, readSamples } =
  profile.bench;

const CORPUS_SIZE = Math.max(20, Math.round(corpusItems * 0.75));
/** A daily driver is a handful of clients, not a fleet. */
const CLIENTS = Math.max(2, Math.round(concurrency / 2));

type Operation = "browse" | "open" | "search" | "create" | "tag";

/**
 * One rotation of twenty operations, weighted the way a note-taking client
 * behaves over a session: eight browses, five opens, four searches, two
 * creates, one tag edit. Reads dominate because that is what clients do; the
 * writes are here so the reads are measured against a moving dataset.
 */
const MIX: Operation[] = [
  "browse",
  "open",
  "search",
  "browse",
  "open",
  "create",
  "browse",
  "search",
  "open",
  "browse",
  "tag",
  "open",
  "browse",
  "search",
  "open",
  "browse",
  "create",
  "search",
  "browse",
  "browse",
];

describe("daily driver simulation", () => {
  let ctx: TestContext;
  let client: MarfaClient;
  let corpusIds: string[] = [];
  let marker = "";
  const corpus = new Corpus({ seed: 8807 });

  beforeAll(async () => {
    ({ ctx, client } = await createTestContext("load", "daily-driver"));
    const warmMs = await warmTarget(client);
    marker = benchMarker(ctx, "daily");
    const seeded = await seedCorpus(client, ctx, {
      count: CORPUS_SIZE,
      batchSize,
      marker,
      markerEvery: 4,
      seed: 8807,
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

  it("runs a realistic read-dominant mix for a fixed window", async () => {
    const openTargets = sampleIds(corpusIds, Math.max(5, readSamples));
    const perOperation: Record<Operation, number[]> = {
      browse: [],
      open: [],
      search: [],
      create: [],
      tag: [],
    };
    let step = 0;

    const { timings, errors, totalDurationMs } = await runForDuration(
      async () => {
        const index = step++;
        const operation = MIX[index % MIX.length];
        const start = performance.now();

        switch (operation) {
          case "browse": {
            const response = await client.listItems({
              source: ctx.source,
              limit: 25,
              sort: "created_at",
              direction: "desc",
            });
            if (!response.ok)
              throw new Error(`browse failed: ${response.status}`);
            break;
          }
          case "open": {
            const id = openTargets[index % openTargets.length];
            const response = await client.getItem(id);
            if (!response.ok)
              throw new Error(`open failed: ${response.status}`);
            break;
          }
          case "search": {
            const response = await client.search(marker, { limit: 20 });
            if (!response.ok)
              throw new Error(`search failed: ${response.status}`);
            break;
          }
          case "create": {
            const response = await client.createItem({
              type: "core.note",
              properties: { title: corpus.title(), body: corpus.body(20) },
              source_id: `daily-${ctx.runId}-${index}`,
              tags: [LOAD_TAG],
            });
            if (!response.ok)
              throw new Error(`create failed: ${response.status}`);
            trackItem(ctx, response.data.item.id);
            break;
          }
          case "tag": {
            const id = openTargets[index % openTargets.length];
            const response = await client.updateMetadata(id, {
              tags: [LOAD_TAG, `daily-${index % 5}`],
            });
            if (!response.ok) throw new Error(`tag failed: ${response.status}`);
            break;
          }
        }

        perOperation[operation].push(performance.now() - start);
        return operation;
      },
      mixedDurationMs,
      CLIENTS,
    );

    const breakdown: Record<string, LoadMetrics> = {};
    for (const [operation, durations] of Object.entries(perOperation)) {
      breakdown[operation] = computeMetrics(durations);
    }

    const result = await record({
      scenario: "load.daily-driver.mixed",
      profile,
      itemCount: corpusIds.length,
      durations: timings.map((t) => t.durationMs),
      errors: errors.length,
      throughput: timings.length / (totalDurationMs / 1000),
      breakdown,
    });

    console.log(
      `  ${timings.length} operations from ${CLIENTS} clients over ` +
        `${(totalDurationMs / 1000).toFixed(1)}s`,
    );

    expect(errors.length).toBe(0);
    // Every arm of the mix must have executed, otherwise the window was too
    // short for the rotation and the breakdown misrepresents the workload.
    for (const operation of Object.keys(perOperation) as Operation[]) {
      expect(perOperation[operation].length).toBeGreaterThan(0);
    }
    expect(result.metrics.throughput).toBeGreaterThan(0);
  });

  it("leaves the corpus readable and consistent after the mixed run", async () => {
    const response = await client.listItems({ source: ctx.source, limit: 100 });
    expect(response.ok).toBe(true);
    // The workload only ever adds rows, so the corpus cannot have shrunk.
    const visible =
      response.data.next_cursor !== null ? 100 : response.data.data.length;
    expect(visible).toBeGreaterThanOrEqual(Math.min(100, corpusIds.length));

    const probe = await client.getItem(corpusIds[0]);
    expect(probe.ok).toBe(true);
    expect(probe.data.item.state).toBe("active");
  });
});
