import {
  formatErrorSummary,
  log,
  serializeError,
} from "./middleware/logger.js";

/**
 * Log a fault nothing will answer and send it to exception reporting, where
 * that is configured. For work a request started and does not wait on, whose
 * failure has nobody to tell.
 */
export function reportFault(
  message: string,
  err: unknown,
  details: Record<string, string | undefined> = {},
): void {
  log("error", message, {
    ...details,
    error: formatErrorSummary(err),
    error_detail: serializeError(err),
  });
  globalThis.__marfaReportException?.(err, details);
}

/**
 * Keep a rejected promise nobody handled from ending the process.
 *
 * Node ends the process on an unhandled rejection unless something listens
 * for it, and a server that dies on one takes every request in flight with
 * it. Each one is a bug, so it is logged and reported rather than swallowed.
 */
export function installUnhandledRejectionReporter(
  proc: Pick<NodeJS.Process, "on"> = process,
): void {
  proc.on("unhandledRejection", (reason) => {
    reportFault("Unhandled promise rejection", reason, {
      source: "unhandled_rejection",
    });
  });
}
