/**
 * CRUD micro-benchmarks.
 *
 * A per-operation latency table: create, read, update, list, transition, and
 * delete, each sampled sequentially so the numbers describe one operation's
 * cost rather than a queue's behavior. Sample counts come from the profile and
 * stay small; this is a baseline for comparison across runs, not a search for
 * the point where an operation degrades.
 *
 * Self-cleaning: every created id is tracked on the test context. The delete
 * benchmark removes some of those rows itself; `cleanup(ctx)` in `afterAll`
 * tolerates the resulting 404s and removes the rest.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { Corpus } from "../../generators/corpus.js";
import { cleanup, createTestContext, trackItem } from "../../utils/setup.js";
import { measure } from "../../utils/timing.js";
import { LOAD_TAG, record, sampleIds, warmTarget } from "./bench.js";
import { getLoadProfile } from "./profiles.js";
import { computeMetrics, type LoadMetrics } from "./results.js";

const profile = getLoadProfile();
const { writeSamples, readSamples } = profile.bench;

const LIST_SAMPLES = Math.max(4, Math.round(readSamples / 3));
/**
 * Write-shaped operations are an order of magnitude more expensive than reads
 * on a small target, so they are sampled more thinly. `create` keeps the full
 * count because its rows are the read and update targets for the rest of the
 * file.
 */
const UPDATE_SAMPLES = Math.max(3, Math.round(writeSamples / 2));
const MUTATION_SAMPLES = Math.max(3, Math.round(writeSamples / 3));

describe("CRUD micro-benchmarks", () => {
  let ctx: TestContext;
  let client: MarfaClient;
  const corpus = new Corpus({ seed: 7703 });
  /** Rows created by the create benchmark, reused as read/update targets. */
  const created: string[] = [];
  /**
   * The version each row was last seen at. The update door requires the
   * version the caller read, and the create benchmark is the read: holding it
   * here keeps the measured call one PATCH rather than a GET plus a PATCH,
   * which would make the update number describe two round trips.
   */
  const versions = new Map<string, number>();
  const breakdown: Record<string, LoadMetrics> = {};
  /** Every measured sample, across operations, for the file-level summary. */
  const allDurations: number[] = [];

  /** Fold one operation's samples into both the table and the summary. */
  function recordOperation(
    label: string,
    durations: number[],
    errors: number,
  ): void {
    breakdown[label] = computeMetrics(durations, errors);
    allDurations.push(...durations);
  }

  beforeAll(async () => {
    ({ ctx, client } = await createTestContext("load", "crud-benchmarks"));
    const warmMs = await warmTarget(client);
    console.log(
      `  warm-up ${warmMs.toFixed(0)}ms — excluded from every sample below`,
    );
  });

  afterAll(async () => {
    // Emitted here so the per-operation table lands as one comparable record
    // rather than six partial ones. Skipped when nothing was sampled — a run
    // that failed in setup would otherwise overwrite a real report with an
    // all-zero one that looks like a measurement.
    if (allDurations.length > 0) {
      await record({
        scenario: "load.crud-benchmarks.operations",
        profile,
        itemCount: created.length,
        durations: allDurations,
        errors: Object.values(breakdown).reduce((sum, m) => sum + m.errors, 0),
        breakdown,
      });
    }
    await cleanup(ctx);
  });

  it("measures single-item create", async () => {
    const durations: number[] = [];
    let errors = 0;

    for (let i = 0; i < writeSamples; i++) {
      const { result, durationMs } = await measure(() =>
        client.createItem({
          type: "core.note",
          properties: { title: corpus.title(), body: corpus.body(20) },
          source_id: `crud-${ctx.runId}-${i}`,
          tags: [LOAD_TAG],
        }),
      );
      if (result.ok) {
        created.push(result.data.item.id);
        versions.set(result.data.item.id, result.data.item.version);
        trackItem(ctx, result.data.item.id);
        durations.push(durationMs);
      } else {
        errors++;
      }
    }

    recordOperation("create", durations, errors);
    expect(errors).toBe(0);
    expect(created.length).toBe(writeSamples);
  });

  it("measures single-item read", async () => {
    const targets = sampleIds(created, readSamples);
    const durations: number[] = [];
    let errors = 0;

    for (const id of targets) {
      const { result, durationMs } = await measure(() => client.getItem(id));
      if (result.ok && result.data.item.id === id) durations.push(durationMs);
      else errors++;
    }

    recordOperation("read", durations, errors);
    expect(errors).toBe(0);
  });

  it("measures item update", async () => {
    const targets = sampleIds(created, UPDATE_SAMPLES);
    const durations: number[] = [];
    let errors = 0;

    for (const [i, id] of targets.entries()) {
      const base = versions.get(id);
      expect(
        base,
        "an update target was never created here, so there is no version it read",
      ).toBeDefined();
      const { result, durationMs } = await measure(() =>
        client.updateItem(id, {
          properties: {
            title: corpus.title(),
            body: `revision ${i} ${corpus.sentence()}`,
          },
          version: base!,
        }),
      );
      if (result.ok) {
        durations.push(durationMs);
        versions.set(id, result.data.item.version);
      } else errors++;
    }

    recordOperation("update", durations, errors);
    expect(errors).toBe(0);
  });

  it("measures a paged list read", async () => {
    const durations: number[] = [];
    let errors = 0;

    for (let i = 0; i < LIST_SAMPLES; i++) {
      const { result, durationMs } = await measure(() =>
        client.listItems({ source: ctx.source, limit: 25 }),
      );
      if (result.ok) durations.push(durationMs);
      else errors++;
    }

    recordOperation("list", durations, errors);
    expect(errors).toBe(0);
  });

  it("measures lifecycle transition", async () => {
    const targets = sampleIds(created, MUTATION_SAMPLES);
    const durations: number[] = [];
    let errors = 0;

    for (const id of targets) {
      const { result, durationMs } = await measure(() =>
        client.transitionItem(id, "archived"),
      );
      if (result.ok) {
        durations.push(durationMs);
        expect(result.data.item.state).toBe("archived");
      } else {
        errors++;
      }
    }

    recordOperation("transition", durations, errors);
    expect(errors).toBe(0);
  });

  it("measures delete", async () => {
    // Deletes run against rows written for the purpose, so the read, update,
    // and transition targets above stay alive for the whole file.
    const doomed: string[] = [];
    for (let i = 0; i < MUTATION_SAMPLES; i++) {
      const response = await client.createItem({
        type: "core.note",
        properties: { title: corpus.title(), body: corpus.body(15) },
        source_id: `crud-doomed-${ctx.runId}-${i}`,
        tags: [LOAD_TAG],
      });
      expect(response.ok).toBe(true);
      doomed.push(response.data.item.id);
      trackItem(ctx, response.data.item.id);
    }

    const durations: number[] = [];
    let errors = 0;
    for (const id of doomed) {
      const { result, durationMs } = await measure(() => client.deleteItem(id));
      if (result.ok) durations.push(durationMs);
      else errors++;
    }

    recordOperation("delete", durations, errors);
    expect(errors).toBe(0);
  });
});
