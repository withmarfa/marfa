import { log, serializeError } from "./middleware/logger.js";

/**
 * Every wait during shutdown is bounded, because the process is racing a
 * SIGKILL it cannot see coming. An unbounded wait does not buy a cleaner
 * stop: it spends the whole grace period on one step and then loses the
 * telemetry flush to the kill, which is how a clean shutdown ends up
 * looking like a crash.
 *
 * The bounds are chosen against the grace a container runtime gives a
 * stopped process, ten seconds by default. The server and the work in
 * flight drain side by side, so that wait is the longer of the two, and
 * the storage and the telemetry follow it: the worst case is the sum
 * below, leaving the rest of the grace for what the process does after
 * this returns, such as a replicator's last sync.
 *
 * `server.close()` is the specific hazard. It resolves only once every
 * connection has ended, and an event stream does not end until it is told
 * to, so the streams are ended first and each is sent its closing frame.
 * `closeIdleConnections()` then removes the keep-alive connections nothing
 * is using; the timeout covers the rest.
 */
export const SERVER_CLOSE_TIMEOUT_MS = 2_000;
export const IN_FLIGHT_WORK_TIMEOUT_MS = 4_000;
export const STORAGE_CLOSE_TIMEOUT_MS = 1_500;
export const TELEMETRY_FLUSH_TIMEOUT_MS = 1_000;

/** What the sequence stops, in the shapes it needs from each. */
export interface ShutdownParts {
  /** Stops claiming; settles once the run in flight has ended. */
  bulkActionWorker: { stop(): Promise<void> };
  /** Stops polling; settles once every run in flight has ended, the
   *  webhook deliveries among them. */
  housekeeping: { stop(): Promise<void> };
  /** Ends each open event stream with its closing frame. */
  streams: { endAll(): number };
  server: {
    close: (cb?: (err?: Error) => void) => void;
    closeIdleConnections?: () => void;
  };
  storage: { close(): Promise<void> };
  /** The OpenTelemetry flush, when telemetry is on. */
  flushTelemetry?: () => Promise<void>;
}

export interface ShutdownBounds {
  serverCloseTimeoutMs: number;
  inFlightWorkTimeoutMs: number;
  storageCloseTimeoutMs: number;
  telemetryFlushTimeoutMs: number;
}

/**
 * Stop everything in the order that keeps each step's records writable,
 * and answer the exit code.
 *
 * The consumers stop first, and the poll of each with them, so no run
 * starts while the server drains. Every open event stream is then told the
 * instance is stopping, which is what lets the server's close resolve, and
 * the wait for the server and the wait for the runs already in flight run
 * together. The storage closes only after both, so a run can still write its
 * record. A run that outlives its bound meets the closed client and stands
 * down; that is a long sweep or a long job cut short, which the next start
 * resumes, and not a failed shutdown, so it leaves the exit code alone. The
 * server and the storage failing to close in time do not.
 *
 * Each step is bounded and reported separately: a shared catch would
 * produce a warning that could not say which step overran.
 */
export async function shutdownInOrder(
  parts: ShutdownParts,
  bounds: ShutdownBounds = {
    serverCloseTimeoutMs: SERVER_CLOSE_TIMEOUT_MS,
    inFlightWorkTimeoutMs: IN_FLIGHT_WORK_TIMEOUT_MS,
    storageCloseTimeoutMs: STORAGE_CLOSE_TIMEOUT_MS,
    telemetryFlushTimeoutMs: TELEMETRY_FLUSH_TIMEOUT_MS,
  },
): Promise<number> {
  // Emitted before anything is torn down, so the record is in the telemetry
  // pipeline as early as possible; everything below only shortens the time
  // it has to get out.
  log("info", "Shutting down...");
  const bulkActionsStopped = parts.bulkActionWorker.stop();
  const housekeepingStopped = parts.housekeeping.stop();

  let streamsEnded = 0;
  try {
    streamsEnded = parts.streams.endAll();
  } catch (error) {
    log("warn", "Graceful shutdown: ending the event streams failed", {
      error: serializeError(error),
    });
  }
  if (streamsEnded > 0) {
    log("info", "Graceful shutdown: told open event streams to reconnect", {
      streams: streamsEnded,
    });
  }

  let exitCode = 0;
  const serverClosed = withTimeout(
    closeServer(parts.server),
    bounds.serverCloseTimeoutMs,
  ).catch((error: unknown) => {
    log("warn", "Graceful shutdown: HTTP server close did not complete", {
      error: serializeError(error),
    });
    exitCode = 1;
  });
  const inFlightEnded = Promise.all([
    withTimeout(bulkActionsStopped, bounds.inFlightWorkTimeoutMs).catch(
      (error: unknown) => {
        log("warn", "Graceful shutdown: a bulk action did not finish in time", {
          error: serializeError(error),
        });
      },
    ),
    withTimeout(housekeepingStopped, bounds.inFlightWorkTimeoutMs).catch(
      (error: unknown) => {
        log("warn", "Graceful shutdown: housekeeping did not stop in time", {
          error: serializeError(error),
        });
      },
    ),
  ]);
  await Promise.all([serverClosed, inFlightEnded]);

  try {
    await withTimeout(parts.storage.close(), bounds.storageCloseTimeoutMs);
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

/** How often the connections a finished response left idle are swept. */
const IDLE_SWEEP_MS = 50;

function closeServer(server: ShutdownParts["server"]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // Stop waiting on sockets that are merely parked, and keep doing it: a
    // stream that has just been ended hands its connection back idle only
    // once its last frame has been read, which is after the first sweep.
    // In-flight requests still get to finish.
    const sweep = setInterval(() => {
      server.closeIdleConnections?.();
    }, IDLE_SWEEP_MS);
    server.close((err) => {
      clearInterval(sweep);
      if (err) reject(err);
      else resolvePromise();
    });
    server.closeIdleConnections?.();
  });
}
