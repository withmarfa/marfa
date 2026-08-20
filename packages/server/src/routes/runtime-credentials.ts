/**
 * POST /system/runtime-credentials — mint a per-Connection runtime
 * credential.
 *
 * Called by the control-plane lease broker (which authenticates against
 * the Marfa server using a long-lived `MARFA_RUNTIME_BROKER_KEY` carrying
 * `is_platform: true`) to mint a short-TTL bearer for a specific
 * Connection's runtime. The broker caches the result on the per-Connection
 * DO with TTL ≤ 5 min and presents it on every Marfa API call the
 * integration's Worker makes.
 *
 * The minted credential carries:
 *   - `is_runtime_credential: true`
 *   - `connection_id: <stamped>` — the extension gate compares this
 *     against the path `:id` for cross-space denial when writing the
 *     `connection.runtime` namespace.
 *   - `space_id` copied from the Connection, not from the caller. The
 *     broker is space-less by construction, so inheriting the caller
 *     would strand the credential outside every space fence.
 *
 * Permission maps are projected server-side from the Connection's persisted
 * Integration manifest. The control plane cannot request broader reach.
 *
 * `integration_name` is the identity the control plane authenticated its
 * caller as, not a value the caller chose. This route checks it against
 * the manifest persisted on the Connection, so an integration Worker
 * cannot lease a Connection installed for a different integration even
 * if it learns the id. The check lives here rather than only in the
 * control plane because this is the party that holds the manifest.
 *
 * Caller authentication: `is_platform: true` required. Rejected
 * otherwise.
 */
import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth, hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { decryptSecret, SECRET_INFO } from "../crypto/secret-encryption.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  runtimeCredentialItemSource,
  withConnectionLifecycleLockInTransaction,
} from "../connections/lifecycle-lock.js";
import {
  buildEdgePermissions,
  buildExtensionPermissions,
  buildTypePermissions,
} from "../connections/manifest-permissions.js";
import {
  assertConnectionBelongsToIntegration,
  assertMintableSpaceScope,
  resolveRuntimeCredentialManifest,
  revokeSupersededRuntimeCredentials,
} from "../connections/runtime-credential-lifecycle.js";

const KEY_PREFIX = "marfa_k1_";

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

const RuntimeCredentialRequestSchema = z.object({
  /** Connection this credential is bound to. The extension gate keys
   *  off this value; cross-space misuse is rejected at the gate. */
  connection_id: z.string().min(1),
  /** Integration the control plane authenticated its caller as. Checked
   *  against the manifest persisted on the Connection; a mismatch is a
   *  403. Required, so a caller cannot opt out of the check by omitting
   *  it. */
  integration_name: z.string().min(1).max(200),
  /** Display label for the credential (audit log + UI). */
  label: z.string().min(1).max(200),
  /** Stamped onto the credential for display. Item provenance uses the
   *  Connection-stable `item_source` instead, which does not rotate. */
  source: z.string().min(1).max(200),
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
  operationId: "issueRuntimeCredential",
  method: "post",
  path: "/runtime-credentials",
  tags: ["System"],
  summary: "Issue a runtime credential",
  description:
    "Mints a short-lived API key scoped to a single connection. Permission maps are resolved by the server from the connection's persisted Integration manifest. The api_key is returned once and never again.",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
        },
      },
      description: "Validation error",
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
          schema: makeErrorResponseSchema([
            "forbidden",
            "connection_not_active",
          ]),
        },
      },
      description:
        "Caller lacks is_platform: true (forbidden), or the connection has left the active state (connection_not_active). Only the latter is specific to the connection; a broker that treats both as terminal deschedules every connection it brokers for.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["connection_not_found"]),
        },
      },
      description: "No such connection",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description: "source collision for space",
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
   *  the queue message envelope. */
  integration_name: z.string().optional(),
  events: z.array(z.string()),
  disabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Verify-context lookup — control-plane internal.
//
// Resolves the bits of state the runtime-control verify route needs to
// build a queue message envelope and dispatch it: the connection itself
// (validated as kind `integration` and active), the integration manifest
// name, and the space_id. Gated on `is_platform: true` — operator-debug
// surface, not consumer-facing.
// ---------------------------------------------------------------------------

const VerifyContextSchema = z.object({
  connection_id: z.string(),
  integration_name: z.string(),
  space_id: z.string().nullable(),
});

const verifyContextRoute = createRoute({
  operationId: "getConnectionVerifyContext",
  method: "get",
  path: "/connections/{connection_id}/verify-context",
  tags: ["System"],
  summary: "Get verify context for a connection",
  description:
    "Returns the integration name and space the runtime-control verify route needs to build a queue envelope. Requires the connection to exist, be kind integration, and be active.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      connection_id: z
        .string()
        .min(1)
        .describe("Connection to resolve verify context for."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: VerifyContextSchema } },
      description: "Verify context resolved.",
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
      description: "Caller lacks is_platform: true",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "Connection is not of kind `integration`, not active, or has an unresolved integration_ref.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["connection_not_found"]),
        },
      },
      description: "Connection not found.",
    },
  },
});

// ---------------------------------------------------------------------------
// DLQ-context lookup — control-plane internal.
//
// Sibling of verify-context, but without the kind/state narrowing. DLQ
// inspection should work even on paused or revoked connections — that's
// often why an operator is inspecting. Confirms the connection exists,
// surfaces enough metadata for the DLQ routes to operate, and gates on
// `is_platform: true`. Used as the auth-forwarding seam by
// runtime-control's POST /dlq/peek and POST /dlq/replay routes.
// ---------------------------------------------------------------------------

const DlqContextSchema = z.object({
  connection_id: z.string(),
  kind: z.string(),
  state: z.string(),
  integration_name: z.string().nullable(),
  space_id: z.string().nullable(),
});

const dlqContextRoute = createRoute({
  operationId: "getConnectionDlqContext",
  method: "get",
  path: "/connections/{connection_id}/dlq-context",
  tags: ["System"],
  summary: "Get DLQ context for a connection",
  description:
    "Returns minimal connection metadata for the runtime-control DLQ peek/replay routes. Unlike verify-context, it does not narrow by kind or state, since operators inspect DLQs precisely when a connection is unhealthy.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      connection_id: z
        .string()
        .min(1)
        .describe("Connection to resolve DLQ context for."),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: DlqContextSchema } },
      description: "DLQ context resolved.",
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
      description: "Caller lacks is_platform: true",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["connection_not_found"]),
        },
      },
      description: "Connection not found.",
    },
  },
});

const lookupInboundWebhooksRoute = createRoute({
  operationId: "listConnectionInboundWebhookSubscriptions",
  method: "get",
  path: "/inbound-webhook-subscriptions/{connection_id}",
  tags: ["System"],
  summary: "List inbound webhook subscriptions",
  description:
    "Returns every inbound-webhook subscription attached to a connection, with decrypted secrets included so the runtime-control plane can verify inbound HMAC signatures.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      connection_id: z
        .string()
        .min(1)
        .describe("Connection whose inbound-webhook subscriptions to list."),
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
      description: "Caller lacks is_platform: true",
    },
  },
});

export function runtimeCredentialRoutes(
  storage: Storage,
  salt: string,
  authMode: "hosted" | "keys",
) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createRuntimeCredentialRoute, async (c) => {
    const apiKey = requireAuth(c);
    if (!apiKey.is_platform) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Runtime credential minting requires a platform credential (is_platform: true)",
      );
    }

    const body = c.req.valid("json");

    // Every gate below reads Connection state, and a mint is only correct
    // for as long as that state holds. Uninstall takes the same
    // per-Connection lock before it revokes credentials and flips the
    // Connection to `revoked`, so serializing here is what stops a mint
    // that passed the state check from landing a live credential behind
    // an uninstall that has already swept. The state read has to be
    // inside the lock too: a read taken before acquiring it is a
    // snapshot of a decision someone else may already have overturned.
    const minted = await withConnectionLifecycleLockInTransaction(
      storage,
      body.connection_id,
      async () => {
        // Refuse to mint for non-active connections — the lease broker calls
        // this on every cache miss, so this gate cuts all downstream paths on
        // revocation.
        //
        // Both refusals below carry connection-specific codes rather than the
        // generic `not_found` / `forbidden` they share a status with. The
        // broker treats a per-connection refusal as terminal and permanently
        // tears the connection's schedule down; nothing re-arms it without an
        // operator. So the two refusals here must be distinguishable from the
        // route-level failures that share their status — a misrouted request
        // (404) and a caller lacking `is_platform` (403) — or one
        // misconfiguration silently deschedules every connection that reaches
        // this endpoint.
        const connection = await storage.items.get(body.connection_id);
        if (connection?.type !== "system.connection") {
          throw new MarfaError(
            ErrorCode.CONNECTION_NOT_FOUND,
            `Connection ${body.connection_id} not found`,
          );
        }
        if (connection.state !== "active") {
          throw new MarfaError(
            ErrorCode.CONNECTION_NOT_ACTIVE,
            `Connection ${body.connection_id} is ${connection.state}; cannot mint runtime credential`,
          );
        }

        const connectionProperties = connection.properties as { kind?: string };
        if (connectionProperties.kind !== "integration") {
          throw new MarfaError(
            ErrorCode.VALIDATION_ERROR,
            `Connection ${body.connection_id} is not of kind integration`,
          );
        }

        assertMintableSpaceScope(connection, authMode);
        await assertConnectionBelongsToIntegration(
          storage,
          connection,
          body.integration_name,
        );

        const ttlSeconds = body.ttl_seconds ?? 600;
        const expiresAt = new Date(
          Date.now() + ttlSeconds * 1000,
        ).toISOString();

        const rawKey = generateRawKey();
        const keyHash = hashApiKey(rawKey, salt);

        const manifest = await resolveRuntimeCredentialManifest(
          storage,
          connection,
        );

        const stored = await storage.keys.createRuntimeCredential(
          {
            label: body.label.trim(),
            source: body.source.trim(),
            role: "member",
            type_permissions: buildTypePermissions(
              manifest,
              connection.properties,
            ),
            extension_permissions: buildExtensionPermissions(manifest),
            edge_permissions: buildEdgePermissions(manifest),
            connection_id: body.connection_id,
            expires_at: expiresAt,
            // `source` rotates on every mint, so it cannot carry provenance.
            // `item_source` keys on the integration and the space, which is
            // what keeps `(source, source_id)` upsert identity intact across
            // credential refreshes and reinstalls alike.
            item_source: runtimeCredentialItemSource(manifest),
          },
          keyHash,
          // The connection's space, never the caller's. The broker
          // authenticates with a platform credential that carries no space,
          // so stamping the caller would leave the credential space-less —
          // which reads as "platform tier" to the RLS policies and to the
          // storage layer's space predicate, handing an integration built
          // for one space reach into all of them.
          connection.space_id ?? undefined,
        );

        await revokeSupersededRuntimeCredentials(
          storage,
          body.connection_id,
          connection.space_id ?? undefined,
          stored.id,
        );

        return {
          stored,
          rawKey,
          expiresAt,
          ttlSeconds,
          spaceId: connection.space_id ?? null,
        };
      },
    );

    // Outside the transaction deliberately. Audit is fire-and-forget, and
    // an unawaited query issued inside a transaction can reach the pool
    // after that transaction has already committed and released it.
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: minted.spaceId,
      key_id: apiKey.id,
      action: "runtime_credential.create",
      resource_type: "api_key",
      resource_id: minted.stored.id,
      details: {
        connection_id: body.connection_id,
        integration_name: body.integration_name,
        ttl_seconds: minted.ttlSeconds,
      },
    });

    return c.json(
      {
        id: minted.stored.id,
        api_key: minted.rawKey,
        connection_id: body.connection_id,
        label: minted.stored.label,
        source: minted.stored.source,
        expires_at: minted.expiresAt,
        created_at: minted.stored.created_at,
      },
      201,
    );
  });

  router.openapi(verifyContextRoute, async (c) => {
    const apiKey = requireAuth(c);
    if (!apiKey.is_platform) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Verify context lookup requires a platform credential (is_platform: true)",
      );
    }
    const { connection_id } = c.req.valid("param");
    const connection = await storage.items.get(connection_id);
    if (!connection) {
      throw new MarfaError(
        ErrorCode.CONNECTION_NOT_FOUND,
        "Connection not found",
      );
    }
    if (connection.type !== "system.connection") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Item is not a system.connection",
      );
    }
    const props = connection.properties as {
      kind?: string;
      status?: string;
      integration_ref?: string;
    };
    if (props.kind !== "integration") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Connection is not of kind `integration`",
        { kind: props.kind },
      );
    }
    if (connection.state !== "active" || props.status !== "active") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Connection is not active",
        { state: connection.state, status: props.status },
      );
    }
    if (!props.integration_ref) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Connection has no integration_ref",
      );
    }
    const integration = await storage.items.get(props.integration_ref);
    if (integration?.type !== "system.integration") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Connection's integration_ref does not resolve to a system.integration",
      );
    }
    const integrationName = (
      integration.properties as { manifest_name?: string }
    ).manifest_name;
    if (typeof integrationName !== "string" || integrationName.length === 0) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Integration manifest is missing a name",
      );
    }
    return c.json(
      {
        connection_id: connection.id,
        integration_name: integrationName,
        space_id: connection.space_id ?? null,
      },
      200,
    );
  });

  router.openapi(dlqContextRoute, async (c) => {
    const apiKey = requireAuth(c);
    if (!apiKey.is_platform) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "DLQ context lookup requires a platform credential (is_platform: true)",
      );
    }
    const { connection_id } = c.req.valid("param");
    const connection = await storage.items.get(connection_id);
    if (!connection) {
      throw new MarfaError(
        ErrorCode.CONNECTION_NOT_FOUND,
        "Connection not found",
      );
    }
    if (connection.type !== "system.connection") {
      throw new MarfaError(
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
        space_id: connection.space_id ?? null,
      },
      200,
    );
  });

  router.openapi(lookupInboundWebhooksRoute, async (c) => {
    const apiKey = requireAuth(c);
    if (!apiKey.is_platform) {
      throw new MarfaError(
        ErrorCode.FORBIDDEN,
        "Inbound webhook lookup requires a platform credential (is_platform: true)",
      );
    }
    const { connection_id } = c.req.valid("param");

    // Return empty for non-active connections. The uninstall pipeline disables
    // subscriptions individually, but a connection revoked through an admin
    // override or future API would still list rows without this gate.
    const connection = await storage.items.get(connection_id);
    if (connection?.type !== "system.connection") {
      return c.json({ subscriptions: [] }, 200);
    }
    if (connection.state !== "active") {
      return c.json({ subscriptions: [] }, 200);
    }

    const rows = await storage.inboundWebhooks.listByConnection(connection_id);
    // Resolve the manifest name once per connection (not per subscription row)
    // so the control plane can stamp `integration_name` on the queue envelope.
    let integrationName: string | undefined;
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
