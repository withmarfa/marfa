import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { AppEnv } from "./auth.js";
import { log } from "./logger.js";
import { notifyError } from "./error-notifier.js";

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
  headers.set("Content-Type", "application/json");
  if (errorCode) headers.set("X-Error-Code", errorCode);
  return new Response(JSON.stringify(body), { status, headers });
}

function isMarfaError(err: unknown): err is {
  code: string;
  status: number;
  message: string;
  details?: Record<string, unknown>;
} {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    "status" in err &&
    typeof (err as Record<string, unknown>).code === "string" &&
    typeof (err as Record<string, unknown>).status === "number"
  );
}

export function createErrorHandler(config: {
  errorWebhookUrl: string;
  errorWebhookTimeoutMs?: number;
}): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (isMarfaError(err)) {
      const error: Record<string, unknown> = {
        code: err.code,
        message: err.message,
      };
      if (err.details) error.details = err.details;
      return jsonResponse(c, { error }, err.status, err.code);
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

    log("error", "Unhandled error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    // Mark span as errored so the error-aware sampler forces 100% export on this trace.
    // API-only + null-guarded — no-op when OTel is off.
    const span = trace.getActiveSpan();
    if (span) {
      if (err instanceof Error) span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
    }

    if (config.errorWebhookUrl) {
      notifyError(
        config.errorWebhookUrl,
        {
          timestamp: new Date().toISOString(),
          request_id: c.get("requestId"),
          error: err instanceof Error ? err.message : String(err),
          path: c.req.path,
          method: c.req.method,
        },
        config.errorWebhookTimeoutMs,
      );
    }

    return jsonResponse(
      c,
      { error: { code: "internal_error", message: "Internal server error" } },
      500,
      "internal_error",
    );
  };
}
