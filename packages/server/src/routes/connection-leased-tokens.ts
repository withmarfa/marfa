import { createRoute, z } from "@hono/zod-openapi";
import { createHash, randomBytes } from "node:crypto";
import {
  MymeError,
  ErrorCode,
  generateId,
  type ConnectionLeasedToken,
  type CreatedConnectionLeasedToken,
  type LeaseTokenIntrospection,
} from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type {
  Storage,
  ConnectionLeasedTokenRow,
} from "../storage/interface.js";
import { resolveConnectionManifest } from "../connections/resolve-manifest.js";
import {
  createOpenAPIRouter,
  ErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";

// ---------------------------------------------------------------------------
// Connection leased tokens (workstream 2 PR 7)
//
// Issue short-TTL bearer tokens for the four exception cases the OAuth
// proxy doesn't fit (multipart streaming, WebSocket, SDK lock-in,
// non-HTTP). Capability gating ties each lease request to a manifest-
// declared `oauth_requirements: { <capability_id>: "leased" }` entry —
// requests for capabilities the manifest doesn't list, or that the
// manifest declares as `"proxy"` instead, are rejected.
//
// Storage shape: SHA-256 hash of the raw lease, like API keys. Plaintext
// is returned ONCE on issue. The validate endpoint hashes a presented
// bearer to look up the row.
//
// WS2 placeholder: the manifest is supplied with each lease request.
// WS3's runtime install pipeline will store the manifest at install
// time; the lease route can then read it from storage rather than
// the request body.
// ---------------------------------------------------------------------------

const LEASE_TTL_DEFAULT_SEC = 900; // 15 min
const LEASE_TTL_MAX_SEC = 3600; // 1 h

function hashLease(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * A credential source string that scopes the credential to a specific
 * connection. Two prefixes mint connection-scoped credentials today
 * (T-018):
 *
 *   - `oauth:<connectionId>` — the synthetic ApiKey constructed by the
 *     auth middleware for an OAuth `myme_at_*` access token. The token
 *     was minted via the `/auth/authorize` consent flow and the
 *     consenting user authorised the connection.
 *   - `integration:<connectionId>` — the runtime credential the
 *     install pipeline mints for the per-Connection Worker (see
 *     `connections/install-pipeline.ts`).
 *
 * Either source identifies "the connector itself" for the purpose of
 * managing leased tokens on this connection. Pre-T-018 the check was
 * narrowed to `oauth:` and the runtime credential's `integration:`
 * source got locked out — contradicting the design "the connector
 * requests a short-TTL bearer for direct calls".
 */
function isConnectionScopedSource(
  source: string,
  connectionId: string,
): boolean {
  return (
    source === `oauth:${connectionId}` ||
    source === `integration:${connectionId}`
  );
}

function rowToWire(
  row: ConnectionLeasedTokenRow,
  rawLease?: string,
): ConnectionLeasedToken | CreatedConnectionLeasedToken {
  const base: ConnectionLeasedToken = {
    id: row.id,
    connection_id: row.connection_id,
    tenant_id: row.tenant_id,
    capability_id: row.capability_id,
    scopes: row.scopes,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
  if (rawLease) return { ...base, lease_token: rawLease };
  return base;
}

async function requireConnectionAccess(
  c: import("hono").Context<AppEnv>,
  storage: Storage,
  connectionId: string,
): Promise<{ tenantId: string | undefined }> {
  const key = requireAuth(c);
  const isAdmin = key.role === "admin" || key.is_platform;
  const isConnector = isConnectionScopedSource(key.source, connectionId);
  // Defence-in-depth: any non-admin / non-connector credential MUST carry
  // a resolved `tenant_id`. Without it, the storage call sites below
  // treat `undefined` tenantId as cross-tenant (the same fall-through
  // that T-004 closes upstream). Refuse here so a future caller that
  // forgets to stamp tenant_id can't quietly bypass scoping on this
  // route. Runtime credentials and OAuth bearers issued for this
  // connection are exempt — their `connection_id` / source-prefix
  // binding is its own scope, and self-hosted (single-tenant) deploys
  // legitimately leave `tenant_id` unset on those.
  if (!isAdmin && !isConnector && !key.tenant_id) {
    throw new MymeError(
      ErrorCode.FORBIDDEN,
      "Tenant scope required for this credential",
    );
  }
  const tenantId = key.tenant_id ?? undefined;
  const connection = await storage.items.get(connectionId, tenantId);
  if (connection?.type !== "system.connection") {
    throw new MymeError(ErrorCode.NOT_FOUND, "Connection not found");
  }
  if (!isAdmin && !isConnector) {
    throw new MymeError(
      ErrorCode.FORBIDDEN,
      "Caller cannot manage leased tokens on this connection",
    );
  }
  return { tenantId };
}

// ---------------------------------------------------------------------------
// OpenAPI schemas
// ---------------------------------------------------------------------------

const LeaseSchema = z.object({
  id: z.string(),
  connection_id: z.string(),
  tenant_id: z.string().nullable(),
  capability_id: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.string(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

const CreatedLeaseSchema = LeaseSchema.extend({
  lease_token: z.string(),
});

const IntrospectionSchema = z.object({
  active: z.boolean(),
  connection_id: z.string().optional(),
  capability_id: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  expires_at: z.string().optional(),
});

const ConnectionIdParam = z.object({ id: z.string() });
const LeaseIdsParam = z.object({ id: z.string(), lease_id: z.string() });

const issueLeaseRoute = createRoute({
  method: "post",
  path: "/{id}/lease-token",
  tags: ["Connection Leased Tokens"],
  summary: "Issue a leased token",
  security: [{ bearerAuth: [] }],
  request: {
    params: ConnectionIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            capability_id: z.string().min(1),
            ttl_seconds: z
              .number()
              .int()
              .min(1)
              .max(LEASE_TTL_MAX_SEC)
              .optional(),
            scopes: z.array(z.string()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CreatedLeaseSchema } },
      description:
        "Lease issued. The `lease_token` field is returned ONCE; subsequent reads omit it.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Invalid input or TTL out of range",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller cannot manage this connection",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Connection not found",
    },
    422: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Manifest doesn't declare the capability as leased",
    },
  },
});

const listLeasesRoute = createRoute({
  method: "get",
  path: "/{id}/lease-tokens",
  tags: ["Connection Leased Tokens"],
  summary: "List active leases for a connection",
  security: [{ bearerAuth: [] }],
  request: { params: ConnectionIdParam },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ leases: z.array(LeaseSchema) }),
        },
      },
      description: "Active (non-revoked, non-expired) leases",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller cannot read this connection",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Connection not found",
    },
  },
});

const revokeLeaseRoute = createRoute({
  method: "post",
  path: "/{id}/lease-tokens/{lease_id}/revoke",
  tags: ["Connection Leased Tokens"],
  summary: "Revoke a leased token",
  security: [{ bearerAuth: [] }],
  request: { params: LeaseIdsParam },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Lease revoked (or already revoked)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller cannot manage this connection",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Connection or lease not found",
    },
  },
});

const introspectLeaseRoute = createRoute({
  method: "post",
  path: "/validate",
  tags: ["Connection Leased Tokens"],
  summary: "Introspect a leased token",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ lease_token: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: IntrospectionSchema } },
      description:
        "Active flag plus lease metadata when active. Returns 200 with `active: false` for unknown / expired / revoked leases.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing lease_token",
    },
  },
});

// ---------------------------------------------------------------------------
// Lease management routes (mounted under /connections)
// ---------------------------------------------------------------------------

export function connectionLeasedTokenRoutes(storage: Storage) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(issueLeaseRoute, async (c) => {
    const { id: connectionId } = c.req.valid("param");
    const { tenantId } = await requireConnectionAccess(
      c,
      storage,
      connectionId,
    );
    const body = c.req.valid("json");

    // Manifest is resolved server-side from the connection's
    // `integration_ref` → `system.integration` item. The inline-manifest
    // fallback was dropped in T-022.
    const { manifest } = await resolveConnectionManifest(
      storage,
      connectionId,
      tenantId,
    );
    const declared = manifest.oauth_requirements[body.capability_id];
    if (declared !== "leased") {
      throw new MymeError(
        ErrorCode.LEASE_CAPABILITY_NOT_DECLARED,
        declared === "proxy"
          ? `Capability '${body.capability_id}' is declared as 'proxy' in the manifest; lease issuance is not permitted. Use the proxy route instead.`
          : `Capability '${body.capability_id}' is not declared in the manifest's oauth_requirements with value 'leased'`,
      );
    }

    const ttlSec = body.ttl_seconds ?? LEASE_TTL_DEFAULT_SEC;
    if (ttlSec < 1 || ttlSec > LEASE_TTL_MAX_SEC) {
      throw new MymeError(
        ErrorCode.LEASE_TTL_OUT_OF_RANGE,
        `ttl_seconds must be between 1 and ${String(LEASE_TTL_MAX_SEC)}`,
      );
    }

    // Generate an opaque 32-byte hex bearer. Hashed at rest.
    const rawLease = `myme_lt_${randomBytes(32).toString("hex")}`;
    const id = generateId();
    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

    const row = await storage.connectionLeasedTokens.create({
      id,
      connection_id: connectionId,
      tenant_id: tenantId,
      capability_id: body.capability_id,
      lease_token_hash: hashLease(rawLease),
      scopes: body.scopes ?? [],
      expires_at: expiresAt,
      issued_by_key_id: c.get("apiKey")?.id,
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "lease.issue",
      resource_type: "connection_leased_token",
      resource_id: id,
      details: {
        connection_id: connectionId,
        capability_id: body.capability_id,
        ttl_seconds: ttlSec,
      },
    });

    const response = rowToWire(row, rawLease) as CreatedConnectionLeasedToken;
    return c.json(response, 201);
  });

  r.openapi(listLeasesRoute, async (c) => {
    const { id: connectionId } = c.req.valid("param");
    const { tenantId } = await requireConnectionAccess(
      c,
      storage,
      connectionId,
    );
    const rows = await storage.connectionLeasedTokens.listActiveByConnection(
      connectionId,
      new Date().toISOString(),
      tenantId,
    );
    return c.json(
      {
        leases: rows.map((row) => rowToWire(row) as ConnectionLeasedToken),
      },
      200,
    );
  });

  r.openapi(revokeLeaseRoute, async (c) => {
    const { id: connectionId, lease_id } = c.req.valid("param");
    const { tenantId } = await requireConnectionAccess(
      c,
      storage,
      connectionId,
    );
    const lease = await storage.connectionLeasedTokens.get(lease_id, tenantId);
    if (lease?.connection_id !== connectionId) {
      throw new MymeError(ErrorCode.LEASE_TOKEN_NOT_FOUND, "Lease not found");
    }
    await storage.connectionLeasedTokens.revoke(
      lease_id,
      new Date().toISOString(),
    );
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: c.get("apiKey")?.id,
      action: "lease.revoke",
      resource_type: "connection_leased_token",
      resource_id: lease_id,
    });
    return c.json({ ok: true as const }, 200);
  });

  return r;
}

// ---------------------------------------------------------------------------
// Public introspection route (mounted under /lease-tokens)
// ---------------------------------------------------------------------------

export function leaseTokenValidationRoutes(storage: Storage) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(introspectLeaseRoute, async (c) => {
    const body = c.req.valid("json");
    const lease = await storage.connectionLeasedTokens.findByHash(
      hashLease(body.lease_token),
    );
    const now = new Date().toISOString();

    let active: LeaseTokenIntrospection;
    if (!lease) {
      active = { active: false };
    } else if (lease.revoked_at !== null) {
      active = { active: false };
    } else if (lease.expires_at <= now) {
      active = { active: false };
    } else {
      active = {
        active: true,
        connection_id: lease.connection_id,
        capability_id: lease.capability_id,
        scopes: lease.scopes,
        expires_at: lease.expires_at,
      };
    }

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      action: "lease.validate",
      resource_type: "connection_leased_token",
      resource_id: lease?.id,
      details: { active: active.active },
    });

    return c.json(active, 200);
  });

  return r;
}
