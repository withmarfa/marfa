/**
 * OpenAPI helpers — shared factory and reusable schema components.
 *
 * Each route file uses createOpenAPIRouter() to get an OpenAPIHono instance
 * with validation errors mapped to the existing MymeError format.
 */

import { OpenAPIHono, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode } from "@mymehq/shared";

/**
 * Create an OpenAPIHono router with the defaultHook configured to throw
 * MymeError on validation failure, preserving the existing error response format.
 */
export function createOpenAPIRouter<
  T extends Record<string, unknown>,
>(): OpenAPIHono<T> {
  return new OpenAPIHono<T>({
    defaultHook: (result) => {
      if (!result.success) {
        // Check for missing required fields — map to MISSING_REQUIRED_FIELD
        // to preserve backwards-compatible error codes.
        // Zod v4 issues: { code: "invalid_type", message: "...received undefined" }
        const missingField = result.error.issues.find(
          (i) =>
            i.code === "invalid_type" &&
            i.message.includes("received undefined"),
        );
        if (missingField) {
          const field = missingField.path.join(".");
          throw new MymeError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            `${field} is required`,
            { field },
          );
        }

        throw new MymeError(ErrorCode.VALIDATION_ERROR, "Validation failed", {
          errors: result.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Reusable response schemas
// ---------------------------------------------------------------------------

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

/**
 * Per-operation error response schema with a closed enum of `code` values.
 *
 * Renders as `error.code: "x" | "y" | "z"` in the OpenAPI spec so SDK codegen
 * and the API reference can show typed-enum branches instead of `string`.
 * Use this in `responses` maps to enumerate exactly which codes a given
 * handler can emit on a given status. The generic `ErrorResponseSchema`
 * remains for catch-all paths where the code set genuinely can't be
 * enumerated tightly.
 */
export function makeErrorResponseSchema<
  const C extends readonly [string, ...string[]],
>(codes: C) {
  return z.object({
    error: z.object({
      code: z.enum(codes),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  });
}

export const OkResponseSchema = z.object({
  ok: z.literal(true),
});
