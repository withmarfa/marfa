/**
 * OpenAPI helpers — shared factory and reusable schema components.
 *
 * Each route file uses createOpenAPIRouter() to get an OpenAPIHono instance
 * with validation errors mapped to the existing MarfaError format.
 */

import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import { requireDeclaredCredential } from "./middleware/auth.js";

/**
 * Hang the credential gate off a route whose own `security` asks for one.
 *
 * **The declaration is the list.** Each route already states whether it
 * takes a credential, the OpenAPI document is generated from that
 * statement, and this reads the same field — so there is no second table of
 * protected paths to keep in step, and a route added without one is open
 * because it said so rather than because somebody forgot a line.
 *
 * The gate goes ahead of anything the route declares for itself, and
 * `OpenAPIHono.openapi` puts route middleware ahead of the validators it
 * derives from the request schemas. That ordering is the point: a validator
 * refusing first is how a bare request used to be told what was wrong with
 * its body.
 */
function withCredentialGate<R extends RouteConfig>(route: R): R {
  if (route.security === undefined || route.security.length === 0) return route;
  const declared = route.middleware;
  const rest =
    declared === undefined
      ? []
      : Array.isArray(declared)
        ? declared
        : [declared];
  return { ...route, middleware: [requireDeclaredCredential, ...rest] };
}

/**
 * Create an OpenAPIHono router with the defaultHook configured to throw
 * MarfaError on validation failure, preserving the existing error response format.
 *
 * Every route registered through it is gated by its own declaration; see
 * {@link withCredentialGate}.
 */
export function createOpenAPIRouter<
  T extends Record<string, unknown>,
>(): OpenAPIHono<T> {
  const router = new OpenAPIHono<T>({
    defaultHook: (result) => {
      if (!result.success) {
        // A field the schema required and the body did not carry reads, in
        // Zod v4, as `{ code: "invalid_type", message: "...received
        // undefined" }`. That `invalid_type` is Zod's own issue code and has
        // nothing to do with a type identifier — the wire vocabulary has no
        // such code. Matched here so the caller is told which field is
        // missing rather than that its body failed validation somewhere.
        const missingField = result.error.issues.find(
          (i) =>
            i.code === "invalid_type" &&
            i.message.includes("received undefined"),
        );
        if (missingField) {
          const field = missingField.path.join(".");
          throw new MarfaError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            `${field} is required`,
            { field },
          );
        }

        throw new MarfaError(ErrorCode.VALIDATION_ERROR, "Validation failed", {
          errors: result.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      }
    },
  });
  // Routes go in through `openapi()`, so wrapping it is what makes the gate
  // unforgettable. The two casts are the registrar's own generic signature,
  // which says nothing this wrapper needs: it reads one field off the route
  // and passes the rest of the call through untouched.
  type Registrar = (route: RouteConfig, ...rest: unknown[]) => unknown;
  const register = router.openapi as unknown as Registrar;
  const gated: Registrar = (route, ...rest) =>
    register(withCredentialGate(route), ...rest);
  router.openapi = gated as unknown as typeof router.openapi;
  return router;
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
