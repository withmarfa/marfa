import type { ErrorHandler } from "hono";
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

    if (err instanceof SyntaxError && err.message.includes("JSON")) {
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
