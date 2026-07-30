/**
 * A one-listener seam so enqueueing a bulk-action job can wake the worker.
 *
 * The route that enqueues and the worker that drains are constructed at
 * different times: the app is built first, and the worker after it, so the
 * route cannot hold a reference to the worker. This is the smallest thing
 * that closes that gap without threading a worker handle through the route
 * layer, and it mirrors how the in-process pubsub already works.
 *
 * Without it the idle backoff is the entire latency. It widens
 * geometrically to a sixty-second ceiling while the queue is quiet, so a
 * job arriving into a settled worker waits out whatever interval happened
 * to be pending. Measured on staging: thirty-two seconds queued, then
 * sixty-five milliseconds of work, on a warm container.
 *
 * Deliberately a single listener rather than a set. There is one worker per
 * process, and a set would invite a second subscriber whose wake-ups would
 * be indistinguishable in a log.
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
    // A wake is an optimisation over the poll, not a delivery mechanism.
  }
}
