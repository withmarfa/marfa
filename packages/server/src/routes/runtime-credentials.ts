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
  summary:
    "Mint a per-Connection runtime credential (control-plane lease broker only)",
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

const lookupInboundWebhooksRoute = createRoute({
  method: "get",
  path: "/inbound-webhook-subscriptions/{connection_id}",
  tags: ["System"],
  summary:
    "Look up inbound webhook subscriptions for a Connection — control-plane only",
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
