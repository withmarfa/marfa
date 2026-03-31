import type { ErrorHandler } from "hono";
import { ProtocolError } from "@myme/shared";
import type { AppEnv } from "./auth.js";

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof ProtocolError) {
    return c.json(err.toResponse(), { status: err.status });
  }

  if (err instanceof SyntaxError && err.message.includes("JSON")) {
    return c.json(
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
  return c.json(
    {
      error: {
        code: "internal_error",
        message: "Internal server error",
      },
    },
    500,
  );
};
