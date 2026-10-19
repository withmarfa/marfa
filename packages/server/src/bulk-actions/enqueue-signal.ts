/**
 * Enqueue routes do not own the worker's lifecycle. A single listener
 * matches the one worker per process.
 */
let listener: (() => void) | null = null;

/**
 * Register the worker's wake. Pass `null` on shutdown so a stopped worker
 * cannot be woken by a late enqueue.
 */
export function setBulkJobEnqueueListener(fn: (() => void) | null): void {
  listener = fn;
}

/**
 * Signal that a job was enqueued. Never throws: the enqueue has already
 * committed by the time this runs, and a failure to wake costs latency
 * rather than correctness — the poll loop still finds the job.
 */
export function notifyBulkJobEnqueued(): void {
  try {
    listener?.();
  } catch {
    // A wake is an optimization over the poll, not a delivery mechanism.
  }
}
