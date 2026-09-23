/**
 * Metadata operations against a seeded corpus.
 *
 * A bounded benchmark over the tag sidecar: sequential and parallel tag
 * writes, tag removal, and the tag-filtered list that reads them back. The
 * sample counts come from the profile, so this measures what the operations
 * cost — it never raises the rate until something fails.
 *
 * Tags applied here carry a run-unique suffix, so the read-back assertions do
 * not depend on what else is tagged in the dataset.
 *
 * Self-cleaning: the seeded corpus is tracked on the test context and removed
 * by `cleanup(ctx)` in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { benchmarkConcurrent } from "../../utils/pool.js";
import { cleanup, createTestContext } from "../../utils/setup.js";
import { measure } from "../../utils/timing.js";
import {
  LOAD_TAG,
  record,
  sampleIds,
  seedCorpus,
  warmTarget,
} from "./bench.js";
import { getLoadProfile } from "./profiles.js";
import { computeMetrics } from "./results.js";

const profile = getLoadProfile();
const { corpusItems, batchSize, writeSamples, readSamples, concurrency } =
  profile.bench;

const CORPUS_SIZE = Math.max(20, Math.round(corpusItems / 2));
/**
 * Metadata writes cost about what item writes cost, so the parallel pass is
 * kept well below the read concurrency ceiling. The goal is to observe how
 * they behave with a few writers in flight, not to fill a queue.
 */
const WRITE_CONCURRENCY = Math.min(6, concurrency);

describe("metadata operations at scale", () => {
  let ctx: TestContext;
  let client: MarfaClient;
  let corpusIds: string[] = [];
  let runTag = "";

  beforeAll(async () => {
    ({ ctx, client } = await createTestContext("load", "metadata-stress"));
    const warmMs = await warmTarget(client);
    runTag = `bench-meta-${ctx.runId}`;
    const seeded = await seedCorpus(client, ctx, {
      count: CORPUS_SIZE,
      batchSize,
      seed: 5501,
    });
    corpusIds = seeded.ids;
    expect(seeded.errors).toBe(0);
    console.log(
      `  warm-up ${warmMs.toFixed(0)}ms, seeded ${corpusIds.length} items in ` +
        `${(seeded.durationMs / 1000).toFixed(1)}s`,
    );
  });

  afterAll(async () => {
    await cleanup(ctx);
  });

  it("measures sequential tag writes", async () => {
    const targets = sampleIds(corpusIds, writeSamples);
    const durations: number[] = [];
    let errors = 0;
    const start = performance.now();

    for (const id of targets) {
      const { result, durationMs } = await measure(() =>
        // The tag list replaces wholesale, so LOAD_TAG is restated to keep the
        // sweep-by-tag cleanup backstop working on these rows.
        client.updateMetadata(id, { tags: [LOAD_TAG, runTag] }),
      );
      if (result.ok) durations.push(durationMs);
      else errors++;
    }

    const elapsedSec = (performance.now() - start) / 1000;
    await record({
      scenario: "load.metadata-stress.sequential",
      profile,
      itemCount: corpusIds.length,
      durations,
      errors,
      throughput: durations.length / elapsedSec,
    });

    expect(errors).toBe(0);
    expect(durations.length).toBe(targets.length);
  });

  it("measures parallel tag writes", async () => {
    const targets = sampleIds(corpusIds, writeSamples).reverse();
    const { timings, errors, totalDurationMs } = await benchmarkConcurrent(
      async (index) => {
        const id = targets[index % targets.length];
        const response = await client.updateMetadata(id, {
          tags: [LOAD_TAG, runTag, `parallel-${index}`],
        });
        if (!response.ok)
          throw new Error(`metadata write failed: ${response.status}`);
        return id;
      },
      targets.length,
      WRITE_CONCURRENCY,
    );

    await record({
      scenario: "load.metadata-stress.parallel",
      profile,
      itemCount: corpusIds.length,
      durations: timings.map((t) => t.durationMs),
      errors: errors.length,
      throughput: timings.length / (totalDurationMs / 1000),
    });

    expect(errors.length).toBe(0);
    expect(timings.length).toBe(targets.length);
  });

  it("reads the written tags back through the tag filter", async () => {
    const durations: number[] = [];
    let errors = 0;

    for (let i = 0; i < Math.max(3, Math.round(readSamples / 8)); i++) {
      const { result, durationMs } = await measure(() =>
        client.listItems({ tags: [runTag], source: ctx.source, limit: 100 }),
      );
      if (!result.ok) {
        errors++;
        continue;
      }
      durations.push(durationMs);
    }

    // Counted by paging rather than from the timed call, whose page size is
    // the server's ceiling: the larger profiles tag more rows than one page
    // can return, so reading the count off a single response would compare a
    // page limit against a sample count and fail wherever they differ.
    // Unmeasured deliberately — it is a completeness check, not the operation
    // being benchmarked.
    let observed = 0;
    let cursor: string | undefined;
    do {
      const page = await client.listItems({
        tags: [runTag],
        source: ctx.source,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.ok).toBe(true);
      if (!page.ok) break;
      observed += page.data.data.length;
      // A cursor echoed back would loop forever, and this test would hang
      // rather than fail.
      const next = page.data.next_cursor ?? undefined;
      expect(next === undefined || next !== cursor).toBe(true);
      cursor = next;
    } while (cursor);

    await record({
      scenario: "load.metadata-stress.tag-filter",
      profile,
      itemCount: corpusIds.length,
      durations,
      errors,
      breakdown: { "tag-filtered-list": computeMetrics(durations) },
    });

    expect(errors).toBe(0);
    // Both write passes target the same sampled rows, so every sampled row
    // must carry the tag. Distinct, because a sample larger than the corpus
    // wraps and asks for some rows twice. Exact, not a lower bound: a server
    // writing one sidecar in ten and answering 200 to the rest would satisfy
    // any floor above zero while losing most of the writes.
    expect(observed).toBe(new Set(sampleIds(corpusIds, writeSamples)).size);
  });

  it("removes a tag without disturbing the rest of the sidecar", async () => {
    const listed = await client.listItems({
      tags: [runTag],
      source: ctx.source,
      limit: 10,
    });
    expect(listed.ok).toBe(true);
    const targets = listed.data.data.slice(
      0,
      Math.min(3, listed.data.data.length),
    );
    expect(targets.length).toBeGreaterThan(0);

    const durations: number[] = [];
    for (const item of targets) {
      const { result, durationMs } = await measure(() =>
        client.removeTag(item.id, runTag),
      );
      expect(result.ok).toBe(true);
      durations.push(durationMs);
      expect(result.data.metadata.tags).not.toContain(runTag);
      expect(result.data.metadata.tags).toContain(LOAD_TAG);
    }

    await record({
      scenario: "load.metadata-stress.tag-removal",
      profile,
      itemCount: targets.length,
      durations,
    });
  });
});
