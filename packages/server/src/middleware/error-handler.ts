import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./auth.js";
import { log } from "./logger.js";
import { notifyError } from "./error-notifier.js";

function jsonResponse(
  body: unknown,
  status: number,
  errorCode?: string,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (errorCode) headers["X-Error-Code"] = errorCode;
  return new Response(JSON.stringify(body), { status, headers });
}

function isMymeError(err: unknown): err is {
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
}): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (isMymeError(err)) {
      const error: Record<string, unknown> = {
        code: err.code,
        message: err.message,
      };
      if (err.details) error.details = err.details;
      return jsonResponse({ error }, err.status, err.code);
    }

    // Malformed JSON (`{not valid json`) and empty bodies on routes
    // that declare a JSON validator. Hono's validator throws an
    // `HTTPException` with the literal message "Malformed JSON in
    // request body" before user middleware runs. Surface as our
    // typed 400 so the conformance suite's adversarial probes don't
    // see 500s and operator logs aren't noisy with false incidents.
    if (
      err instanceof HTTPException &&
      err.message === "Malformed JSON in request body"
    ) {
      return jsonResponse(
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

    // Other HTTPExceptions (e.g. forwarded from Hono internals)
    // surface their own status. Wrap in our error envelope.
    if (err instanceof HTTPException) {
      const code = err.status >= 500 ? "internal_error" : "validation_error";
      return jsonResponse(
        { error: { code, message: err.message } },
        err.status,
        code,
      );
    }

    // Defensive: a `SyntaxError` thrown directly by `JSON.parse` (not
    // wrapped by Hono's validator) should also map to 400.
    if (err instanceof SyntaxError) {
      return jsonResponse(
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

    // Zod schema validation failures that escaped the route-level
    // validator. Duck-typed by `name` so we don't take a direct zod
    // dep here.
    if (
      typeof err === "object" &&
      (err as { name?: string }).name === "ZodError"
    ) {
      return jsonResponse(
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

    if (config.errorWebhookUrl) {
      notifyError(config.errorWebhookUrl, {
        timestamp: new Date().toISOString(),
        request_id: c.get("requestId"),
        error: err instanceof Error ? err.message : String(err),
        path: c.req.path,
        method: c.req.method,
      });
    }

    return jsonResponse(
      { error: { code: "internal_error", message: "Internal server error" } },
      500,
      "internal_error",
    );
  };
}
