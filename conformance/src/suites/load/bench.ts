/**
 * Shared machinery for the bounded load benchmarks.
 *
 * The ten `load/` suites are benchmarks, not stress tests. Each one seeds a
 * small corpus under its own credential, records latency and throughput for
 * one workload shape, asserts loosely, and deletes what it created. Nothing
 * here searches for a breaking point, and nothing here reports a number it
 * did not measure.
 *
 * Three constraints shape every helper below:
 *
 * - **The target may be cold.** A server's first requests carry start-up cost.
 *   `warmTarget()` absorbs that in `beforeAll` so no measured sample carries
 *   it.
 * - **Rows belong to one file.** Suites scope their reads to their own
 *   credential `source` (or to a run-unique full-text marker) rather than
 *   reading whatever else lives in the dataset, and they keep concurrency low
 *   enough that one suite does not starve the rest of the run.
 * - **Writes are the expensive half.** Item creation costs the same per item
 *   however it is batched, and does not get faster with more parallel
 *   writers, so corpus sizes are chosen from the profile rather than grown
 *   until something breaks.
 */

import type { MarfaClient } from "../../client/api.js";
import type { BulkItemInput, TestContext } from "../../client/types.js";
import { Corpus } from "../../generators/corpus.js";
import { trackItem } from "../../utils/setup.js";
import { measure } from "../../utils/timing.js";
import type { LoadProfile } from "./profiles.js";
import {
  computeMetrics,
  logResult,
  saveLoadResult,
  type LoadMetrics,
  type LoadResult,
  type LoadThreshold,
} from "./results.js";

/**
 * Every item written by a load suite carries this tag. Suites delete their own
 * rows via the tracked-resource path, so it is only a backstop: if a run is
 * killed mid-flight, `pnpm load:cleanup` sweeps whatever is left by this tag.
 */
export const LOAD_TAG = "env:test";

/**
 * Bulk request bodies are size-capped server-side, and the cap is well below
 * what a few hundred generated items serialize to. Batches are split to stay
 * under this budget regardless of what `batchSize` the profile asks for, so a
 * large profile can raise item counts without tripping a 400.
 */
const MAX_BATCH_BYTES = 256_000;

/** Types the bounded corpora use. All are registered on any Marfa server. */
const DEFAULT_TYPES = [
  "core.note",
  "core.bookmark",
  "core.task",
  "core.highlight",
] as const;

// --- Warm-up ---

/**
 * A response this fast means the server is up and serving; anything slower on
 * a small payload is start-up, not steady state.
 */
const WARM_THRESHOLD_MS = 2_000;
const WARM_MAX_PROBES = 8;

/**
 * Drive the target to a warm, serving state and report what it cost.
 *
 * Returns the total wall-clock time spent warming. Suites call this once in
 * `beforeAll` and never fold the result into a metric — start-up is a property
 * of how the server was brought up, not of the operation under test, and
 * recording it as a sample would make every first measurement a lie.
 */
export async function warmTarget(client: MarfaClient): Promise<number> {
  const start = performance.now();
  let previousMs = Number.POSITIVE_INFINITY;

  for (let probe = 0; probe < WARM_MAX_PROBES; probe++) {
    const { durationMs } = await measure(() => client.listItems({ limit: 1 }));
    if (durationMs < WARM_THRESHOLD_MS && previousMs < WARM_THRESHOLD_MS) break;
    previousMs = durationMs;
  }

  return performance.now() - start;
}

// --- Corpus seeding ---

export interface SeedCorpusOptions {
  /** How many items to write. */
  count: number;
  /** Requested items per bulk call; trimmed further to respect the byte cap. */
  batchSize: number;
  /** Full-text token embedded in a subset of items. */
  marker?: string;
  /** One in every `markerEvery` items carries `marker`. Default 4. */
  markerEvery?: number;
  /** PRNG seed, for reproducible content across runs. */
  seed?: number;
  /** Tags applied to every item, on top of {@link LOAD_TAG}. */
  tags?: string[];
  /** Type mix, cycled in order. Defaults to note/bookmark/task/highlight. */
  types?: readonly string[];
  /** Approximate words in the body of a generated note. Default 25. */
  bodyWords?: number;
}

export interface SeededCorpus {
  /** Every item id the server reported as created, in write order. */
  ids: string[];
  /** Ids grouped by type, so a suite can narrow to one type's rows. */
  idsByType: Record<string, string[]>;
  /** Ids of the items whose searchable text carries the marker. */
  markedIds: string[];
  /** Wall-clock time spent seeding. */
  durationMs: number;
  /** Per-bulk-call durations, for a write-throughput breakdown. */
  batchDurationsMs: number[];
  /** Items the server rejected. Non-zero means a generator/schema mismatch. */
  errors: number;
}

/**
 * Split a list of items into bulk-call-sized chunks, honoring both the caller's
 * requested batch size and the body-size budget.
 */
function chunkItems(
  items: BulkItemInput[],
  batchSize: number,
): BulkItemInput[][] {
  const chunks: BulkItemInput[][] = [];
  let current: BulkItemInput[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const bytes = JSON.stringify(item).length;
    const wouldOverflow =
      current.length >= batchSize ||
      (current.length > 0 && currentBytes + bytes > MAX_BATCH_BYTES);
    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += bytes;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function propertiesFor(
  type: string,
  index: number,
  corpus: Corpus,
  bodyWords: number,
  markerText: string,
): Record<string, unknown> {
  const suffix = markerText ? ` ${markerText}` : "";
  switch (type) {
    case "core.bookmark":
      return {
        url: corpus.url(),
        title: corpus.title(),
        description: corpus.sentence() + suffix,
      };
    case "core.task":
      return {
        title: corpus.title(),
        description: corpus.sentence() + suffix,
        status: "pending",
        priority: ["low", "medium", "high"][index % 3],
      };
    case "core.highlight": {
      const start = index * 100;
      return {
        text: corpus.sentence() + suffix,
        color: ["yellow", "green", "blue", "pink"][index % 4],
        locator_type: "offset",
        start_location: String(start),
        end_location: String(start + 200),
      };
    }
    default:
      return { title: corpus.title(), body: corpus.body(bodyWords) + suffix };
  }
}

/**
 * Seed a bounded corpus into the calling credential's own `source` and track
 * every created id on `ctx`, so the standard `cleanup(ctx)` teardown removes
 * it. Bodies are deliberately short: item write cost on a small target is
 * dominated by the per-item price, not the payload, so long bodies would buy
 * seeding time without making the benchmark more representative.
 */
export async function seedCorpus(
  client: MarfaClient,
  ctx: TestContext,
  options: SeedCorpusOptions,
): Promise<SeededCorpus> {
  const {
    count,
    batchSize,
    marker,
    markerEvery = 4,
    seed = 42,
    tags = [],
    types = DEFAULT_TYPES,
    bodyWords = 25,
  } = options;

  const corpus = new Corpus({ seed });
  const markedSourceIds = new Set<string>();
  const typeBySourceId = new Map<string, string>();

  const items: BulkItemInput[] = Array.from({ length: count }, (_, i) => {
    const type = types[i % types.length];
    const carriesMarker = Boolean(marker) && i % markerEvery === 0;
    const sourceId = `bench-${ctx.runId}-${i}`;
    if (carriesMarker) markedSourceIds.add(sourceId);
    typeBySourceId.set(sourceId, type);
    return {
      type,
      properties: propertiesFor(
        type,
        i,
        corpus,
        bodyWords,
        carriesMarker ? (marker ?? "") : "",
      ),
      source_id: sourceId,
      tags: [LOAD_TAG, ...tags],
    };
  });

  const chunks = chunkItems(items, batchSize);
  const ids: string[] = [];
  const idsByType: Record<string, string[]> = {};
  const markedIds: string[] = [];
  const batchDurationsMs: number[] = [];
  let errors = 0;
  const start = performance.now();

  for (const chunk of chunks) {
    const { result, durationMs } = await measure(() =>
      // `create_only` keeps a re-run from silently updating rows a previous
      // run left behind; `atomic: false` reports per-item outcomes so a single
      // bad row does not discard the whole batch.
      client.bulkItems({ items: chunk, mode: "create_only", atomic: false }),
    );
    batchDurationsMs.push(durationMs);

    if (!result.ok) {
      errors += chunk.length;
      continue;
    }

    for (const entry of result.data.results) {
      // `errored` and `skipped` outcomes carry no id. Errors are counted from
      // the response's own tally below, so nothing is added here.
      if (!entry.id) continue;
      const sourceId = chunk[entry.index]?.source_id;
      const type = sourceId
        ? (typeBySourceId.get(sourceId) ?? "unknown")
        : "unknown";
      ids.push(entry.id);
      (idsByType[type] ??= []).push(entry.id);
      if (sourceId && markedSourceIds.has(sourceId)) markedIds.push(entry.id);
      trackItem(ctx, entry.id);
    }
    errors += result.data.counts.errored;
  }

  return {
    ids,
    idsByType,
    markedIds,
    durationMs: performance.now() - start,
    batchDurationsMs,
    errors,
  };
}

// --- Result emission ---

export interface BuildResultInput {
  scenario: string;
  profile: LoadProfile;
  /** Size of the dataset the scenario ran against. */
  itemCount: number;
  /** Per-operation durations in ms. */
  durations: number[];
  errors?: number;
  /** Operations per second, where the scenario has a meaningful rate. */
  throughput?: number;
  threshold?: LoadThreshold;
  breakdown?: Record<string, LoadMetrics>;
}

export function buildResult(input: BuildResultInput): LoadResult {
  return {
    scenario: input.scenario,
    profile: input.profile.name,
    itemCount: input.itemCount,
    timestamp: new Date().toISOString(),
    metrics: computeMetrics(
      input.durations,
      input.errors ?? 0,
      input.throughput,
    ),
    threshold: input.threshold,
    breakdown: input.breakdown,
  };
}

/** Log a result to the console and persist it under `reports/load/`. */
export async function emitResult(result: LoadResult): Promise<void> {
  logResult(result);
  await saveLoadResult(result);
}

/** Convenience: build, log, persist, and hand the result back for assertions. */
export async function record(input: BuildResultInput): Promise<LoadResult> {
  const result = buildResult(input);
  await emitResult(result);
  return result;
}

// --- Misc helpers ---

/**
 * A full-text token unique to this run. `GET /search` exposes no `source`
 * filter, so a suite that wants to assert on result counts has to search for
 * something only its own corpus contains. Letters only: the token has to
 * survive full-text tokenization intact.
 */
export function benchMarker(ctx: TestContext, label: string): string {
  return `zq${label}${ctx.runId.replace(/[^a-z0-9]/gi, "")}`.toLowerCase();
}

/**
 * Deterministically pick `n` ids from a list, cycling if `n` exceeds the pool.
 * Deterministic so two runs of a suite read the same rows.
 */
export function sampleIds(ids: readonly string[], n: number): string[] {
  if (ids.length === 0) return [];
  const stride = Math.max(1, Math.floor(ids.length / Math.max(1, n)));
  return Array.from({ length: n }, (_, i) => ids[(i * stride) % ids.length]);
}

export interface ExportStreamStats {
  status: number;
  /** Time to response headers. */
  headerMs: number;
  /** Time to the first body byte — the server's time-to-first-record. */
  firstByteMs: number;
  /** Time until the stream closed. */
  totalMs: number;
  bytes: number;
  /** NDJSON records observed (newline count). */
  lines: number;
}

/**
 * Stream `GET /export` and report streaming characteristics.
 *
 * The client in `src/client/` buffers the whole body before returning, which
 * collapses exactly the property an export benchmark cares about: how quickly
 * the server starts emitting versus how long the full drain takes. This reads
 * the body incrementally instead.
 */
export async function streamExport(
  apiUrl: string,
  apiKey: string,
  params: Record<string, string>,
): Promise<ExportStreamStats> {
  const query = new URLSearchParams(params).toString();
  const start = performance.now();
  const response = await fetch(`${apiUrl}/export${query ? `?${query}` : ""}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const headerMs = performance.now() - start;

  let bytes = 0;
  let lines = 0;
  let firstByteMs = headerMs;

  if (response.body) {
    const reader = response.body.getReader();
    let sawFirstChunk = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!sawFirstChunk) {
        firstByteMs = performance.now() - start;
        sawFirstChunk = true;
      }
      bytes += value.byteLength;
      for (const byte of value) if (byte === 0x0a) lines++;
    }
  }

  return {
    status: response.status,
    headerMs,
    firstByteMs,
    totalMs: performance.now() - start,
    bytes,
    lines,
  };
}
