/**
 * OpenAPI helpers — shared factory and reusable schema components.
 *
 * Each route file uses createOpenAPIRouter() to get an OpenAPIHono instance
 * with validation errors mapped to the existing MarfaError format.
 */

import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import {
  conditionalReadBoundary,
  CONDITIONAL_READ_OPERATIONS,
  invalidReadViewRequest,
} from "./middleware/read-view.js";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./middleware/auth.js";
import { requireDeclaredCredential } from "./middleware/auth.js";
import {
  declaredQueryKeys,
  queryKeyFamilies,
  refuseUndeclaredQueryKeys,
} from "./middleware/undeclared-query-keys.js";
import { isJsonContentType } from "./middleware/json-content-type.js";

/**
 * Put a route's guards ahead of everything it declares for itself.
 *
 * **The declaration is the list.** Each route already states whether it
 * takes a credential and which query keys it takes, the OpenAPI document is
 * generated from those statements, and this reads the same fields — so there
 * is no second table of protected paths or accepted keys to keep in step, and
 * a route added without a credential is open because it said so rather than
 * because somebody forgot a line.
 *
 * The credential gate goes first, and `OpenAPIHono.openapi` puts route
 * middleware ahead of the validators it derives from the request schemas.
 * That ordering is the point: a validator refusing first would tell a bare
 * request what was wrong with its body. A route's own middleware, which holds
 * the standing rule of its door, comes next, and the refusal of a query key
 * the route does not declare comes last, so a caller the door turns away
 * learns nothing about its query.
 */
function withRouteGuards<R extends RouteConfig>(route: R): R {
  const declared = route.middleware;
  const rest =
    declared === undefined
      ? []
      : Array.isArray(declared)
        ? declared
        : [declared];
  const copyBoundary: MiddlewareHandler<AppEnv> =
    CONDITIONAL_READ_OPERATIONS.has(route.operationId ?? "")
      ? conditionalReadBoundary
      : async (c, next) => {
          if (
            c.req.method === "GET" &&
            c.req.header("X-Marfa-Read-View") !== undefined
          )
            throw invalidReadViewRequest(
              "This door does not support conditional copy reads",
            );
          await next();
        };
  const gate =
    route.security === undefined || route.security.length === 0
      ? []
      : [requireDeclaredCredential, copyBoundary];
  // Every door refuses a query key it does not declare, so every door
  // declares that refusal on its 400.
  const responses = {
    ...route.responses,
    400: withUndeclaredQueryRefusal(route.responses[400]),
  };
  return {
    ...route,
    responses,
    middleware: [
      ...gate,
      ...rest,
      refuseUndeclaredQueryKeys(
        declaredQueryKeys(route.request?.query),
        queryKeyFamilies(route),
      ),
    ],
  };
}

const UNDECLARED_QUERY_LINE =
  "- `validation_error`: the query has a parameter this endpoint doesn't take.";

/**
 * A door's 400 with `validation_error` added. A 400 built from
 * {@link makeErrorResponseSchema} is rebuilt with the extra code; any other
 * shape is left as declared, and the status census reports it if a request
 * draws the code.
 */
function withUndeclaredQueryRefusal(
  declared: RouteConfig["responses"][string] | undefined,
): RouteConfig["responses"][string] {
  if (declared === undefined) {
    return {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: UNDECLARED_QUERY_LINE,
    };
  }
  if (!("content" in declared)) return declared;
  const json = declared.content?.["application/json"];
  const codes =
    json === undefined || !("schema" in json)
      ? undefined
      : refusalCodes.get(json.schema as object);
  if (codes === undefined || codes.includes("validation_error")) {
    return declared;
  }
  return {
    ...declared,
    content: {
      ...declared.content,
      "application/json": {
        ...json,
        schema: makeErrorResponseSchema([...codes, "validation_error"]),
      },
    },
    description: [declared.description, UNDECLARED_QUERY_LINE].join("\n"),
  };
}

const requireJsonContentType: MiddlewareHandler = async (c, next) => {
  if (!isJsonContentType(c.req.header("content-type"))) {
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "The request body must be JSON: send it with Content-Type: application/json",
    );
  }
  await next();
};

/**
 * Make a route whose body is JSON refuse a request that is not sent as JSON.
 *
 * **Left to the library, such a request is read as an empty object.** It
 * validates a JSON body only when the request's `Content-Type` is JSON or
 * the body is marked `required`, and otherwise hands the handler `{}`; a
 * request with no body and no `Content-Type` reaches that branch even though
 * the library's own media-type check, which answers `415`, catches every
 * request that carries a body. A door whose schema accepts `{}` then runs on
 * it.
 *
 * Marking the body `required` runs the validator on every request, and the
 * check added last in the route's middleware answers the refusal the contract
 * names, after the credential, the door's own checks and the refusal of an
 * undeclared query key (the query is the cheaper thing to judge), and before
 * any validator reads the body.
 */
function withRequiredJsonBody<R extends RouteConfig>(route: R): R {
  const body = route.request?.body;
  const types = Object.keys(body?.content ?? {});
  if (
    body === undefined ||
    types.length === 0 ||
    !types.every((type) => /^application\/([a-z-.]+\+)?json/i.test(type))
  ) {
    return route;
  }
  const declared = route.middleware;
  const rest =
    declared === undefined
      ? []
      : Array.isArray(declared)
        ? declared
        : [declared];
  return {
    ...route,
    request: { ...route.request, body: { ...body, required: true } },
    middleware: [...rest, requireJsonContentType],
  };
}

/**
 * Create an OpenAPIHono router with the defaultHook configured to throw
 * MarfaError on validation failure, preserving the existing error response format.
 *
 * Every route registered through it is guarded by its own declaration; see
 * {@link withRouteGuards}.
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
  // Routes go in through `openapi()`, so wrapping it is what makes the guards
  // unforgettable. The two casts are the registrar's own generic signature,
  // which says nothing this wrapper needs: it reads fields off the route and
  // passes the rest of the call through untouched.
  type Registrar = (route: RouteConfig, ...rest: unknown[]) => unknown;
  const register = router.openapi as unknown as Registrar;
  const gated: Registrar = (route, ...rest) =>
    register(withRequiredJsonBody(withRouteGuards(route)), ...rest);
  router.openapi = gated as unknown as typeof router.openapi;
  return router;
}

// ---------------------------------------------------------------------------
// Reusable response schemas
// ---------------------------------------------------------------------------

/**
 * The component name for a refusal that answers exactly these codes.
 *
 * Derived from the codes rather than from the door, because the same set is
 * answered by many doors — `unauthorized` alone by most of them — and a name
 * taken from one door would be wrong on the rest. It is long where a door
 * answers many codes on one status, and that is the honest length: the name
 * says which refusal the shape is.
 *
 * Sorted, so two doors answering one set share one component however each
 * wrote its list. Unsorted, `["forbidden", "core_type_immutable"]` and its
 * reverse are two components for one refusal, and a generated client carries
 * both types.
 *
 * `_or_` in a code would make the name ambiguous — two codes joined read the
 * same as one code containing the joiner — so a code carrying it is refused
 * here rather than silently sharing another set's component.
 */
export function refusalComponentName(codes: readonly string[]): string {
  const pascal = (code: string) => {
    if (/(^|_)or(_|$)/.test(code)) {
      throw new Error(
        `Refusal code "${code}" carries an \`or\` segment, which the component name joins sets with.`,
      );
    }
    return code
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");
  };
  return `${[...codes].sort().map(pascal).join("Or")}Refusal`;
}

/**
 * The refusal envelope's text, shared by the reflected schemas here and the
 * written ones in `openapi-finalize.ts`, which a test holds equal.
 */
export const REFUSAL_TEXT = {
  refusal: "An error response.",
  error: "What went wrong.",
  code: "A machine-readable code for the error. Use it in your logic.",
  message:
    "A description of the error for a person to read. It can change, so don't match on it.",
  details:
    "More about the error, such as the field it concerns. Each code defines its own details.",
} as const;

/** The 409 line of every door that takes an `Idempotency-Key`. */
export const IDEMPOTENCY_IN_FLIGHT =
  "- `idempotency_key_in_flight`: a request with this `Idempotency-Key` is still running, and this one wrote nothing. Retry.";

function buildRefusalSchema<const C extends readonly [string, ...string[]]>(
  codes: C,
) {
  return z
    .object({
      error: z
        .object({
          // Sorted with the name, so the enum a door publishes is the set it
          // answers rather than the order it happened to write.
          code: z
            .enum([...codes].sort() as unknown as C)
            .describe(REFUSAL_TEXT.code),
          message: z.string().describe(REFUSAL_TEXT.message),
          details: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(REFUSAL_TEXT.details),
        })
        .describe(REFUSAL_TEXT.error),
    })
    .describe(REFUSAL_TEXT.refusal)
    .openapi(refusalComponentName(codes));
}

/**
 * One schema instance per code set, so a set answered by twenty doors is
 * registered once and referenced twenty times.
 *
 * The cache is what makes that true, and the failure without it is silent:
 * the registry is keyed by the component name and keeps whichever schema
 * object reached it first, so two objects under one name publish the first
 * one's codes as the meaning of both. Nothing errors.
 */
const refusalSchemas = new Map<string, ReturnType<typeof buildRefusalSchema>>();
const refusalCodes = new WeakMap<object, readonly [string, ...string[]]>();

/**
 * Per-operation error response schema with a closed enum of `code` values.
 *
 * Renders as `error.code: "x" | "y" | "z"` in the document, so a generated
 * client branches on an enum rather than on a string. Every door declares
 * the codes it answers on each status through this; there is no open
 * spelling of the envelope, because a door that cannot say what it answers
 * is a door whose refusals nothing can be held to. `openapi-published.test.ts`
 * refuses a document that declares one.
 *
 * The order a door writes its codes in does not reach the document: the
 * name and the enum are both sorted, so one set is one component.
 */
export function makeErrorResponseSchema<
  const C extends readonly [string, ...string[]],
>(codes: C) {
  const name = refusalComponentName(codes);
  const cached = refusalSchemas.get(name);
  if (cached) return cached as ReturnType<typeof buildRefusalSchema<C>>;
  const schema = buildRefusalSchema(codes);
  refusalSchemas.set(name, schema);
  refusalCodes.set(schema, codes);
  return schema;
}

export const OkResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .openapi("Ok");

/** The 403 of a door behind `operatorOnly`. */
export const OPERATOR_ONLY_RESPONSE = {
  content: {
    "application/json": {
      schema: makeErrorResponseSchema(["forbidden"]),
    },
  },
  description: "- `forbidden`: your key isn't an operator key.",
};
