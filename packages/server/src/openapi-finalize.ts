/**
 * Final shaping of the generated OpenAPI document for the public reference.
 *
 * `app.getOpenAPIDocument()` reflects every registered `createRoute`, in
 * registration order, with no top-level tag list and no operations for the
 * routes defined as plain Hono handlers. This pass makes the published spec
 * a deliberate, consumer-facing shape:
 *
 *   1. Sets an ordered, described top-level `tags` list (resources first).
 *   2. Strips platform-internal operations (admin, lease-broker plumbing,
 *      server metrics, blob maintenance, by-id space quotas). They still
 *      serve — they are simply not part of the public reference.
 *   3. Injects the two consumer routes defined as plain Hono handlers
 *      (the SSE stream and OAuth dynamic client registration), which the
 *      reflection cannot see.
 *
 * Both the live `/openapi.json` endpoint (`app.ts`) and the committed
 * `openapi.json` (`scripts/generate-openapi.ts`) call this, so the two never
 * drift.
 */

import { IDEMPOTENT_WRITE_DOORS } from "./middleware/idempotency.js";

// Loose typing — the document is a plain OpenAPI 3.1 object. `paths` is typed
// `object` (not a precise Record) so the concrete `OpenAPIObject`, whose
// `PathItemObject` values carry no index signature, still satisfies the
// constraint; the generic preserves the real return type for callers.
interface OpenAPIDoc {
  paths?: object;
  tags?: unknown[];
  components?: object;
}

/**
 * `info` block for the generated document.
 *
 * `version` is the API-contract version (the wire shape exposed under
 * `/openapi.json`), distinct from the deployed-build `version` reported on
 * `GET /` — bump it on contract changes, not on every deploy. It reached 5.1.0
 * in the docs API-surface rework: the path renames (bulk-actions,
 * spaces/me/config, edge-types, lease-tokens) are breaking, but the API is
 * pre-release and nothing pins the contract version yet, so the change
 * deliberately rode a minor rather than a major.
 *
 * Lives here so the live `/openapi.json` endpoint and the committed spec read
 * one literal instead of keeping two in lockstep by hand.
 */
export const OPENAPI_DOCUMENT_INFO = {
  title: "Marfa API",
  version: "5.1.0",
  description: "Typed data layer for structured personal data",
} as const;

/** Ordered, described public tag list. Resources first; auth/realtime last. */
const PUBLIC_TAGS = [
  {
    name: "Items",
    description:
      "Create, read, update, and query items — the core typed records.",
  },
  {
    name: "Metadata",
    description: "An item's metadata document and the space's tag vocabulary.",
  },
  {
    name: "Edges",
    description:
      "Typed relationships between items, and an item's inbound and outbound edges.",
  },
  {
    name: "Edge Types",
    description:
      "The registry of edge types with their cardinality and cascade rules.",
  },
  {
    name: "Extensions",
    description: "App-namespaced extension documents attached to an item.",
  },
  { name: "Blobs", description: "Content-addressed binary storage." },
  {
    name: "Types",
    description:
      "The type registry — core types plus app-registered custom types.",
  },
  {
    name: "Search",
    description: "Full-text and filtered search across items.",
  },
  { name: "Keys", description: "API key management." },
  { name: "Profile", description: "The calling user's profile." },
  {
    name: "Spaces",
    description: "Configuration and quotas for the calling space.",
  },
  {
    name: "Connections",
    description: "Installed integration connections and their lifecycle.",
  },
  { name: "Integrations", description: "The integration manifest registry." },
  {
    name: "Connection Leased Tokens",
    description: "Short-lived tokens a connection leases to its runtime.",
  },
  {
    name: "Inbound Webhooks",
    description:
      "Inbound webhook subscriptions on a connection and their delivery receipts.",
  },
  {
    name: "Webhooks",
    description: "Outbound webhook subscriptions and their deliveries.",
  },
  {
    name: "Credentials",
    description:
      "Connection credentials — static API tokens and OAuth providers.",
  },
  { name: "Export", description: "Bulk export of a space's data." },
  { name: "Audit", description: "The space's audit log." },
  {
    name: "Events",
    description: "The server-sent events stream of item and edge changes.",
  },
  {
    name: "Auth",
    description:
      "The signed-in user's account and OAuth dynamic client registration.",
  },
];

/**
 * Operations excluded from the public reference, by operationId. These are
 * platform-internal — they still serve, but app developers never call them.
 * A new internal route adds its operationId here.
 */
const INTERNAL_OPERATION_IDS = new Set<string>([
  // admin.ts — platform-admin space operations
  "adminListSpaces",
  "adminGetSpace",
  "adminSuspendSpace",
  "adminUnsuspendSpace",
  "adminGetSpaceMetrics",
  "adminListSpaceKeys",
  "adminPurgePendingDeletions",
  // admin-archive.ts
  "adminRestoreArchive",
  // metrics.ts — server metrics
  "getServerMetrics",
  // blobs.ts — operator maintenance
  "cleanupBlobs",
  "reconcileBlobs",
  // spaces.ts — platform-admin, by space id (self-service /me/quotas stays public)
  "getSpaceQuotas",
  "updateSpaceQuotas",
]);

/**
 * Consumer routes defined as plain Hono handlers, invisible to the
 * `createRoute` reflection. Documented here so the reference is complete.
 */
const EXTRA_PATHS: Record<string, Record<string, unknown>> = {
  "/events": {
    get: {
      operationId: "streamEvents",
      tags: ["Events"],
      summary: "Stream change events",
      description:
        "Opens a Server-Sent Events stream of item and edge changes for the caller's space. Send `Last-Event-ID` to replay events missed across a reconnect.\n\n" +
        'The stream opens with a `stream_cursor` frame, carrying `{ "type": "stream_cursor", "cursor": "<event id>" }` — the log position the stream opened at. It does not wait for anything to happen, so a client that subscribes and then reads a snapshot holds a resume point from the first moment rather than waiting for an event to tell it where it is. The frame deliberately carries no SSE `id:` field: on a reconnect it precedes the backlog, and a client adopting it as its cursor there would discard exactly the events it reconnected for.\n\n' +
        "Treat the frame as the first one delivered rather than as guaranteed. Reading the head is bounded, so a stream opened while the database is not answering carries no cursor instead of holding its events back, and a client that receives none proceeds as it would have before the frame existed. Do not gate hydration on its arrival.\n\n" +
        "The cursor is a position in one ascending sequence, and `type` and `edges` select a subset of that sequence rather than reordering it, so a cursor taken under one filter can be replayed under another without skipping or repeating a row.\n\n" +
        'A stream that can no longer deliver what it opened with sends a terminal `stream_incomplete` frame \u2014 `{ "type": "stream_incomplete", "reason": "\u2026", "cursor": "<event id>" | null }` \u2014 and closes. `reason` says which of a failed catch-up, an overflowing catch-up buffer, or a failed item or edge subscription ended it. Nothing after the gap is ever sent, so the last `id:` received is still the last event held and the recovery is to reconnect with it: the frame carries no `id:` of its own for that reason, and `cursor` repeats the position for a client that is not tracking one. That is the opposite of `catchup_too_old`, which says the log can no longer serve the cursor at all and the client has to re-read state instead.',
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "type",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Comma-separated item types, up to 10 entries, resolved exactly as the same parameter on `/items`, `/search` and `/export`. A named type covers its subtree, so `core.media` delivers `core.media.song`, and a type that declares `core.media` as its parent answers too even when its identifier sits in another namespace. The explicit `core.media.*` spelling means the same thing. The global `*` is rejected rather than accepted, as it is on those surfaces \u2014 to receive everything, omit the parameter \u2014 and so is any entry outside the type-identifier grammar. Edge events are unaffected: they carry no item type, so this parameter says nothing about them.",
        },
        {
          name: "edges",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["all", "none"], default: "all" },
          description:
            "Whether edge lifecycle events reach this stream. Defaults to `all`, including under a `type` filter. Any other value is rejected rather than ignored.",
        },
        {
          name: "Last-Event-ID",
          in: "header",
          required: false,
          schema: { type: "string" },
          description:
            "Resume from this event id, replaying events the client missed.",
        },
      ],
      responses: {
        "200": {
          description: "A `text/event-stream` of item and edge change events.",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "400": {
          description:
            "The filter cannot be honored: more than 10 types, a `type` entry that is the global `*` or is outside the type-identifier grammar, or an `edges` value outside the enum.",
        },
        "401": { description: "Unauthorized" },
      },
    },
  },
  "/oauth2/register": {
    post: {
      operationId: "registerOAuthClient",
      tags: ["Auth"],
      summary: "Register an OAuth client",
      description:
        "Dynamic Client Registration (RFC 7591). Registers a public OAuth client and returns its issued `client_id`. Unauthenticated; the `client_credentials` grant is rejected.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                redirect_uris: {
                  type: "array",
                  items: { type: "string" },
                  description: "Required for the authorization_code grant.",
                },
                grant_types: {
                  type: "array",
                  items: { type: "string" },
                  description: 'Defaults to ["authorization_code"].',
                },
                response_types: {
                  type: "array",
                  items: { type: "string" },
                  description: 'Defaults to ["code"].',
                },
                client_name: { type: "string" },
                scope: { type: "string" },
                token_endpoint_auth_method: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "The registered client, including the issued client_id.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  client_id: { type: "string" },
                  client_id_issued_at: { type: "integer" },
                  redirect_uris: { type: "array", items: { type: "string" } },
                  grant_types: { type: "array", items: { type: "string" } },
                  response_types: { type: "array", items: { type: "string" } },
                  token_endpoint_auth_method: { type: "string" },
                },
              },
            },
          },
        },
        "400": {
          description:
            "An RFC 7591 error object (invalid_client_metadata or invalid_redirect_uri).",
        },
      },
    },
  },
};

/**
 * The `Idempotency-Key` header, added to every door that honors it.
 *
 * Derived from `IDEMPOTENT_WRITE_DOORS` rather than restated on ten
 * `createRoute` definitions, so the reference cannot claim a door the
 * middleware does not serve, or miss one it does. The table is written in
 * Hono's path syntax and the spec uses OpenAPI's, which is the whole of
 * the translation below.
 *
 * Declared here rather than as a `request.headers` schema on each route
 * for a second reason: a header schema on a `createRoute` is a validator
 * as well as a description, and the header is read by middleware that runs
 * before the route is reached. Two places deciding what a valid key is is
 * one more than there should be.
 */
const IDEMPOTENCY_HEADER_PARAM = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 255 },
  description:
    "A client-chosen key identifying this write. The server records the status and body it returns against the key and answers a repeat carrying the same key with that stored result, performing no second write. A conflict is recorded like any other outcome, so a retry is told its first attempt collided rather than left to re-derive it. Scoped to the space; a key replayed with a different request is refused with `idempotency_key_reused`.",
};

/** `/items/:id/purge` as OpenAPI spells it: `/items/{id}/purge`. */
function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** The doors, keyed the way the reflected document keys an operation. */
const IDEMPOTENT_OPERATIONS = new Set(
  IDEMPOTENT_WRITE_DOORS.map((door) => {
    const [method, path] = door.split(" ");
    return `${(method ?? "").toLowerCase()} ${toOpenApiPath(path ?? "")}`;
  }),
);

/**
 * The response headers the server sets, and what each one means.
 *
 * None of these can be reflected. Every one is set by middleware or by the
 * error handler rather than declared on a `createRoute` response, so the
 * published spec described no response header at all until they were
 * written here — a client could only learn that any of them existed by
 * reading the server. They are the whole set: `Cache-Control` and `Pragma`
 * in `routes/no-store.ts` sit on the plain-Hono auth HTML pages, which are
 * not part of the reflected API surface and are deliberately left out.
 *
 * Held in `components.headers` and referenced from each response, so the
 * meaning is written once rather than restated on 106 operations.
 */
const RESPONSE_HEADER_COMPONENTS: Record<string, unknown> = {
  "X-Request-ID": {
    description:
      "This request's identifier, the same one written to the server's request log. Echoes the caller's own `X-Request-ID` when it sends one matching `[A-Za-z0-9_-]{1,128}`, and is a generated UUIDv7 otherwise, so a client can either adopt the server's id or impose its own. Quote it when reporting a problem: it is the one value that finds the request again.",
    schema: { type: "string" },
  },
  "X-Error-Code": {
    description:
      "The machine-readable error code, identical to `error.code` in the body and drawn from the same enum the response schema lists. Read it rather than matching on `error.message`, which is prose written for a person and may be reworded. Present on every error the server renders, including one served from an idempotency record.",
    schema: { type: "string" },
  },
  "X-RateLimit-Limit": {
    description:
      "How many requests this credential may make in the current window. Sent on every response, not only refusals, so a client can pace itself before it is refused. Absent entirely on a deployment that does not enable rate limiting, along with the rest of the `X-RateLimit-*` trio.",
    schema: { type: "integer" },
  },
  "X-RateLimit-Remaining": {
    description:
      "Requests left in the current window for this credential, floored at 0. The request that is refused with 429 is the one that reads 0.",
    schema: { type: "integer" },
  },
  "X-RateLimit-Reset": {
    description:
      "Unix time in seconds at which the current window ends and `X-RateLimit-Remaining` returns to `X-RateLimit-Limit`.",
    schema: { type: "integer" },
  },
  "Retry-After": {
    description:
      "Seconds to wait before retrying, sent with the rate limiter's own refusal. Derived from the time left in the window rather than a fixed backoff, so a client that honors it needs no backoff of its own. A `429` carrying `quota_exceeded` is the other kind of refusal and carries no `Retry-After`: a quota is not a window that reopens, and waiting does not clear it.",
    schema: { type: "integer" },
  },
  "Idempotency-Replayed": {
    description:
      "Sent as `true` when this response was served from the record of an earlier request carrying the same `Idempotency-Key`, rather than by performing the write. It is only ever sent on a replay and only with that value, so its absence means the write was performed. The status and body are the first attempt's, which is why the header can arrive on an error: a recorded 409 replays as a 409. Read a replayed response exactly as the original would have been read — the header says where the answer came from, not that anything went wrong.",
    schema: { type: "string", enum: ["true"] },
  },
};

/** Headers on every response, whatever the operation or the status. */
const UNIVERSAL_RESPONSE_HEADERS = [
  "X-Request-ID",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
];

/**
 * The rate limiter's refusal, added to every operation.
 *
 * Declared here rather than on each route for the same reason the
 * `Idempotency-Key` parameter is: the limiter is middleware mounted across
 * `*`, so every operation can answer 429 and not one of them said so. The
 * `Retry-After` header this ticket exists to declare has nowhere to hang
 * without it — a header is declared on a response, and the response was
 * missing too.
 */
const RATE_LIMITED_RESPONSE = {
  description:
    "Refused for rate or quota. `rate_limited` is the request limiter: the credential has spent its allowance for the current window, and `Retry-After` says how long to wait. `quota_exceeded` is a space quota on a stored resource, carrying `details.resource`, `details.limit` and `details.current`; it is not a window, so it carries no `Retry-After` and waiting does not clear it. The limiter is only mounted on a deployment that enables rate limiting; the quota refusal is always reachable on the routes that reserve one.",
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              // Both codes the server maps to 429. Declaring only the
              // limiter's made a generated client reject a real quota
              // refusal, which is the failure this whole change exists to
              // stop — a client learning the contract from the server
              // rather than from the specification.
              code: {
                type: "string",
                enum: ["rate_limited", "quota_exceeded"],
              },
              message: { type: "string" },
              details: {
                type: "object",
                properties: {
                  resource: { type: "string" },
                  limit: { type: "integer" },
                  current: { type: "integer" },
                },
              },
            },
            required: ["code", "message"],
          },
        },
        required: ["error"],
      },
    },
  },
};

/**
 * Operations that are published but not served at the path they are
 * published under, so nothing can be true of them.
 *
 * `/oauth2/register` is mounted under `/auth`, making the real path
 * `/auth/oauth2/register`. Declaring headers and a refusal on the phantom
 * would be describing a route that answers nothing. The wrong path predates
 * this and is tracked separately; what belongs here is only the refusal to
 * add to it.
 */
const UNSERVED_PATHS = new Set(["/oauth2/register"]);

/**
 * Responses that answer with an error status without passing through the
 * error handler, so `X-Error-Code` is never set on them.
 *
 * Empty, and worth keeping empty rather than deleting: it is the seam where
 * a future response that answers 4xx without throwing gets declared honestly
 * instead of silently claiming a header it does not send.
 *
 * It held `patch /items/{id} 409` until the conflict envelope stopped being
 * the one response whose fresh answer and replay differed in a declared
 * header. That route still returns rather than throws — the exclusion's
 * original wording anticipated the other fix — but it now stamps the header
 * itself, on the code the response actually carries, so the declaration is
 * true of it. The edge conflict envelope, the other 4xx that returns rather
 * than throws, does the same.
 */
const RESPONSES_WITHOUT_ERROR_CODE = new Set<string>([]);

/**
 * Statuses an idempotency claim releases rather than records.
 *
 * `RELEASED_STATUSES` in the middleware gives the key back on 401 and 403,
 * so neither is ever stored and neither can ever be replayed. Declaring the
 * replay marker on them is the same over-claiming this change exists to
 * remove.
 */
const NEVER_REPLAYED_STATUSES = new Set([401, 403]);

/** `{ "X-Request-ID": { "$ref": … }, … }` for the named headers. */
function headerRefs(names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    out[name] = { $ref: `#/components/headers/${name}` };
  }
  return out;
}

/**
 * Declare, on one operation, the headers its responses actually carry.
 *
 * Which headers apply is decided per status rather than per operation:
 * `X-Error-Code` rides every error the handler renders, `Retry-After` only
 * the limiter's own refusal. `Idempotency-Replayed` is the exception that
 * is decided per operation, and it goes on every response rather than only
 * the success one because a replay reproduces whatever the first attempt
 * answered — a recorded conflict replays as a conflict.
 */
function withResponseHeaders(
  operation: Record<string, unknown>,
  replays: boolean,
  operationKey: string,
): Record<string, unknown> {
  const responses = operation.responses;
  if (responses === null || typeof responses !== "object") return operation;

  const next: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(
    responses as Record<string, unknown>,
  )) {
    if (response === null || typeof response !== "object") {
      next[status] = response;
      continue;
    }
    const code = Number.parseInt(status, 10);
    const names = [...UNIVERSAL_RESPONSE_HEADERS];
    // `default` and any other non-numeric key parses to NaN, and NaN fails
    // both comparisons — so an unrecognized key gets the universal set and
    // no claim this code cannot support.
    if (
      code >= 400 &&
      !RESPONSES_WITHOUT_ERROR_CODE.has(`${operationKey} ${status}`)
    ) {
      names.push("X-Error-Code");
    }
    if (code === 429) names.push("Retry-After");
    if (replays && !NEVER_REPLAYED_STATUSES.has(code)) {
      names.push("Idempotency-Replayed");
    }

    const existing = (response as { headers?: Record<string, unknown> })
      .headers;
    next[status] = {
      ...response,
      headers: { ...headerRefs(names), ...(existing ?? {}) },
    };
  }

  return { ...operation, responses: next };
}

/** Shape the reflected document into the published public reference. */
export function finalizeOpenAPISpec<T extends OpenAPIDoc>(spec: T): T {
  spec.tags = PUBLIC_TAGS;

  // Build a new paths object excluding internal operations, rather than
  // deleting keys in place (cleaner, and avoids dynamic-delete).
  const sourcePaths = (spec.paths ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const nextPaths: Record<string, Record<string, unknown>> = {};
  for (const [pathKey, methods] of Object.entries(sourcePaths)) {
    const keptMethods: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(methods)) {
      const operationId = (op as { operationId?: unknown } | null)?.operationId;
      if (
        typeof operationId === "string" &&
        INTERNAL_OPERATION_IDS.has(operationId)
      ) {
        continue;
      }
      if (
        IDEMPOTENT_OPERATIONS.has(`${method} ${pathKey}`) &&
        op !== null &&
        typeof op === "object"
      ) {
        const operation = op as { parameters?: unknown[] };
        keptMethods[method] = {
          ...operation,
          parameters: [
            ...(operation.parameters ?? []),
            IDEMPOTENCY_HEADER_PARAM,
          ],
        };
        continue;
      }
      keptMethods[method] = op;
    }
    if (Object.keys(keptMethods).length > 0) {
      nextPaths[pathKey] = keptMethods;
    }
  }

  // Inject the plain-Hono consumer routes the reflection can't see.
  for (const [pathKey, def] of Object.entries(EXTRA_PATHS)) {
    nextPaths[pathKey] = { ...(nextPaths[pathKey] ?? {}), ...def };
  }

  // Declare the middleware-set response headers, last so that the injected
  // routes above are covered too — they are served through the same logger
  // and the same limiter as everything else, and a client reading the
  // reference has no way to know which routes the reflection happened to
  // see.
  for (const [pathKey, methods] of Object.entries(nextPaths)) {
    if (UNSERVED_PATHS.has(pathKey)) continue;
    const withHeaders: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(methods)) {
      if (op === null || typeof op !== "object") {
        withHeaders[method] = op;
        continue;
      }
      const operation = op as Record<string, unknown>;
      const responses = {
        ...((operation.responses as Record<string, unknown> | undefined) ?? {}),
      };
      responses["429"] ??= RATE_LIMITED_RESPONSE;
      withHeaders[method] = withResponseHeaders(
        { ...operation, responses },
        IDEMPOTENT_OPERATIONS.has(`${method} ${pathKey}`),
        `${method} ${pathKey}`,
      );
    }
    nextPaths[pathKey] = withHeaders;
  }

  spec.components = {
    ...(spec.components ?? {}),
    headers: RESPONSE_HEADER_COMPONENTS,
  };

  spec.paths = nextPaths;
  return spec;
}
