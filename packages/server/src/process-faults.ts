import { reportableError } from "./error-text.js";
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
  const reported = reportableError(err);
  log("error", message, {
    ...details,
    error: formatErrorSummary(reported),
    error_detail: serializeError(reported),
  });
  globalThis.__marfaReportException?.(reported, details);
}

/**
 * What to end a response body with when reading it fails after the response
 * began, so `onError` never sees the failure.
 *
 * The server's own logging of a failed stream prints the error whole, fields
 * included, and a failed query carries the values it was bound to in its
 * `query` and `params`. So the failure is reported here, and the stream is
 * given the form every other sink receives.
 */
export function streamFailure(
  message: string,
  err: unknown,
  details: Record<string, string | undefined> = {},
): unknown {
  reportFault(message, err, details);
  return reportableError(err);
}

/**
 * Keep a rejected promise nobody handled from ending the process.
 *
 * Node ends the process on an unhandled rejection unless something listens
 * for it, and a server that dies on one takes every request in flight with
 * it. Each one is a bug, so it is logged and reported rather than swallowed.
 */
export function installUnhandledRejectionReporter(
  on: (
    event: "unhandledRejection",
    listener: (reason: unknown) => void,
  ) => void,
): void {
  on("unhandledRejection", (reason) => {
    reportFault("Unhandled promise rejection", reason, {
      source: "unhandled_rejection",
    });
  });
}
