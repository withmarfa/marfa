export interface PoolResult<T> {
  /** One slot per task; a task that threw leaves `undefined` and an error. */
  results: (T | undefined)[];
  errors: Error[];
  durationMs: number;
}

export async function runConcurrent<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<PoolResult<T>> {
  const start = performance.now();
  const results: (T | undefined)[] = new Array(tasks.length);
  const errors: Error[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
        results[idx] = undefined;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return {
    results,
    errors,
    durationMs: performance.now() - start,
  };
}

export interface TimedResult<T> {
  result: T;
  durationMs: number;
  timestamp: number;
}

export async function benchmarkConcurrent<T>(
  fn: (index: number) => Promise<T>,
  totalRuns: number,
  concurrency: number,
): Promise<{
  timings: TimedResult<T>[];
  errors: Error[];
  totalDurationMs: number;
}> {
  const start = performance.now();
  const timings: TimedResult<T>[] = [];
  const errors: Error[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < totalRuns) {
      const idx = nextIndex++;
      const callStart = performance.now();
      try {
        const result = await fn(idx);
        timings.push({
          result,
          durationMs: performance.now() - callStart,
          timestamp: Date.now(),
        });
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, totalRuns) }, () =>
    worker(),
  );
  await Promise.all(workers);

  return {
    timings,
    errors,
    totalDurationMs: performance.now() - start,
  };
}

export async function rampUp<T>(
  fn: () => Promise<T>,
  levels: number[],
  runsPerLevel: number,
): Promise<{
  levels: {
    concurrency: number;
    timings: number[];
    errors: number;
    durationMs: number;
  }[];
}> {
  const results: {
    concurrency: number;
    timings: number[];
    errors: number;
    durationMs: number;
  }[] = [];

  for (const concurrency of levels) {
    const { timings, errors, totalDurationMs } = await benchmarkConcurrent(
      () => fn(),
      runsPerLevel,
      concurrency,
    );

    results.push({
      concurrency,
      timings: timings.map((t) => t.durationMs),
      errors: errors.length,
      durationMs: totalDurationMs,
    });
  }

  return { levels: results };
}

export async function runForDuration<T>(
  fn: () => Promise<T>,
  durationMs: number,
  concurrency: number,
): Promise<{
  timings: TimedResult<T>[];
  errors: Error[];
  totalDurationMs: number;
}> {
  const start = performance.now();
  const deadline = start + durationMs;
  const timings: TimedResult<T>[] = [];
  const errors: Error[] = [];

  async function worker(): Promise<void> {
    while (performance.now() < deadline) {
      const callStart = performance.now();
      try {
        const result = await fn();
        timings.push({
          result,
          durationMs: performance.now() - callStart,
          timestamp: Date.now(),
        });
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return {
    timings,
    errors,
    totalDurationMs: performance.now() - start,
  };
}
