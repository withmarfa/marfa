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
 *      server metrics, blob maintenance, by-id tenant quotas). They still
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

/** Ordered, described public tag list. Resources first; auth/realtime last. */
const PUBLIC_TAGS = [
  {
    name: "Items",
    description:
      "Create, read, update, and query items — the core typed records.",
  },
  {
    name: "Metadata",
    description: "An item's metadata document and the tenant's tag vocabulary.",
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
    name: "Tenants",
    description: "Configuration and quotas for the calling tenant.",
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
  { name: "Export", description: "Bulk export of a tenant's data." },
  { name: "Audit", description: "The tenant's audit log." },
  {
    name: "Events",
    description: "The server-sent events stream of item and edge changes.",
  },
  { name: "Auth", description: "OAuth dynamic client registration." },
];

/**
 * Operations excluded from the public reference, by operationId. These are
 * platform-internal — they still serve, but app developers never call them.
 * A new internal route adds its operationId here.
 */
const INTERNAL_OPERATION_IDS = new Set<string>([
  // admin.ts — platform-admin tenant operations
  "adminListTenants",
  "adminGetTenant",
  "adminSuspendTenant",
  "adminUnsuspendTenant",
  "adminGetTenantMetrics",
  "adminListTenantKeys",
  "adminPurgePendingDeletions",
  // admin-archive.ts
  "adminRestoreArchive",
  // metrics.ts — server metrics
  "getServerMetrics",
  // runtime-credentials.ts — lease-broker plumbing
  "issueRuntimeCredential",
  "getConnectionVerifyContext",
  "getConnectionDlqContext",
  "listConnectionInboundWebhookSubscriptions",
  // blobs.ts — operator maintenance
  "cleanupBlobs",
  "reconcileBlobs",
  // tenants.ts — platform-admin, by tenant id (self-service /me/quotas stays public)
  "getTenantQuotas",
  "updateTenantQuotas",
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
        "Opens a Server-Sent Events stream of item and edge changes for the caller's tenant. Send `Last-Event-ID` to replay events missed across a reconnect.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "type",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Type pattern to filter the stream, such as `core.note` or `core.*`.",
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
