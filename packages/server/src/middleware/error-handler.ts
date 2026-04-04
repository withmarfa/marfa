import type { ErrorHandler } from "hono";
import type { AppEnv } from "./auth.js";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

export const errorHandler: ErrorHandler<AppEnv> = (err) => {
  if (isMymeError(err)) {
    const error: Record<string, unknown> = {
      code: err.code,
      message: err.message,
    };
    if (err.details) error.details = err.details;
    return jsonResponse({ error }, err.status);
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
    );
  }

  console.error("Unhandled error:", err);
  return jsonResponse(
    { error: { code: "internal_error", message: "Internal server error" } },
    500,
  );
};
