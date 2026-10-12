import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { MarfaError } from "@withmarfa/shared";

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
 * The span ends when the call settles. A call that returns a value other than
 * a promise ends it at once.
 */
export function inStorageSpan<T>(
  store: string,
  operation: string,
  call: () => T,
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
        finish(span, error);
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
          finish(span, error);
          throw error;
        },
      ) as T;
    },
  );
}

/** The refusal the code chose, which a library between may have wrapped. */
function refusal(error: unknown): MarfaError | undefined {
  let step = error;
  for (let depth = 0; depth < 8; depth++) {
    if (step instanceof MarfaError) return step;
    if (step === null || typeof step !== "object") return undefined;
    step = (step as { cause?: unknown }).cause;
  }
  return undefined;
}

function finish(span: Span, error: unknown): void {
  const refused = refusal(error);
  if (refused) {
    span.setAttribute("error.code", refused.code);
  } else {
    span.setAttribute(
      "error.type",
      error instanceof Error ? error.constructor.name : typeof error,
    );
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}
