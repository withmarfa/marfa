import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireWorkspaceAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  performUninstall,
  UninstallError,
} from "../connections/uninstall-pipeline.js";
import { performInstall } from "../connections/install-pipeline.js";
import { publish } from "../pubsub.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Connection management routes (T-046 / PR A; T-040 install JSON sibling).
//
// Today this file owns two operations:
//
//   - `POST /connections/install` — JSON sibling of the HTML consent
//     flow at `POST /integrations/:id/install`. Skips the browser consent
//     screen (admin-only) so operators and tooling can install
//     non-interactively. Used by the T-040 soak seeder and the CLI's
//     `my connections install` command. Calls `performInstall` directly.
//
//   - `POST /connections/:id/uninstall` — orchestrated uninstall of an
//     `external-service-connector` connection. Revokes runtime
//     credentials, drops upstream OAuth tokens, revokes leased tokens,
//     disables inbound webhooks, transitions the system.connection to
//     revoked, and emits a system.activity row — all in one place. See
//     `connections/uninstall-pipeline.ts` for the step-by-step rationale.
//
// Auth model: `requireAdmin` for both. Tenant admins operate on their
// own tenant's connections (storage lookups are tenant-scoped via
// `apiKey.tenant_id`); platform admins on single-tenant self-hosts
// operate without a tenant scope and reach every connection. Non-admin
// credentials are rejected with 403.
// ---------------------------------------------------------------------------

const ConnectionIdParam = z.object({ id: z.string() });

const InstallRequestSchema = z.object({
  /** id of the system.integration item (a manifest registered via
   *  `POST /integrations`). The install pipeline reads its manifest and
   *  binds the new connection's `integration_ref` to this id. */
  integration_id: z.string(),
  /** Display label for the connection and seed credential. Defaults
   *  server-side to `${manifest_name} ${manifest_version}` when omitted. */
  label: z.string().optional(),
});

const InstallResultSchema = z.object({
  connection_id: z.string(),
  credential_id: z.string(),
  activity_id: z.string(),
});

const installRoute = createRoute({
  method: "post",
  path: "/install",
  tags: ["Connections"],
  summary: "JSON install of an Integration manifest (admin only)",
  description:
    "Server-side sibling of the browser consent flow at `POST /integrations/:id/install`. Skips the HTML consent screen — admin-only — so operators and tooling can install connections non-interactively. Body carries `integration_id` and an optional `label`. Returns the connection id, the seed runtime credential id, and the system.activity row id from the install pipeline. Same compensating-write pipeline as the HTML path; same audit trail.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: InstallRequestSchema },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: InstallResultSchema } },
      description:
        "Connection installed. Returns the new connection id, seed credential id, and activity id.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "integration_id does not refer to a system.integration item, or the manifest is invalid.",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized.",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not an admin.",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Integration not found in this tenant scope.",
    },
  },
});

const UninstallResultSchema = z.object({
  connection_id: z.string(),
  revoked_credential_ids: z.array(z.string()),
  oauth_tokens_deleted: z.boolean(),
  leased_tokens_revoked: z.number().int().nonnegative(),
  inbound_webhooks_disabled: z.number().int().nonnegative(),
  activity_id: z.string(),
});

const uninstallRoute = createRoute({
  method: "post",
  path: "/{id}/uninstall",
  tags: ["Connections"],
  summary: "Orchestrated uninstall of an external-service-connector connection",
  description:
    "Revokes the connection's runtime credentials, deletes any upstream OAuth tokens, revokes active leased tokens, disables inbound webhook subscriptions, transitions the system.connection to state `revoked`, and emits a system.activity row. Audit-logged. Idempotent at the artefact level (revoking an already-revoked artefact is a no-op), but rejects with 400 when the connection itself is already revoked.",
  security: [{ bearerAuth: [] }],
  request: {
    params: ConnectionIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: UninstallResultSchema } },
      description:
        "Connection uninstalled. Body details the artefacts cleaned up.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Connection is not an external-service-connector, or already revoked.",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized.",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not an admin.",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Connection not found in this tenant scope.",
    },
  },
});

interface IntegrationProperties {
  manifest_name: string;
  manifest_version: string;
  manifest: Record<string, unknown>;
}

export function connectionRoutes(storage: Storage, salt: string) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(installRoute, async (c) => {
    // T-051: workspace_admin can install/uninstall own-tenant connections.
    // Lookups + writes are scoped via `apiKey.tenant_id`, so cross-tenant
    // attempts surface as NOT_FOUND.
    const apiKey = requireWorkspaceAdmin(c);
    const { integration_id, label } = c.req.valid("json");
    const tenantId = apiKey.tenant_id ?? undefined;
    const clientIp = c.var.clientIp;

    const integration = await storage.items.get(integration_id, tenantId);
    if (!integration) {
      throw new MymeError(
        ErrorCode.NOT_FOUND,
        "Integration not found in this tenant scope",
      );
    }
    if (integration.type !== "system.integration") {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "integration_id does not refer to a system.integration item",
        { actual_type: integration.type },
      );
    }
    const props = integration.properties as unknown as IntegrationProperties;

    const trimmed = label?.trim();
    const effectiveLabel =
      trimmed && trimmed.length > 0
        ? trimmed
        : `${props.manifest_name} ${props.manifest_version}`;

    const result = await performInstall(storage, salt, {
      apiKeyId: apiKey.id,
      tenantId,
      integrationItemId: integration.id,
      manifest: props.manifest,
      label: effectiveLabel,
      clientIp,
    });

    // Hydrate the new system.connection item and publish a `created`
    // event onto pubsub. Without this the reactive-run bridge's
    // cache-invalidation subscriber (subscribes to ITEM_CHANGED with
    // typeFilter system.connection) never sees newly-installed
    // connections, so its in-memory subscription map stays stale and
    // the bridge fans out to nothing. The HTML consent flow at
    // routes/integrations.ts has the same bug — fix landed alongside
    // this one in a follow-up to keep this PR's diff scoped to the
    // path that ships in Wave A.
    const connection = await storage.items.get(result.connection_id, tenantId);
    if (connection) {
      const metadata = await storage.metadata.get(connection.id);
      await publish({
        type: "created",
        item: connection,
        metadata,
        tenantId,
        ...c.var.cycle,
      });
    }

    return c.json(result, 201);
  });

  r.openapi(uninstallRoute, async (c) => {
    // T-051: workspace_admin can install/uninstall own-tenant connections.
    // Lookups + writes are scoped via `apiKey.tenant_id`, so cross-tenant
    // attempts surface as NOT_FOUND.
    const apiKey = requireWorkspaceAdmin(c);
    const { id: connectionId } = c.req.valid("param");
    const tenantId = apiKey.tenant_id ?? undefined;
    const clientIp = c.var.clientIp;

    try {
      const result = await performUninstall(storage, {
        apiKeyId: apiKey.id,
        tenantId,
        connectionId,
        clientIp,
      });
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof UninstallError) {
        if (err.code === "connection_not_found") {
          throw new MymeError(ErrorCode.NOT_FOUND, err.message);
        }
        throw new MymeError(ErrorCode.VALIDATION_ERROR, err.message, {
          uninstall_error_code: err.code,
        });
      }
      throw err;
    }
  });

  return r;
}
