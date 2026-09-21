import { log, serializeError } from "./middleware/logger.js";

/**
 * Every wait during shutdown is bounded, because the process is racing a
 * SIGKILL it cannot see coming. An unbounded wait does not buy a cleaner
 * stop: it spends the whole grace period on one step and then loses the
 * telemetry flush to the kill, which is how a clean shutdown ends up
 * looking like a crash.
 *
 * `server.close()` is the specific hazard. It resolves only once every
 * connection has ended, and a keep-alive connection has not ended just
 * because no request is in flight, so a single idle client can hold it
 * open indefinitely. `closeIdleConnections()` below removes the common
 * case; the timeout covers the rest.
 */
export const SHUTDOWN_STEP_TIMEOUT_MS = 3_000;
export const TELEMETRY_FLUSH_TIMEOUT_MS = 2_000;

/** What the sequence stops, in the shapes it needs from each. */
export interface ShutdownParts {
  webhookConsumer: { stop(): void };
  bulkActionWorker: { stop(): void };
  housekeeping: { stop(): Promise<void> };
  server: {
    close: (cb?: (err?: Error) => void) => void;
    closeIdleConnections?: () => void;
  };
  storage: { close(): Promise<void> };
  /** The OpenTelemetry flush, when telemetry is on. */
  flushTelemetry?: () => Promise<void>;
}

export interface ShutdownBounds {
  stepTimeoutMs: number;
  telemetryFlushTimeoutMs: number;
}

/**
 * Stop everything in the order that keeps each step's records writable,
 * and answer the exit code.
 *
 * The consumers stop first and the housekeeping poll with them, so no run
 * starts while the server drains; the wait for runs already in flight
 * comes after the drain and ahead of the storage closing, so a run can
 * still write its record. A run that outlives its bound meets the closed
 * client and stands down; that is a long sweep cut short, which the next
 * boot reruns, and not a failed shutdown, so it leaves the exit code
 * alone. The server and the storage failing to close in time do not.
 *
 * Each step is bounded and reported separately: a shared catch would
 * produce a warning that could not say which step overran.
 */
export async function shutdownInOrder(
  parts: ShutdownParts,
  bounds: ShutdownBounds = {
    stepTimeoutMs: SHUTDOWN_STEP_TIMEOUT_MS,
    telemetryFlushTimeoutMs: TELEMETRY_FLUSH_TIMEOUT_MS,
  },
): Promise<number> {
  // Emitted before anything is torn down, so the record is in the telemetry
  // pipeline as early as possible; everything below only shortens the time
  // it has to get out.
  log("info", "Shutting down...");
  parts.webhookConsumer.stop();
  parts.bulkActionWorker.stop();
  const housekeepingStopped = parts.housekeeping.stop();
  let exitCode = 0;
  try {
    await withTimeout(closeServer(parts.server), bounds.stepTimeoutMs);
  } catch (error) {
    log("warn", "Graceful shutdown: HTTP server close did not complete", {
      error: serializeError(error),
    });
    exitCode = 1;
  }
  try {
    await withTimeout(housekeepingStopped, bounds.stepTimeoutMs);
  } catch (error) {
    log("warn", "Graceful shutdown: housekeeping did not stop in time", {
      error: serializeError(error),
    });
  }
  try {
    await withTimeout(parts.storage.close(), bounds.stepTimeoutMs);
  } catch (error) {
    log("warn", "Graceful shutdown: storage close did not complete", {
      error: serializeError(error),
    });
    exitCode = 1;
  }

  // Flush and shut down OpenTelemetry last, unconditionally and whatever
  // happened above. This is the step that decides whether the shutdown
  // record exists at all: log records leave through a batching processor,
  // so a process that exits without flushing takes its final batch with
  // it. That loss is not cosmetic: a missing shutdown line is read
  // downstream as a process that died rather than stopped, so an orderly
  // scale-to-zero becomes indistinguishable from a crash. It runs outside
  // the steps above precisely because the failure path needs it most: a
  // shutdown that timed out is a shutdown worth having a record of.
  if (parts.flushTelemetry) {
    await withTimeout(
      parts.flushTelemetry(),
      bounds.telemetryFlushTimeoutMs,
    ).catch(() => undefined);
  }
  return exitCode;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${String(ms)}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeServer(server: ShutdownParts["server"]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolvePromise();
    });
    // Stop waiting on sockets that are merely parked. In-flight requests
    // still get to finish; idle keep-alive sockets are what would otherwise
    // hold the close open for the whole grace period.
    server.closeIdleConnections?.();
  });
}
