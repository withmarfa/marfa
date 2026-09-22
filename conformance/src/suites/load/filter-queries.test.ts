/**
 * Filter query performance.
 *
 * A bounded benchmark across the shapes of the `filter=` grammar — system
 * fields, property paths, tag membership, presence, and a conjunction — plus
 * the plain query-parameter narrowing they compete with. It records what each
 * shape costs against a modest corpus. It does not grow the corpus until a
 * shape falls over, so nothing here says where an index stops helping.
 *
 * Every query is scoped to this file's credential `source`, so another file's
 * rows cannot inflate the result sets.
 *
 * Self-cleaning: the seeded corpus is tracked on the test context and removed
 * by `cleanup(ctx)` in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { MarfaItem, TestContext } from "../../client/types.js";
import { cleanup, createTestContext } from "../../utils/setup.js";
import { measure } from "../../utils/timing.js";
import { record, seedCorpus, warmTarget } from "./bench.js";
import { getLoadProfile } from "./profiles.js";
import { computeMetrics, type LoadMetrics } from "./results.js";

const profile = getLoadProfile();
const { corpusItems, batchSize, readSamples } = profile.bench;

const SAMPLES_PER_SHAPE = Math.max(2, Math.round(readSamples / 8));
const PAGE_LIMIT = 50;

describe("filter query performance", () => {
  let ctx: TestContext;
  let client: MarfaClient;
  let runTag = "";
  let corpusSize = 0;

  /** Run one filter shape and hand back the page it produced. */
  async function runFilter(expression: string): Promise<MarfaItem[]> {
    const response = await client.listItems({
      source: ctx.source,
      filter: expression,
      limit: PAGE_LIMIT,
    });
    if (!response.ok) {
      throw new Error(
        `filter ${JSON.stringify(expression)} failed ${response.status}: ` +
          `${response.error?.error?.message ?? "no message"}`,
      );
    }
    return response.data.data;
  }

  beforeAll(async () => {
    ({ ctx, client } = await createTestContext("load", "filter-queries"));
    const warmMs = await warmTarget(client);
    runTag = `bench-filter-${ctx.runId}`;
    const seeded = await seedCorpus(client, ctx, {
      count: corpusItems,
      batchSize,
      tags: [runTag],
      seed: 6607,
    });
    corpusSize = seeded.ids.length;
    expect(seeded.errors).toBe(0);
    console.log(
      `  warm-up ${warmMs.toFixed(0)}ms, seeded ${corpusSize} items across ` +
        `${Object.keys(seeded.idsByType).length} types in ${(seeded.durationMs / 1000).toFixed(1)}s`,
    );
  });

  afterAll(async () => {
    await cleanup(ctx);
  });

  it("measures latency across filter shapes", async () => {
    const shapes: { label: string; run: () => Promise<unknown> }[] = [
      {
        label: "param-narrowing",
        run: async () => {
          const response = await client.listItems({
            source: ctx.source,
            type: "core.note",
            limit: PAGE_LIMIT,
          });
          if (!response.ok) throw new Error(`list failed: ${response.status}`);
          return response.data.data;
        },
      },
      { label: "system-field-eq", run: () => runFilter('type eq "core.note"') },
      {
        label: "tag-membership",
        run: () => runFilter(`tags contains "${runTag}"`),
      },
      {
        label: "conjunction",
        run: () => runFilter('state eq "active" AND type eq "core.task"'),
      },
      {
        label: "property-eq",
        run: () => runFilter('properties.priority eq "high"'),
      },
      {
        label: "property-prefix",
        run: () => runFilter('properties.title starts_with "A"'),
      },
      // `exists` is a property/metadata operator. System fields reject it —
      // they always exist, so the server treats the clause as a mistake.
      { label: "presence", run: () => runFilter("properties.title exists") },
    ];

    const breakdown: Record<string, LoadMetrics> = {};
    const allDurations: number[] = [];
    let errors = 0;

    for (const shape of shapes) {
      const durations: number[] = [];
      for (let i = 0; i < SAMPLES_PER_SHAPE; i++) {
        try {
          const { durationMs } = await measure(shape.run);
          durations.push(durationMs);
        } catch (err) {
          errors++;
          console.warn(
            `  ${shape.label}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      allDurations.push(...durations);
      breakdown[shape.label] = computeMetrics(durations);
    }

    const result = await record({
      scenario: "load.filter-queries.shapes",
      profile,
      itemCount: corpusSize,
      durations: allDurations,
      errors,
      breakdown,
    });

    expect(errors).toBe(0);
    expect(result.metrics.runs).toBe(shapes.length * SAMPLES_PER_SHAPE);
    // Wide bound: this catches a query that hangs, not one that is merely
    // slower than the last run.
    expect(result.metrics.p95).toBeLessThan(30_000);
  });

  it("narrows correctly, not just quickly", async () => {
    const notes = await runFilter('type eq "core.note"');
    expect(notes.length).toBeGreaterThan(0);
    for (const item of notes) expect(item.type).toBe("core.note");

    const tagged = await runFilter(`tags contains "${runTag}"`);
    expect(tagged.length).toBeGreaterThan(0);

    const negation = await runFilter('type neq "core.note"');
    // Guarded, like the assertions either side of it. Without the count a
    // `neq` matching nothing gives an empty loop and a pass, which is the
    // filter being broken rather than working.
    expect(negation.length).toBeGreaterThan(0);
    for (const item of negation) expect(item.type).not.toBe("core.note");

    const nothing = await runFilter(
      'properties.priority eq "no-such-priority"',
    );
    expect(nothing.length).toBe(0);
  });

  it("pages a filtered result set without repeating rows", async () => {
    const pageSize = Math.max(5, Math.floor(corpusSize / 4));
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    const durations: number[] = [];

    // Bounded so a server that never answers a null cursor fails on the assertion
    // below rather than looping until the test times out.
    const maxPages = Math.ceil(corpusSize / pageSize) + 2;

    while (pages < maxPages) {
      const { result, durationMs } = await measure(() =>
        client.listItems({
          source: ctx.source,
          filter: `tags contains "${runTag}"`,
          limit: pageSize,
          cursor,
        }),
      );
      expect(result.ok).toBe(true);
      durations.push(durationMs);
      pages++;

      for (const item of result.data.data) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }

      if (result.data.next_cursor === null) break;
      cursor = result.data.next_cursor;
    }

    await record({
      scenario: "load.filter-queries.pagination",
      profile,
      itemCount: corpusSize,
      durations,
      throughput: seen.size / (durations.reduce((a, b) => a + b, 0) / 1000),
    });

    expect(pages).toBeLessThan(maxPages);
    expect(seen.size).toBe(corpusSize);
  });
});
