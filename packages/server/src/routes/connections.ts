import { createRoute, z } from "@hono/zod-openapi";
import { MymeError, ErrorCode } from "@mymehq/shared";
import type { PreviewEventEnvelope, PreviewEventResult } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireWorkspaceAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  performUninstall,
  UninstallError,
} from "../connections/uninstall-pipeline.js";
import {
  armScheduleForInstall,
  performInstall,
} from "../connections/install-pipeline.js";
import type { IntegrationManifest } from "@mymehq/shared";
import { publish, resolveHopBudget } from "../pubsub.js";
import type { ItemEventWithId } from "../pubsub.js";
import {
  buildEntryForConnection,
  buildQueueMessageBody,
  evaluateDispatch,
} from "../connections/envelope.js";
import { createOpenAPIRouter, ErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Connection management routes (T-046 / PR A; T-040 install JSON sibling;
// T-083 preview-event).
//
// Today this file owns three operations:
//
//   - `POST /connections/install` — JSON sibling of the HTML consent
//     flow at `POST /integrations/:id/install`. Skips the browser consent
//     screen so operators and tooling can install non-interactively.
//     Used by the T-040 soak seeder and the CLI's
//     `my connections install` command. Calls `performInstall` directly.
//
//   - `POST /connections/:id/uninstall` — orchestrated uninstall of an
//     `integration` connection. Revokes runtime
//     credentials, drops upstream OAuth tokens, revokes leased tokens,
//     disables inbound webhooks, transitions the system.connection to
//     revoked, and emits a system.activity row — all in one place. See
//     `connections/uninstall-pipeline.ts` for the step-by-step rationale.
//
//   - `POST /connections/preview-event` (T-083) — render the wire
//     envelopes the reactive-run bridge would emit for a synthetic
//     item-event, without dispatch. Pure server-side transform; uses
//     the shared helpers in `connections/envelope.ts` so the bridge and
//     the preview surface compute the same shape.
//
// Auth model: `requireWorkspaceAdmin` on every route. Workspace admins
// operate on their own tenant's connections (storage lookups + writes
// are scoped via `apiKey.tenant_id`); platform admins on single-tenant
// self-hosts operate without a tenant scope and reach every connection.
// Non-admin credentials are rejected with 403.
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
  summary: "Orchestrated uninstall of an integration connection",
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
      description: "Connection is not an integration, or already revoked.",
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

// ---------------------------------------------------------------------------
// `POST /connections/preview-event` (T-083) — render the QueueMessageBody
// envelopes the reactive-run bridge would emit for a synthetic event,
// without dispatch. Pure server-side transform. Operator debugging surface.
// ---------------------------------------------------------------------------

const ITEM_EVENT_TYPES = [
  "created",
  "updated",
  "deleted",
  "restored",
  "state_changed",
  "metadata_changed",
] as const;

const PreviewEventQueueBodySchema = z.object({
  kind: z.literal("item-event"),
  integration_name: z.string(),
  connection_id: z.string(),
  tenant_id: z.string().optional(),
  event_type: z.string(),
  item_id: z.string(),
  cycle: z.object({
    originating_connection_id: z.string().nullable(),
    hop_count: z.number().int().nonnegative(),
  }),
  payload: z.unknown(),
});

const PreviewEventEnvelopeSchema = z.object({
  connection_id: z.string(),
  integration_name: z.string(),
  would_dispatch: z.boolean(),
  dispatch_reason: z.enum([
    "ok",
    "self_event",
    "cross_tenant",
    "hop_budget_exceeded",
    "subscription_inactive",
  ]),
  envelope: PreviewEventQueueBodySchema.optional(),
});

const PreviewEventRequestSchema = z.object({
  item_id: z.string().min(1),
  event_type: z.enum(ITEM_EVENT_TYPES),
  connection_id: z.string().optional(),
  cycle: z
    .object({
      originating_connection_id: z.string().nullable().optional(),
      hop_count: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const PreviewEventResultSchema = z.object({
  envelopes: z.array(PreviewEventEnvelopeSchema),
  hop_budget: z.object({
    max: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
  }),
});

const previewEventRoute = createRoute({
  method: "post",
  path: "/preview-event",
  tags: ["Connections"],
  summary:
    "Preview the bridge envelopes a synthetic item event would produce (no dispatch)",
  description:
    "Renders the wire envelopes the reactive-run bridge would POST to Cloudflare Queues for a given item-event, without invoking any handler or producing a queue message. Operator debugging surface (T-083). Returns one entry per subscribing connection in the caller's tenant — `would_dispatch: true` with the synthesised envelope, or `would_dispatch: false` with a `dispatch_reason` so the operator can see why a subscriber would be skipped (self-event / cross-tenant / hop-budget / subscription_inactive). Defaults to all subscribers; pass `connection_id` to filter to one. Workspace-admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: PreviewEventRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PreviewEventResultSchema } },
      description:
        "One entry per subscriber the operator asked about, plus the tenant's hop budget.",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Malformed request body.",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized.",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not a workspace admin or platform admin.",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "`item_id` does not resolve in the caller's tenant scope, or the filtered `connection_id` does not exist.",
    },
  },
});

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

    // Best-effort: arm the schedule alarm if the manifest has a schedule
    // trigger. Failures surface as system.activity action_required;
    // install itself stays successful.
    const controlPlaneUrl = process.env.MYME_RUNTIME_CONTROL_URL;
    const runtimeBrokerKey = process.env.MYME_RUNTIME_BROKER_KEY;
    if (controlPlaneUrl && runtimeBrokerKey) {
      await armScheduleForInstall(storage, {
        manifest: props.manifest as IntegrationManifest,
        connectionId: result.connection_id,
        tenantId,
        controlPlaneUrl,
        runtimeBrokerKey,
      });
    }

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

  r.openapi(previewEventRoute, async (c) => {
    // T-083: tenant-scoped preview of bridge fanout. workspace_admin so a
    // tenant admin can debug their own connectors without needing platform
    // creds; storage reads thread `apiKey.tenant_id` so cross-tenant
    // probes 404 on either the item or the filtered connection.
    const apiKey = requireWorkspaceAdmin(c);
    const tenantId = apiKey.tenant_id ?? undefined;
    const body = c.req.valid("json");

    const item = await storage.items.get(body.item_id, tenantId);
    if (!item) {
      throw new MymeError(
        ErrorCode.NOT_FOUND,
        "Item not found in this tenant scope",
        { item_id: body.item_id },
      );
    }

    // Construct the synthetic event the bridge would observe. `tenantId`
    // is omitted in keys-mode self-host (no tenant scope on the request);
    // the dispatch evaluator normalises both sides to null before
    // comparing so the cross-tenant gate doesn't trip spuriously.
    const cycle = body.cycle ?? {};
    const event: ItemEventWithId = {
      type: body.event_type,
      item,
      ...(tenantId !== undefined && { tenantId }),
      originatingConnectionId: cycle.originating_connection_id ?? null,
      hopCount: cycle.hop_count ?? 0,
    };

    const hopBudgetMax = await resolveHopBudget(tenantId);
    const hopCount = event.hopCount ?? 0;
    const isConnectorOriginated = event.originatingConnectionId != null;
    // Mirror `pubsub.passesHopBudget`: a connector-originated event with
    // hopCount=0 still counts as one hop so a malformed publish can't
    // bypass the budget. Human-originated events pass at hop 0.
    const effectiveHopCount = isConnectorOriginated
      ? Math.max(hopCount, 1)
      : hopCount;
    const hopBudgetExceeded =
      isConnectorOriginated && effectiveHopCount > hopBudgetMax;

    // Walk every active integration connection in the caller's tenant
    // and decide what the bridge would do per-subscriber. The `connection_id`
    // filter narrows the iteration to a single id; the route still
    // distinguishes "subscriber exists" from "subscriber doesn't exist"
    // via `subscription_inactive`.
    const envelopes: PreviewEventEnvelope[] = [];
    const considerSubscriber = (
      connectionId: string,
      entryOrNull: ReturnType<typeof buildEntryForConnection> extends Promise<
        infer T
      >
        ? T
        : never,
    ): void => {
      if (!entryOrNull) {
        envelopes.push({
          connection_id: connectionId,
          integration_name: "",
          would_dispatch: false,
          dispatch_reason: "subscription_inactive",
        });
        return;
      }
      // Hop budget is event-wide: when the gate trips upstream of the
      // bridge, NO envelope would be emitted for any subscriber. Surface
      // it consistently per-row so the operator sees why every
      // subscriber would be skipped.
      if (hopBudgetExceeded) {
        envelopes.push({
          connection_id: connectionId,
          integration_name: entryOrNull.integration_name,
          would_dispatch: false,
          dispatch_reason: "hop_budget_exceeded",
        });
        return;
      }
      const outcome = evaluateDispatch(event, entryOrNull);
      if (outcome.would_dispatch) {
        envelopes.push({
          connection_id: connectionId,
          integration_name: entryOrNull.integration_name,
          would_dispatch: true,
          dispatch_reason: "ok",
          envelope: buildQueueMessageBody(event, entryOrNull),
        });
      } else {
        envelopes.push({
          connection_id: connectionId,
          integration_name: entryOrNull.integration_name,
          would_dispatch: false,
          dispatch_reason: outcome.reason,
        });
      }
    };

    if (body.connection_id !== undefined) {
      const conn = await storage.items.get(body.connection_id, tenantId);
      if (!conn) {
        throw new MymeError(
          ErrorCode.NOT_FOUND,
          "Connection not found in this tenant scope",
          { connection_id: body.connection_id },
        );
      }
      const entry = await buildEntryForConnection(storage, {
        id: conn.id,
        properties: conn.properties,
        tenant_id: conn.tenant_id ?? null,
      });
      considerSubscriber(conn.id, entry);
    } else {
      let cursor: string | undefined;
      const PAGE = 200;
      for (;;) {
        const page = await storage.items.list({
          ...(tenantId !== undefined && { tenantId }),
          type: "system.connection",
          limit: PAGE,
          ...(cursor !== undefined && { cursor }),
        });
        for (const conn of page.data) {
          const entry = await buildEntryForConnection(storage, {
            id: conn.id,
            properties: conn.properties,
            tenant_id: conn.tenant_id ?? null,
          });
          // Skip non-subscribers (would-be `subscription_inactive` rows)
          // for the unfiltered case — they're noise. The filtered case
          // above keeps them so the operator gets actionable feedback
          // when they pointed at the wrong id.
          if (!entry) continue;
          considerSubscriber(conn.id, entry);
        }
        if (!page.has_more || !page.cursor) break;
        cursor = page.cursor;
      }
    }

    const result: PreviewEventResult = {
      envelopes,
      hop_budget: {
        max: hopBudgetMax,
        used: effectiveHopCount,
      },
    };
    return c.json(result, 200);
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
