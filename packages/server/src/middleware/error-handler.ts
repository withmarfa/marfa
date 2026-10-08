import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { MarfaError } from "@withmarfa/shared";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { AppEnv } from "./auth.js";
import { formatErrorSummary, log, serializeError } from "./logger.js";
import { notifyError } from "./error-notifier.js";
import { errorStack, reportableError } from "../error-text.js";
import { loggablePath } from "../inbound/address.js";
import { diskFull } from "../storage/disk-space.js";
import { renderHttpErrorPage, prefersHtml } from "../routes/http-error-page.js";

/**
 * The single place an error becomes a response.
 *
 * Named `jsonResponse` because JSON is what it returns to every client that
 * is not a browser — which is the API contract and is unchanged, byte for
 * byte. A request that explicitly prefers HTML gets a page instead: only a
 * browser navigation sends that, and a person who followed a stale link
 * should not be handed a JSON blob rendered as raw text in the viewport.
 *
 * Negotiating here rather than at each call site is deliberate. Every error
 * path in this handler already funnels through this function, so one change
 * covers all of them and no future path can forget.
 */
function jsonResponse(
  c: Context<AppEnv>,
  body: unknown,
  status: number,
  errorCode?: string,
): Response {
  // Headers set before the throw (`c.header(...)` in middleware) live in the
  // context's prepared headers, and Hono discards them when a handler returns
  // a fresh Response. Copying them here is what keeps `X-Request-ID` on every
  // error and `Retry-After` / `X-RateLimit-*` on 429s — all documented, all
  // set by middleware that cannot know a later handler will throw.
  const headers = new Headers(c.res.headers);
  if (errorCode) headers.set("X-Error-Code", errorCode);

  if (prefersHtml(c.req.header("accept"))) {
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(renderHttpErrorPage(status, c.var.cspNonce), {
      status,
      headers,
    });
  }

  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

interface ShapedError {
  code: string;
  status: number;
  message: string;
  details?: Record<string, unknown>;
}

function isMarfaError(err: unknown): err is ShapedError {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    "status" in err &&
    typeof (err as Record<string, unknown>).code === "string" &&
    typeof (err as Record<string, unknown>).status === "number"
  );
}

/**
 * The typed error inside whatever is wrapping it, if there is one.
 *
 * **A library between the throw and here re-wraps what it caught.**
 * Drizzle does: every statement it runs is wrapped in
 * `DrizzleQueryError` carrying the original as `cause`, so a code the
 * server chose deliberately reaches this handler as an error with no
 * `code` at all and becomes a `500` — the opposite of what choosing the
 * code was for.
 *
 * **The two levels are tested differently, and the difference is the
 * point.** At the top the structural test stands, because that is what
 * every existing throw arrives as and narrowing it here would change
 * unrelated doors. Inside a `cause` chain nothing is known about who
 * built the wrapper, so only the server's own class counts: a library
 * error that happens to carry a `code` and a `status` of its own would
 * otherwise have its internals answered to a caller as though the
 * server had chosen them.
 *
 * The walk is bounded, because a `cause` chain is data and a cycle in
 * one should not hang the error handler.
 */
export function shapedError(err: unknown): ShapedError | undefined {
  if (isMarfaError(err)) return err;
  for (let step: unknown = err, depth = 0; depth < 8; depth++) {
    if (step === null || typeof step !== "object") break;
    step = (step as { cause?: unknown }).cause;
    if (step instanceof MarfaError) return step;
  }
  return diskFull(err);
}

export function createErrorHandler(config: {
  errorWebhookUrl: string;
  errorWebhookTimeoutMs?: number;
  /** Names the instance in an alert, so one channel can serve several. */
  authBaseUrl?: string;
}): ErrorHandler<AppEnv> {
  const instance = config.authBaseUrl
    ? new URL(config.authBaseUrl).host
    : undefined;
  /**
   * What is done about a fault the server did not choose a refusal for: the
   * log line, the exception on the trace and the alert. Also done for a full
   * disk, which is answered with a typed refusal but is the one fault that
   * needs a person, and which the refusal's own text says nothing of.
   */
  const report = (err: unknown, c: Context<AppEnv>): void => {
    const reported = reportableError(err);
    const summary = formatErrorSummary(reported);

    // `request_id` is the join key to the access-log line for the same
    // request, and the path and method say where it was.
    log("error", "Unhandled error", {
      request_id: c.get("requestId"),
      method: c.req.method,
      path: loggablePath(c.req.path),
      error: summary,
      error_detail: serializeError(reported),
      stack: errorStack(reported),
    });

    globalThis.__marfaReportException?.(reported, {
      request_id: c.get("requestId"),
      method: c.req.method,
      path: loggablePath(c.req.path),
    });

    // Mark span as errored so the error-aware sampler forces 100% export on this trace.
    // API-only + null-guarded — no-op when OTel is off.
    const span = trace.getActiveSpan();
    if (span) {
      if (reported instanceof Error) {
        span.recordException({
          name: reported.name,
          message: summary,
          stack: errorStack(reported),
        });
      }
      span.setStatus({ code: SpanStatusCode.ERROR });
    }

    if (config.errorWebhookUrl) {
      notifyError(
        config.errorWebhookUrl,
        {
          timestamp: new Date().toISOString(),
          request_id: c.get("requestId"),
          error: summary,
          path: loggablePath(c.req.path),
          method: c.req.method,
          ...(instance && { instance }),
        },
        config.errorWebhookTimeoutMs,
      );
    }
  };

  return (err, c) => {
    const shaped = shapedError(err);
    if (shaped) {
      if (diskFull(err)) report(err, c);
      const error: Record<string, unknown> = {
        code: shaped.code,
        message: shaped.message,
      };
      if (shaped.details) error.details = shaped.details;
      return jsonResponse(c, { error }, shaped.status, shaped.code);
    }

    // Hono's validator throws HTTPException("Malformed JSON in request body") before
    // user middleware runs; surface this as a typed 400 rather than a 500.
    if (
      err instanceof HTTPException &&
      err.message === "Malformed JSON in request body"
    ) {
      return jsonResponse(
        c,
        {
          error: {
            code: "validation_error",
            message: "Invalid JSON in request body",
          },
        },
        400,
        "validation_error",
      );
    }

    if (err instanceof HTTPException) {
      const code = err.status >= 500 ? "internal_error" : "validation_error";
      return jsonResponse(
        c,
        { error: { code, message: err.message } },
        err.status,
        code,
      );
    }

    // SyntaxError thrown directly by JSON.parse (not wrapped by Hono's validator).
    if (err instanceof SyntaxError) {
      return jsonResponse(
        c,
        {
          error: {
            code: "validation_error",
            message: "Invalid JSON in request body",
          },
        },
        400,
        "validation_error",
      );
    }

    // ZodError that escaped the route-level validator; duck-typed to avoid a direct dep.
    if (
      typeof err === "object" &&
      (err as { name?: string }).name === "ZodError"
    ) {
      return jsonResponse(
        c,
        {
          error: {
            code: "validation_error",
            message: "Request body failed validation",
          },
        },
        400,
        "validation_error",
      );
    }

    report(err, c);

    return jsonResponse(
      c,
      { error: { code: "internal_error", message: "Internal server error" } },
      500,
      "internal_error",
    );
  };
}
