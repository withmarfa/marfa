import { createRoute, z } from "@hono/zod-openapi";
import { createHash, randomBytes } from "node:crypto";
import {
  MarfaError,
  ErrorCode,
  generateId,
  type ConnectionLeasedToken,
  type CreatedConnectionLeasedToken,
  type LeaseTokenIntrospection,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  actsAsConnection,
  hasSpaceAdminAuthority,
  hasPlatformAuthority,
} from "../middleware/auth.js";
import type {
  Storage,
  ConnectionLeasedTokenRow,
} from "../storage/interface.js";
import { resolveConnectionManifest } from "../connections/resolve-manifest.js";
import {
  createOpenAPIRouter,
  OkResponseSchema,
  makeErrorResponseSchema,
} from "../openapi.js";

// ---------------------------------------------------------------------------
// Connection leased tokens
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
// The manifest is resolved server-side from the connection's
// `integration_ref` → `system.integration` item.
// ---------------------------------------------------------------------------

const LEASE_TTL_DEFAULT_SEC = 900; // 15 min
const LEASE_TTL_MAX_SEC = 3600; // 1 h

function hashLease(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function rowToWire(
  row: ConnectionLeasedTokenRow,
  rawLease?: string,
): ConnectionLeasedToken | CreatedConnectionLeasedToken {
  const base: ConnectionLeasedToken = {
    id: row.id,
    connection_id: row.connection_id,
    space_id: row.space_id,
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
): Promise<{
  spaceId: string | undefined;
  /** The connection's own space, distinct from the caller's: a platform
   *  admin carries no space, but a lease row must live in the
   *  connection's space or the space-fenced list and revoke lookups —
   *  and the uninstall pipeline's revocation sweep — can never reach
   *  it. */
  connectionSpaceId: string | undefined;
}> {
  const key = requireAuth(c);
  // Space-bounded admin authority, matching the sibling connection
  // routes: leased tokens belong to a connection, and a connection
  // belongs to a space.
  const isAdmin = hasSpaceAdminAuthority(key) || key.is_platform;
  // Shared with the connection-proxy and inbound-webhook routes: the
  // caller is the Connection itself, either as an OAuth grant or as a
  // runtime credential stamped with this `connection_id`.
  const isIntegration = actsAsConnection(key, connectionId);
  // Defense-in-depth: any credential that would resolve to an undefined
  // spaceId below must be entitled to cross-space reach, because the
  // storage call sites treat `undefined` as "any space". The test is
  // platform authority (unbound admin) or an explicit platform
  // credential — NOT space-admin rank, which says nothing about
  // whether the credential is confined. Runtime credentials and OAuth
  // bearers issued for this connection are exempt: their
  // `connection_id` / source-prefix binding is its own scope, and
  // self-hosted (single-space) deploys legitimately leave `space_id`
  // unset on those.
  if (
    !key.space_id &&
    !isIntegration &&
    !hasPlatformAuthority(key) &&
    !key.is_platform
  ) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Space scope required for this credential",
    );
  }
  const spaceId = key.space_id ?? undefined;
  const connection = await storage.items.get(connectionId, spaceId);
  if (connection?.type !== "system.connection") {
    throw new MarfaError(ErrorCode.NOT_FOUND, "Connection not found");
  }
  if (!isAdmin && !isIntegration) {
    throw new MarfaError(
      ErrorCode.FORBIDDEN,
      "Caller cannot manage leased tokens on this connection",
    );
  }
  return { spaceId, connectionSpaceId: connection.space_id ?? undefined };
}

// ---------------------------------------------------------------------------
// OpenAPI schemas
// ---------------------------------------------------------------------------

const LeaseSchema = z.object({
  id: z.string(),
  connection_id: z.string(),
  space_id: z.string().nullable(),
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

const ConnectionIdParam = z.object({
  id: z.string().describe("Id of the connection the lease belongs to."),
});
const LeaseIdsParam = z.object({
  id: z.string().describe("Id of the connection the lease belongs to."),
  lease_id: z.string().describe("Id of the lease to revoke."),
});

const issueLeaseRoute = createRoute({
  operationId: "mintLeaseToken",
  method: "post",
  path: "/{id}/lease-tokens",
  tags: ["Connection Leased Tokens"],
  summary: "Issue a leased token",
  description:
    "Mints a short-TTL bearer token an external service can use to call back into Marfa directly, without holding the connection's full runtime credential. The capability must be declared as `leased` in the connection manifest's `oauth_requirements`, otherwise the request rejects with 422; the `lease_token` is returned only once, in this response. `scopes` are capability claims in the upstream service's own vocabulary, relayed verbatim on introspection — a lease grants no Marfa data-plane authority of its own.",
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
            // Claims for the introspecting upstream, not Marfa scope
            // grammar — the manifest declares no per-capability scope
            // vocabulary, so nothing semantic exists to validate against.
            // Bounded so introspection cannot be used as a free-form
            // storage channel.
            scopes: z.array(z.string().min(1).max(256)).max(32).optional(),
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "lease_ttl_out_of_range",
          ]),
        },
      },
      description: "Invalid input or TTL out of range",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller cannot manage this connection",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Connection not found",
    },
    422: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["lease_capability_not_declared"]),
        },
      },
      description: "Manifest doesn't declare the capability as leased",
    },
  },
});

const listLeasesRoute = createRoute({
  operationId: "listLeaseTokens",
  method: "get",
  path: "/{id}/lease-tokens",
  tags: ["Connection Leased Tokens"],
  summary: "List active leases for a connection",
  description:
    "Returns the connection's leases that are neither revoked nor expired. The lease tokens themselves are never returned here — only lease metadata.",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller cannot read this connection",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Connection not found",
    },
  },
});

const revokeLeaseRoute = createRoute({
  operationId: "revokeLeaseToken",
  method: "post",
  path: "/{id}/lease-tokens/{lease_id}/revoke",
  tags: ["Connection Leased Tokens"],
  summary: "Revoke a leased token",
  description:
    "Invalidates a lease before its TTL expires, so the next introspection returns `active: false`. Idempotent — revoking an already-revoked lease returns 200.",
  security: [{ bearerAuth: [] }],
  request: { params: LeaseIdsParam },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Lease revoked (or already revoked)",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller cannot manage this connection",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "not_found",
            "lease_token_not_found",
          ]),
        },
      },
      description: "Connection or lease not found",
    },
  },
});

const introspectLeaseRoute = createRoute({
  operationId: "validateLeaseToken",
  method: "post",
  path: "/validate",
  tags: ["Connection Leased Tokens"],
  summary: "Introspect a leased token",
  description:
    "Introspects a lease token so an external service can verify it before honoring a callback. Tokens that are revoked, expired, or unrecognized return `active: false` with no further metadata.",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
        },
      },
      description: "Missing lease_token",
    },
  },
});

// ---------------------------------------------------------------------------
// Routes (mounted under /connections)
// ---------------------------------------------------------------------------

export function connectionLeasedTokenRoutes(storage: Storage) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(issueLeaseRoute, async (c) => {
    const { id: connectionId } = c.req.valid("param");
    const { spaceId, connectionSpaceId } = await requireConnectionAccess(
      c,
      storage,
      connectionId,
    );
    const body = c.req.valid("json");

    const { manifest } = await resolveConnectionManifest(
      storage,
      connectionId,
      spaceId,
    );
    const declared = manifest.oauth_requirements[body.capability_id];
    if (declared !== "leased") {
      throw new MarfaError(
        ErrorCode.LEASE_CAPABILITY_NOT_DECLARED,
        declared === "proxy"
          ? `Capability '${body.capability_id}' is declared as 'proxy' in the manifest; lease issuance is not permitted. Use the proxy route instead.`
          : `Capability '${body.capability_id}' is not declared in the manifest's oauth_requirements with value 'leased'`,
      );
    }

    const ttlSec = body.ttl_seconds ?? LEASE_TTL_DEFAULT_SEC;
    if (ttlSec < 1 || ttlSec > LEASE_TTL_MAX_SEC) {
      throw new MarfaError(
        ErrorCode.LEASE_TTL_OUT_OF_RANGE,
        `ttl_seconds must be between 1 and ${String(LEASE_TTL_MAX_SEC)}`,
      );
    }

    const rawLease = `marfa_lt_${randomBytes(32).toString("hex")}`;
    const id = generateId();
    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

    const row = await storage.connectionLeasedTokens.create({
      id,
      connection_id: connectionId,
      // The connection's space, not the caller's: a platform admin has
      // no space, and a space-less lease row is invisible to the fenced
      // list and revoke lookups and to the uninstall pipeline's sweep,
      // while validate keeps answering active until the TTL runs out.
      space_id: connectionSpaceId,
      capability_id: body.capability_id,
      lease_token_hash: hashLease(rawLease),
      scopes: body.scopes ?? [],
      expires_at: expiresAt,
      issued_by_key_id: c.get("apiKey")?.id,
    });

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
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
    const { spaceId } = await requireConnectionAccess(c, storage, connectionId);
    const rows = await storage.connectionLeasedTokens.listActiveByConnection(
      connectionId,
      new Date().toISOString(),
      spaceId,
    );
    return c.json(
      {
        leases: rows.map((row) => rowToWire(row)),
      },
      200,
    );
  });

  r.openapi(revokeLeaseRoute, async (c) => {
    const { id: connectionId, lease_id } = c.req.valid("param");
    const { spaceId } = await requireConnectionAccess(c, storage, connectionId);
    const lease = await storage.connectionLeasedTokens.get(lease_id, spaceId);
    if (lease?.connection_id !== connectionId) {
      throw new MarfaError(ErrorCode.LEASE_TOKEN_NOT_FOUND, "Lease not found");
    }
    await storage.connectionLeasedTokens.revoke(
      lease_id,
      new Date().toISOString(),
    );
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
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
      space_id: c.get("apiKey")?.space_id ?? null,
      action: "lease.validate",
      resource_type: "connection_leased_token",
      resource_id: lease?.id,
      details: { active: active.active },
    });

    return c.json(active, 200);
  });

  return r;
}
