import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { MarfaError } from "@withmarfa/shared";
import { refusalInCauses } from "../refusal.js";
import { TransactionFailure } from "../storage/sqlite/transaction-control.js";

/**
 * Runs one storage call inside a span, so a request's trace shows where its
 * time went below the HTTP span.
 *
 * API-only (`@opentelemetry/api`). With telemetry off there is no active
 * span, and the call runs as it would without this: no span, no wrapper
 * promise. With it on, a call made outside a request (a background job, boot)
 * also has no active span and makes none, so a job never starts a trace of
 * its own.
 *
 * **What a span says.** Its name and attributes are the store and the method,
 * which are fixed names in this code, and never an argument, an id, a key, a
 * statement or a result. Nothing a caller sent can reach a span through here.
 * A failure sets the status and the error's class name and records no
 * exception, since a database error's message is its statement and bound
 * values; the request's own span records the one that reached a handler, after
 * the error text has been cleaned. A refusal the code chose (a `MarfaError`)
 * is the call working, so it carries its code and leaves the status alone and
 * does not make its trace an error trace.
 *
 * **A call that runs the route's own code** (`callsRouteCode`: a transaction
 * or a read snapshot) says nothing of what that code throws. A route may roll
 * a transaction back with an error of its own as a signal, which is not a
 * storage failure, and a real one from a store call is already on that call's
 * span. The wrapper itself throws a `TransactionFailure` when a transaction
 * cannot begin or commit, or when its outcome is unknown, and no store call
 * carries that: a route may answer it as a normal partial result, so the span
 * is marked as an error, with the status and the error's class name and no
 * message, unless the failure's cause is a refusal the route chose.
 *
 * The span ends when the call settles. A call that returns a value other than
 * a promise ends it at once.
 */
export function inStorageSpan<T>(
  store: string,
  operation: string,
  call: () => T,
  { callsRouteCode = false }: { callsRouteCode?: boolean } = {},
): T {
  if (trace.getActiveSpan() === undefined) return call();
  return trace.getTracer("marfa-server").startActiveSpan(
    `${store}.${operation}`,
    {
      attributes: {
        "db.system.name": "sqlite",
        "marfa.storage.store": store,
        "marfa.storage.operation": operation,
      },
    },
    (span) => {
      let result: T;
      try {
        result = call();
      } catch (error) {
        finish(span, error, callsRouteCode);
        throw error;
      }
      if (!(result instanceof Promise)) {
        span.end();
        return result;
      }
      return result.then(
        (value: unknown) => {
          span.end();
          return value;
        },
        (error: unknown) => {
          finish(span, error, callsRouteCode);
          throw error;
        },
      ) as T;
    },
  );
}

function finish(span: Span, error: unknown, callsRouteCode: boolean): void {
  const refused = error instanceof MarfaError ? error : refusalInCauses(error);
  if (refused) {
    if (!callsRouteCode) span.setAttribute("error.code", refused.code);
  } else if (!callsRouteCode || error instanceof TransactionFailure) {
    span.setAttribute(
      "error.type",
      error instanceof Error ? error.constructor.name : typeof error,
    );
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}
