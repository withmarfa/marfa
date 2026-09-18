/**
 * Export streaming.
 *
 * A bounded benchmark over `GET /export`. It separates the two numbers that
 * matter for a streaming endpoint — time to the first record, and time to
 * drain the rest — and checks that a source-scoped export returns exactly the
 * rows the calling credential wrote, no more and no fewer.
 *
 * Every export here is narrowed to this file's own credential `source`. An
 * unscoped export streams the whole dataset, which makes the measurement about
 * every other file's rows rather than this one's.
 *
 * Self-cleaning: the seeded corpus is tracked on the test context and removed
 * by `cleanup(ctx)` in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { cleanup, createTestContext } from "../../utils/setup.js";
import { record, seedCorpus, streamExport, warmTarget } from "./bench.js";
import { getLoadProfile } from "./profiles.js";
import { computeMetrics } from "./results.js";

const profile = getLoadProfile();
const { corpusItems, batchSize } = profile.bench;

/** Repeats of the full export. Three points give a median without overspending. */
const EXPORT_REPEATS = 3;

describe("export stream performance", () => {
  let ctx: TestContext;
  let client: MarfaClient;
  let apiUrl = "";
  let apiKey = "";
  let corpusSize = 0;
  let noteCount = 0;

  beforeAll(async () => {
    ({ ctx, client, apiUrl, apiKey } = await createTestContext(
      "load",
      "export-stream",
    ));
    const warmMs = await warmTarget(client);
    const seeded = await seedCorpus(client, ctx, {
      count: corpusItems,
      batchSize,
      seed: 4409,
    });
    corpusSize = seeded.ids.length;
    noteCount = seeded.idsByType["core.note"]?.length ?? 0;
    expect(seeded.errors).toBe(0);
    console.log(
      `  warm-up ${warmMs.toFixed(0)}ms, seeded ${corpusSize} items ` +
        `(${noteCount} notes) in ${(seeded.durationMs / 1000).toFixed(1)}s`,
    );
  });

  afterAll(async () => {
    await cleanup(ctx);
  });

  it("streams exactly the rows written under this credential", async () => {
    const stats = await streamExport(apiUrl, apiKey, { source: ctx.source });

    expect(stats.status).toBe(200);
    expect(stats.lines).toBe(corpusSize);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it("measures time-to-first-record separately from full drain", async () => {
    const firstByte: number[] = [];
    const total: number[] = [];
    let bytes = 0;
    let lines = 0;
    let errors = 0;

    for (let i = 0; i < EXPORT_REPEATS; i++) {
      const stats = await streamExport(apiUrl, apiKey, { source: ctx.source });
      if (stats.status !== 200) {
        errors++;
        continue;
      }
      firstByte.push(stats.firstByteMs);
      total.push(stats.totalMs);
      bytes = stats.bytes;
      lines = stats.lines;
    }

    const medianTotalSec =
      total.slice().sort((a, b) => a - b)[Math.floor(total.length / 2)] / 1000;

    const result = await record({
      scenario: "load.export-stream.ndjson",
      profile,
      itemCount: corpusSize,
      durations: total,
      errors,
      throughput: lines / medianTotalSec,
      breakdown: {
        "time-to-first-record": computeMetrics(firstByte),
        "full-drain": computeMetrics(total),
      },
    });

    console.log(
      `  exported ${lines} records / ${(bytes / 1024).toFixed(0)}KB per pass`,
    );

    expect(errors).toBe(0);
    expect(result.metrics.runs).toBe(EXPORT_REPEATS);
    // The first record must arrive well before the stream finishes, or the
    // response was buffered end-to-end and nothing about it was streamed.
    //
    // `<=` alone could not fail: first-byte time is measured as a prefix of
    // total time, so it is bounded by it by construction, and a body buffered
    // end-to-end would pass it. A real stream delivers its first record in a
    // small fraction of the total, so that is what gets asserted.
    const medianFirstByte = firstByte.slice().sort((a, b) => a - b)[
      Math.floor(firstByte.length / 2)
    ];
    expect(medianFirstByte).toBeLessThan(result.metrics.p50 * 0.5);
  });

  it("narrows the export by type", async () => {
    const stats = await streamExport(apiUrl, apiKey, {
      source: ctx.source,
      type: "core.note",
    });

    expect(stats.status).toBe(200);
    expect(stats.lines).toBe(noteCount);
    expect(stats.lines).toBeLessThan(corpusSize);
  });
});
