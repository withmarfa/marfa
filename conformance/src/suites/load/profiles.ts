/**
 * Load test profiles — sizings for the bounded benchmark suites.
 *
 * A profile carries two things. **The `bench` block** sizes the ten load
 * suites, which are bounded benchmarks rather than stress tests: each file
 * seeds a small corpus under its own credential, measures, and deletes what it
 * created, and none of them claims to have found a limit it did not reach.
 * **`typeDistribution`** is the type mix those profiles name, read by the
 * registry drift check in `generators/type-bindings.test.ts`.
 *
 * `smoke` is the default profile, sized so a load run costs little more than a
 * conformance run. Set `MARFA_LOAD_PROFILE` to opt into a larger shape on a
 * target that can absorb it.
 */

/** Sizing for the bounded benchmark suites. */
export interface BenchSizing {
  /** Items a read-oriented suite seeds into its own credential source. */
  corpusItems: number;
  /** Items per bulk write call. Larger batches amortize round-trip cost. */
  batchSize: number;
  /** Individually-timed single-item writes per measured scenario. */
  writeSamples: number;
  /** Individually-timed reads per measured scenario. */
  readSamples: number;
  /** Ceiling on parallel in-flight requests from one suite. */
  concurrency: number;
  /** Concurrency ladder for the ramp suite, ascending. */
  rampLevels: number[];
  /** Blob fixtures the blob suite uploads and reads back. */
  blobUploads: number;
  /** Wall-clock budget for the mixed-workload simulation, in ms. */
  mixedDurationMs: number;
}

export interface LoadProfile {
  name: string;

  /**
   * Fraction of items per type (must sum to 1.0).
   *
   * Every id here is a registered platform type: nothing registers a type at
   * run time, so a profile cannot name one the registry does not carry.
   */
  typeDistribution: Record<string, number>;

  bench: BenchSizing;
}

export const PROFILES: Record<string, LoadProfile> = {
  smoke: {
    name: "smoke",
    typeDistribution: {
      "core.note": 0.4,
      "core.bookmark": 0.3,
      "core.task": 0.2,
      "core.highlight": 0.1,
    },
    bench: {
      corpusItems: 80,
      batchSize: 40,
      writeSamples: 10,
      readSamples: 24,
      concurrency: 8,
      rampLevels: [1, 2, 4, 8, 12],
      blobUploads: 4,
      mixedDurationMs: 20_000,
    },
  },

  light: {
    name: "light",
    typeDistribution: {
      "core.note": 0.4,
      "core.bookmark": 0.3,
      "core.task": 0.15,
      "core.highlight": 0.1,
      "core.entity.person": 0.05,
    },
    bench: {
      corpusItems: 600,
      batchSize: 100,
      writeSamples: 30,
      readSamples: 60,
      concurrency: 12,
      rampLevels: [1, 4, 8, 16, 24],
      blobUploads: 12,
      mixedDurationMs: 60_000,
    },
  },

  moderate: {
    name: "moderate",
    typeDistribution: {
      "core.note": 0.4,
      "core.bookmark": 0.25,
      "core.task": 0.2,
      "core.highlight": 0.1,
      "core.entity.person": 0.05,
    },
    bench: {
      corpusItems: 2_000,
      batchSize: 200,
      writeSamples: 60,
      readSamples: 120,
      concurrency: 16,
      rampLevels: [1, 4, 8, 16, 32],
      blobUploads: 30,
      mixedDurationMs: 120_000,
    },
  },

  heavy: {
    name: "heavy",
    typeDistribution: {
      "core.note": 0.45,
      "core.bookmark": 0.25,
      "core.task": 0.15,
      "core.highlight": 0.1,
      "core.entity.person": 0.05,
    },
    bench: {
      corpusItems: 5_000,
      batchSize: 250,
      writeSamples: 100,
      readSamples: 200,
      concurrency: 24,
      rampLevels: [1, 8, 16, 32, 48],
      blobUploads: 60,
      mixedDurationMs: 300_000,
    },
  },

  extreme: {
    name: "extreme",
    typeDistribution: {
      "core.note": 0.5,
      "core.bookmark": 0.2,
      "core.task": 0.15,
      "core.highlight": 0.1,
      "core.entity.person": 0.05,
    },
    bench: {
      corpusItems: 12_000,
      batchSize: 500,
      writeSamples: 200,
      readSamples: 400,
      concurrency: 32,
      rampLevels: [1, 8, 16, 32, 64],
      blobUploads: 120,
      mixedDurationMs: 600_000,
    },
  },
};

export type ProfileName = keyof typeof PROFILES;

/**
 * Defaults to `smoke`, the bounded shape the benchmark suites are written for.
 * The larger profiles stay available for targets that can absorb them.
 */
export function getLoadProfile(): LoadProfile {
  const name = (process.env.MARFA_LOAD_PROFILE ?? "smoke") as ProfileName;
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown load profile "${name}". Valid: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  return profile;
}
