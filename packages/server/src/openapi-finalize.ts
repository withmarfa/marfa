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

// Loose typing — the document is a plain OpenAPI 3.1 object. `paths` is typed
// `object` (not a precise Record) so the concrete `OpenAPIObject`, whose
// `PathItemObject` values carry no index signature, still satisfies the
// constraint; the generic preserves the real return type for callers.
interface OpenAPIDoc {
  paths?: object;
  tags?: unknown[];
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
        "The cursor is a position in one ascending sequence, and `type` and `edges` select a subset of that sequence rather than reordering it, so a cursor taken under one filter can be replayed under another without skipping or repeating a row.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "type",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Comma-separated item types, up to 10 entries. A named type covers its subtree, so `core.media` delivers `core.media.song`. Omit to receive every type the credential can read. Edge events are unaffected: they carry no item type, so this parameter says nothing about them.",
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
            "The filter cannot be honored: more than 10 types, or an `edges` value outside the enum.",
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

  spec.paths = nextPaths;
  return spec;
}
