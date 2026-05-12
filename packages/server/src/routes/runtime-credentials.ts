/**
 * POST /system/runtime-credentials — mint a per-Connection runtime
 * credential.
 *
 * Workstream 3 Layer 1 PR 4. Called by the control-plane lease broker
 * (which authenticates against the Myme server using a long-lived
 * `MYME_RUNTIME_BROKER_KEY` carrying `is_platform: true`) to mint a
 * short-TTL bearer for a specific Connection's runtime. The broker
 * caches the result on the per-Connection DO with TTL ≤ 5 min and
 * presents it on every Myme API call the integration's Worker makes.
 *
 * The minted credential carries:
 *   - `is_runtime_credential: true`
 *   - `connection_id: <stamped>` — the extension gate compares this
 *     against the path `:id` for cross-tenant denial when writing the
 *     `connection.runtime` namespace.
 *
 * Permissions translated from the manifest at mint time:
 *   - `type_permissions` from manifest.permissions (when surfaced in
 *     Layer 2's install pipeline; Layer 1 accepts whatever the caller
 *     supplies and trusts the broker).
 *   - `extension_permissions` always carries `connection.runtime: write`
 *     so the credential can write its own subtree. Additional
 *     extension grants come from the manifest.
 *   - `edge_permissions`, `metadata_permissions` likewise from the
 *     manifest, optional.
 *
 * Caller authentication: `is_platform: true` required. Rejected
 * otherwise.
 */
import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { decryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

const KEY_PREFIX = "myme_k1_";

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

const PermissionsSchema = z
  .record(z.string(), z.enum(["read", "write", "none"]))
  .optional();

const ExtensionPermissionsSchema = z
  .record(z.string(), z.enum(["read", "write"]))
  .optional();

const EdgePermissionsSchema = z
  .record(z.string(), z.enum(["read", "write"]))
  .optional();

const RuntimeCredentialRequestSchema = z.object({
  /** Connection this credential is bound to. The extension gate keys
   *  off this value; cross-tenant misuse is rejected at the gate. */
  connection_id: z.string().min(1),
  /** Display label for the credential (audit log + UI). */
  label: z.string().min(1).max(200),
  /** Stamped onto items written by this credential. */
  source: z.string().min(1).max(200),
  type_permissions: PermissionsSchema,
  extension_permissions: ExtensionPermissionsSchema,
  edge_permissions: EdgePermissionsSchema,
  /** Lease TTL in seconds. Default 600 (10 min). Min 60, max 3600. */
  ttl_seconds: z.number().int().min(60).max(3600).optional(),
});

const RuntimeCredentialResponseSchema = z.object({
  id: z.string(),
  api_key: z.string(),
  connection_id: z.string(),
  label: z.string(),
  source: z.string(),
  expires_at: z.string(),
  created_at: z.string(),
});

const createRuntimeCredentialRoute = createRoute({
  method: "post",
  path: "/runtime-credentials",
  tags: ["System"],
  summary: "Issue a runtime credential",
  description:
    "Mints a short-lived API key scoped to a single connection. The runtime-control plane calls this to provision the credential a per-integration Worker presents when invoking Myme on the connection's behalf. The `api_key` field is returned **once**; subsequent reads omit it. Platform-credential gated.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: RuntimeCredentialRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: RuntimeCredentialResponseSchema },
      },
      description:
        "Runtime credential minted. The api_key is returned ONCE and never again.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller lacks is_platform: true",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "source collision for tenant",
    },
  },
});

// ---------------------------------------------------------------------------
// Inbound webhook subscription lookup — control-plane internal.
// ---------------------------------------------------------------------------

const InboundSubscriptionSchema = z.object({
  id: z.string(),
  connection_id: z.string(),
  external_service_id: z.string().optional(),
  /** Decrypted plaintext secret. Returned ONLY to platform callers
   *  (control-plane lease broker) so they can verify inbound HMAC
   *  signatures. Never appears on UI list/get endpoints. */
  secret: z.string(),
  verification_method: z.enum(["hmac-sha256", "slack", "stripe", "github"]),
  verification_adapter_id: z.string().optional(),
  /** Manifest name (e.g. `acme.calendar-sync`) projected from the
   *  connection's integration_ref so the control plane can stamp it on
   *  the queue message envelope (T-009). */
  integration_name: z.string().optional(),
  events: z.array(z.string()),
  disabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Verify-context lookup — control-plane internal (T-082).
//
// Resolves the bits of state the runtime-control verify route needs to
// build a queue message envelope and dispatch it: the connection itself
// (validated as kind `integration` and active), the integration manifest
// name, and the tenant_id. Gated on `is_platform: true` — operator-debug
// surface, not consumer-facing. Mirrors the same gate the
// `/system/runtime-credentials` endpoint applies (line 30 of this file).
// ---------------------------------------------------------------------------

const VerifyContextSchema = z.object({
  connection_id: z.string(),
  integration_name: z.string(),
  tenant_id: z.string().nullable(),
});

const verifyContextRoute = createRoute({
  method: "get",
  path: "/connections/{connection_id}/verify-context",
  tags: ["System"],
  summary: "Get verify context for a connection",
  description:
    "Returns the manifest `integration_name` and `tenant_id` the runtime-control verify route needs to construct a queue envelope. Validates the connection exists, is `kind: integration`, and is active. Platform-credential gated; operator-debug surface.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      connection_id: z.string().min(1),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: VerifyContextSchema } },
      description: "Verify context resolved.",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller lacks is_platform: true",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Connection is not of kind `integration`, not active, or has an unresolved integration_ref.",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Connection not found.",
    },
  },
});

// ---------------------------------------------------------------------------
// DLQ-context lookup — control-plane internal (T-084).
//
// Sibling of verify-context, but without the kind/state narrowing. DLQ
// inspection should work even on paused or revoked connections — that's
// often *why* an operator is inspecting. Confirms the connection exists,
// surfaces enough metadata for the DLQ routes to operate, and gates on
// `is_platform: true`. Used as the auth-forwarding seam by
// runtime-control's POST /dlq/peek and POST /dlq/replay routes.
// ---------------------------------------------------------------------------

const DlqContextSchema = z.object({
  connection_id: z.string(),
  kind: z.string(),
  state: z.string(),
  integration_name: z.string().nullable(),
  tenant_id: z.string().nullable(),
});

const dlqContextRoute = createRoute({
  method: "get",
  path: "/connections/{connection_id}/dlq-context",
  tags: ["System"],
  summary: "Get DLQ context for a connection",
  description:
    "Returns minimal connection metadata for the runtime-control DLQ peek/replay routes. Platform-credential gated; operator-debug surface. Unlike verify-context, this does NOT narrow by kind or state — operators inspect DLQs precisely when a connection is unhealthy.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      connection_id: z.string().min(1),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: DlqContextSchema } },
      description: "DLQ context resolved.",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller lacks is_platform: true",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Connection not found.",
    },
  },
});

const lookupInboundWebhooksRoute = createRoute({
  method: "get",
  path: "/inbound-webhook-subscriptions/{connection_id}",
  tags: ["System"],
  summary: "List inbound webhook subscriptions",
  description:
    "Returns every inbound-webhook subscription attached to a connection, with decrypted secrets included so the runtime-control plane can verify inbound HMAC signatures. Platform-credential gated; never exposed to consumer-facing API surfaces.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      connection_id: z.string().min(1),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            subscriptions: z.array(InboundSubscriptionSchema),
          }),
        },
      },
      description: "Subscriptions matching the connection (decrypted secrets)",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller lacks is_platform: true",
    },
  },
});

export function runtimeCredentialRoutes(storage: Storage, salt: string) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createRuntimeCredentialRoute, async (c) => {
    const apiKey = requireAuth(c);
    if (!apiKey.is_platform) {
      throw new MymeError(
        ErrorCode.FORBIDDEN,
        "Runtime credential minting requires a platform credential (is_platform: true)",
      );
    }

    const body = c.req.valid("json");
    const ttlSeconds = body.ttl_seconds ?? 600;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);

    // Always grant write on connection.runtime so the credential can
    // hydrate its own subtree. Manifest-supplied extension grants merge
    // on top.
    const extensionPermissions = {
      "connection.runtime": "write" as const,
      ...(body.extension_permissions ?? {}),
    };

    const stored = await storage.keys.createRuntimeCredential(
      {
        label: body.label.trim(),
        source: body.source.trim(),
        role: "member",
        type_permissions: body.type_permissions ?? {},
        extension_permissions: extensionPermissions,
        edge_permissions: body.edge_permissions ?? {},
        connection_id: body.connection_id,
      },
      keyHash,
      apiKey.tenant_id,
    );

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      tenant_id: c.get("apiKey")?.tenant_id ?? null,
      key_id: apiKey.id,
      action: "runtime_credential.create",
      resource_type: "api_key",
      resource_id: stored.id,
      details: {
        connection_id: body.connection_id,
        ttl_seconds: ttlSeconds,
      },
    });

    return c.json(
      {
        id: stored.id,
        api_key: rawKey,
        connection_id: body.connection_id,
        label: stored.label,
        source: stored.source,
        expires_at: expiresAt,
        created_at: stored.created_at,
      },
      201,
    );
  });

  router.openapi(verifyContextRoute, async (c) => {
    const apiKey = requireAuth(c);
    if (!apiKey.is_platform) {
      throw new MymeError(
        ErrorCode.FORBIDDEN,
        "Verify context lookup requires a platform credential (is_platform: true)",
      );
    }
    const { connection_id } = c.req.valid("param");
    const connection = await storage.items.get(connection_id);
    if (!connection) {
      throw new MymeError(
        ErrorCode.CONNECTION_NOT_FOUND,
        "Connection not found",
      );
    }
    if (connection.type !== "system.connection") {
      throw new MymeError(
        ErrorCode.CONNECTION_NOT_FOUND,
        "Item is not a system.connection",
      );
    }
    const props = connection.properties as {
      kind?: string;
      status?: string;
      integration_ref?: string;
    };
    if (props.kind !== "integration") {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Connection is not of kind `integration`",
        { kind: props.kind },
      );
    }
    if (connection.state !== "active" || props.status !== "active") {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Connection is not active",
        { state: connection.state, status: props.status },
      );
    }
    if (!props.integration_ref) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Connection has no integration_ref",
      );
    }
    const integration = await storage.items.get(props.integration_ref);
    if (integration?.type !== "system.integration") {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Connection's integration_ref does not resolve to a system.integration",
      );
    }
    const integrationName = (
      integration.properties as { manifest_name?: string }
    ).manifest_name;
    if (typeof integrationName !== "string" || integrationName.length === 0) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Integration manifest is missing a name",
      );
    }
    return c.json(
      {
        connection_id: connection.id,
        integration_name: integrationName,
        tenant_id: connection.tenant_id ?? null,
      },
      200,
    );
  });

  router.openapi(dlqContextRoute, async (c) => {
    const apiKey = requireAuth(c);
    if (!apiKey.is_platform) {
      throw new MymeError(
        ErrorCode.FORBIDDEN,
        "DLQ context lookup requires a platform credential (is_platform: true)",
      );
    }
    const { connection_id } = c.req.valid("param");
    const connection = await storage.items.get(connection_id);
    if (!connection) {
      throw new MymeError(
        ErrorCode.CONNECTION_NOT_FOUND,
        "Connection not found",
      );
    }
    if (connection.type !== "system.connection") {
      throw new MymeError(
        ErrorCode.CONNECTION_NOT_FOUND,
        "Item is not a system.connection",
      );
    }
    const props = connection.properties as {
      kind?: string;
      status?: string;
      integration_ref?: string;
    };
    let integrationName: string | null = null;
    if (props.integration_ref) {
      const integration = await storage.items.get(props.integration_ref);
      if (integration?.type === "system.integration") {
        const name = (integration.properties as { manifest_name?: string })
          .manifest_name;
        if (typeof name === "string" && name.length > 0) {
          integrationName = name;
        }
      }
    }
    return c.json(
      {
        connection_id: connection.id,
        kind: props.kind ?? "unknown",
        state: connection.state,
        integration_name: integrationName,
        tenant_id: connection.tenant_id ?? null,
      },
      200,
    );
  });

  router.openapi(lookupInboundWebhooksRoute, async (c) => {
    const apiKey = requireAuth(c);
    if (!apiKey.is_platform) {
      throw new MymeError(
        ErrorCode.FORBIDDEN,
        "Inbound webhook lookup requires a platform credential (is_platform: true)",
      );
    }
    const { connection_id } = c.req.valid("param");
    const rows = await storage.inboundWebhooks.listByConnection(connection_id);
    // T-009: project the integration manifest's `name` so the control
    // plane can stamp `integration_name` on the queue message envelope.
    // Resolve once per connection (low cardinality) rather than per-row.
    const connection = await storage.items.get(connection_id);
    let integrationName: string | undefined;
    if (connection?.type === "system.connection") {
      const integrationRef = (
        connection.properties as { integration_ref?: string }
      ).integration_ref;
      if (integrationRef) {
        const integration = await storage.items.get(integrationRef);
        if (integration?.type === "system.integration") {
          const name = (integration.properties as { manifest_name?: string })
            .manifest_name;
          if (typeof name === "string") integrationName = name;
        }
      }
    }
    const subscriptions = rows
      .filter((row) => !row.disabled)
      .map((row) => ({
        id: row.id,
        connection_id: row.connection_id,
        external_service_id: row.external_service_id ?? undefined,
        secret: decryptSecret(
          row.secret_encrypted,
          SECRET_INFO.inboundWebhookSecret,
        ),
        verification_method: row.verification_method as
          | "hmac-sha256"
          | "slack"
          | "stripe"
          | "github",
        verification_adapter_id: row.verification_adapter_id ?? undefined,
        integration_name: integrationName,
        events: row.events,
        disabled: row.disabled,
      }));
    return c.json({ subscriptions }, 200);
  });

  return router;
}
