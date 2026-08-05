import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type {
  PreviewEventEnvelope,
  PreviewEventResult,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireSpaceAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  performPause,
  performResume,
  PauseError,
} from "../connections/pause-pipeline.js";
import {
  performUninstall,
  UninstallError,
} from "../connections/uninstall-pipeline.js";
import {
  armScheduleForInstall,
  performInstall,
} from "../connections/install-pipeline.js";
import type { IntegrationManifest } from "@withmarfa/shared";
import {
  computeEffectiveHopCount,
  publish,
  resolveHopBudget,
} from "../pubsub.js";
import type { ItemEventWithId } from "../pubsub.js";
import {
  buildEntryForConnection,
  buildQueueMessageBody,
  evaluateDispatch,
} from "../connections/envelope.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

// ---------------------------------------------------------------------------
// Connection management routes. This file owns three operations:
//
//   - `POST /connections/install` — JSON sibling of the HTML consent
//     flow at `POST /integrations/:id/install`. Skips the browser consent
//     screen so operators and tooling can install non-interactively.
//     Calls `performInstall` directly.
//
//   - `POST /connections/:id/uninstall` — orchestrated uninstall of an
//     `integration` connection. Revokes runtime credentials, drops
//     upstream OAuth tokens, revokes leased tokens, disables inbound
//     webhooks, transitions the system.connection to revoked, and emits
//     a system.activity row. See `connections/uninstall-pipeline.ts`
//     for the step-by-step rationale.
//
//   - `POST /connections/preview-event` — render the wire envelopes the
//     reactive-run bridge would emit for a synthetic item-event, without
//     dispatch. Pure server-side transform; uses the shared helpers in
//     `connections/envelope.ts` so the bridge and the preview surface
//     compute the same shape.
//
// Auth model: `requireSpaceAdmin` on every route. Space admins
// operate on their own space's connections (storage lookups + writes
// are scoped via `apiKey.space_id`); platform admins on single-space
// self-hosts operate without a space scope and reach every connection.
// Non-admin credentials are rejected with 403.
// ---------------------------------------------------------------------------

const ConnectionIdParam = z.object({
  id: z.string().describe("Id of the connection to uninstall."),
});

const InstallRequestSchema = z.object({
  /** id of the system.integration item (a manifest registered via
   *  `POST /integrations`). The install pipeline reads its manifest and
   *  binds the new connection's `integration_ref` to this id. */
  integration_id: z.string(),
  /** Display label for the connection and seed credential. Defaults
   *  server-side to `${manifest_name} ${manifest_version}` when omitted. */
  label: z.string().optional(),
  /** Optional id of an existing `system.credential` (kind `oauth_token`)
   *  to reference instead of provisioning a fresh provider credential.
   *  Lets multiple integrations of the same upstream (e.g.
   *  `google.calendar` + `google.tasks`) share one OAuth client config.
   *  Create such credentials via `POST /credentials/oauth-provider`. */
  credential_ref: z.string().optional(),
  /** Optional seed for the new connection's `properties.configuration`
   *  bag. Free-form per-integration knobs (e.g. `upstream_base_url_override`
   *  for connections sharing one OAuth credential across different upstream
   *  hosts). Merged over the empty default at install time so callers
   *  don't need a follow-on `PATCH /items/:id` round-trip. */
  configuration: z.record(z.string(), z.unknown()).optional(),
});

const InstallResultSchema = z.object({
  connection_id: z.string(),
  credential_id: z.string(),
  activity_id: z.string(),
});

const installRoute = createRoute({
  operationId: "installConnection",
  method: "post",
  path: "/install",
  tags: ["Connections"],
  summary: "Install an integration",
  description:
    "Installs a connection from a registered integration manifest without the browser consent screen, for non-interactive operator and tooling use. Admin-only; runs the same compensating-write pipeline and audit trail as the HTML consent flow.",
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
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
          ]),
        },
      },
      description:
        "integration_id does not refer to a system.integration item, or the manifest is invalid.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized.",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller is not an admin.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["integration_not_found"]),
        },
      },
      description:
        "Integration not found. Matches both genuinely-missing manifest ids and ids that exist but resolve to a non-`system.integration` item.",
    },
  },
});

const UninstallResultSchema = z.object({
  connection_id: z.string(),
  revoked_credential_ids: z.array(z.string()),
  oauth_tokens_deleted: z.boolean(),
  leased_tokens_revoked: z.number().int().nonnegative(),
  inbound_webhooks_disabled: z.number().int().nonnegative(),
  schedules_disarmed: z
    .boolean()
    .describe(
      "Whether a schedule alarm was actually cancelled for this connection. False when there was nothing to cancel — a deployment with no runtime control plane, or an integration that deploys no Worker — and false on a failed disarm; check `schedule_disarm_error` to tell those apart.",
    ),
  schedule_disarm_error: z
    .string()
    .optional()
    .describe(
      "Why the schedule disarm failed, when one was attempted. The uninstall still completed; re-run the disarm to clear the residual alarm.",
    ),
  activity_id: z.string(),
});

const PauseResultSchema = z.object({
  connection_id: z.string(),
  runtime_status: z.enum(["paused", "healthy"]),
  schedule_changed: z
    .boolean()
    .describe(
      "Whether a schedule alarm actually changed state. False when there was nothing to change — a deployment with no runtime control plane, or an integration that deploys no Worker — and false on a failed call; check `schedule_error` to tell those apart.",
    ),
  schedule_error: z
    .string()
    .optional()
    .describe(
      "Present only when the schedule call ran and failed. The status write still happened, so the connection reads as paused with its alarm possibly still armed. Retry.",
    ),
  activity_id: z.string(),
});

const pauseResponses = {
  200: {
    content: { "application/json": { schema: PauseResultSchema } },
    description: "Runtime status updated and the schedule changed to match.",
  },
  400: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["validation_error"]),
      },
    },
    description:
      "Connection is not an integration, is revoked, or is already in the requested state.",
  },
  401: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["unauthorized"]),
      },
    },
    description: "Unauthorized.",
  },
  403: {
    content: {
      "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
    },
    description: "Caller is not an admin.",
  },
  404: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["connection_not_found"]),
      },
    },
    description: "Connection not found.",
  },
} as const;

const pauseRoute = createRoute({
  operationId: "pauseConnection",
  method: "post",
  path: "/{id}/pause",
  tags: ["Connections"],
  summary: "Pause an integration connection",
  description:
    "Stops a connection without tearing it down: sets `runtime_status` to `paused` and disarms its schedule, so scheduled runs and item-event dispatches both stop. Credentials and the upstream OAuth grant are left intact, so `resume` restores it without a fresh consent round trip. Pausing an already-paused connection returns 400.",
  security: [{ bearerAuth: [] }],
  request: { params: ConnectionIdParam },
  responses: pauseResponses,
});

const resumeRoute = createRoute({
  operationId: "resumeConnection",
  method: "post",
  path: "/{id}/resume",
  tags: ["Connections"],
  summary: "Resume a paused integration connection",
  description:
    "Reverses `pause`: sets `runtime_status` back to `healthy` and re-arms the schedule. Resuming a connection that is not paused returns 400, and a revoked connection cannot be resumed — that is what reinstalling is for.",
  security: [{ bearerAuth: [] }],
  request: { params: ConnectionIdParam },
  responses: pauseResponses,
});

const uninstallRoute = createRoute({
  operationId: "uninstallConnection",
  method: "post",
  path: "/{id}/uninstall",
  tags: ["Connections"],
  summary: "Uninstall an integration connection",
  description:
    "Tears down a connection in one pass: revokes its credentials and leased tokens, drops upstream OAuth tokens, disables inbound webhooks, and transitions it to `revoked`. Idempotent per artifact, but rejects with 400 when the connection itself is already revoked.",
  security: [{ bearerAuth: [] }],
  request: {
    params: ConnectionIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: UninstallResultSchema } },
      description:
        "Connection uninstalled. Body details the artifacts cleaned up.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Connection is not an integration, or already revoked.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized.",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller is not an admin.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["connection_not_found"]),
        },
      },
      description: "Connection not found in this space scope.",
    },
  },
});

interface IntegrationProperties {
  manifest_name: string;
  manifest_version: string;
  manifest: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// `POST /connections/preview-event` — render the QueueMessageBody
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
  space_id: z.string().optional(),
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
    "cross_space",
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
  operationId: "previewConnectionEvent",
  method: "post",
  path: "/preview-event",
  tags: ["Connections"],
  summary: "Preview event dispatch envelopes",
  description:
    "Renders the dispatch envelopes the reactive-run bridge would emit for a synthetic item-event, without dispatching anything. Returns one entry per subscribing connection in the caller's space, each flagged with whether it would dispatch and why not when skipped.",
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
        "One entry per subscriber the operator asked about, plus the space's hop budget.",
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
      description: "Malformed request body.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized.",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Caller is not a space admin or platform admin.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "item_not_found",
            "connection_not_found",
          ]),
        },
      },
      description:
        "`item_id` does not resolve in the caller's space scope, or the filtered `connection_id` does not exist.",
    },
  },
});

export interface ConnectionRoutesOptions {
  /**
   * Which integrations substrate this deployment runs, from
   * `AppConfig.integrationRuntime`. The uninstall pipeline needs the
   * declared value rather than an inference from whether the
   * runtime-control coordinates happen to be present, so a hosted
   * deployment that has lost a secret fails loudly instead of quietly
   * behaving like a self-host.
   */
  integrationRuntime: "hosted" | "local";
}

export function connectionRoutes(
  storage: Storage,
  salt: string,
  options: ConnectionRoutesOptions,
) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(installRoute, async (c) => {
    const apiKey = requireSpaceAdmin(c);
    const {
      integration_id,
      label,
      credential_ref: credentialRef,
      configuration,
    } = c.req.valid("json");
    const spaceId = apiKey.space_id ?? undefined;
    const clientIp = c.var.clientIp;

    // Manifests are platform-scoped (space_id IS NULL) — the widening
    // lets a space_admin caller look them up; the resulting connection
    // is stamped with the caller's space_id.
    const integration = await storage.items.get(integration_id, spaceId, {
      includePlatformScoped: true,
    });
    if (!integration) {
      throw new MarfaError(
        ErrorCode.INTEGRATION_NOT_FOUND,
        "Integration not found",
      );
    }
    if (integration.type !== "system.integration") {
      throw new MarfaError(
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
      spaceId,
      authMode: c.get("config").authMode,
      integrationItemId: integration.id,
      manifest: props.manifest,
      label: effectiveLabel,
      clientIp,
      ...(credentialRef !== undefined ? { credentialRef } : {}),
      ...(configuration !== undefined ? { configuration } : {}),
    });

    // Best-effort schedule arm — failures emit action_required activity; install stays successful.
    const controlPlaneUrl = process.env.MARFA_RUNTIME_CONTROL_URL;
    const runtimeBrokerKey = process.env.MARFA_RUNTIME_BROKER_KEY;
    if (controlPlaneUrl && runtimeBrokerKey) {
      await armScheduleForInstall(storage, {
        manifest: props.manifest as IntegrationManifest,
        connectionId: result.connection_id,
        spaceId,
        controlPlaneUrl,
        runtimeBrokerKey,
      });
    }

    // Publish a `created` event for the new connection so the reactive-run bridge's
    // cache-invalidation subscriber refreshes its in-memory subscription map.
    const connection = await storage.items.get(result.connection_id, spaceId);
    if (connection) {
      const metadata = await storage.metadata.get(connection.id);
      await publish({
        type: "created",
        item: connection,
        metadata,
        spaceId,
      });
    }

    return c.json(result, 201);
  });

  r.openapi(previewEventRoute, async (c) => {
    const apiKey = requireSpaceAdmin(c);
    const spaceId = apiKey.space_id ?? undefined;
    const body = c.req.valid("json");

    const item = await storage.items.get(body.item_id, spaceId);
    if (!item) {
      throw new MarfaError(
        ErrorCode.ITEM_NOT_FOUND,
        "Item not found in this space scope",
        { item_id: body.item_id },
      );
    }

    // spaceId is omitted for single-space self-hosts; the dispatch evaluator
    // normalizes both sides to null so the cross-space gate doesn't trip spuriously.
    const cycle = body.cycle ?? {};
    const event: ItemEventWithId = {
      type: body.event_type,
      item,
      ...(spaceId !== undefined && { spaceId }),
      originatingConnectionId: cycle.originating_connection_id ?? null,
      hopCount: cycle.hop_count ?? 0,
    };

    const hopBudgetMax = await resolveHopBudget(spaceId);
    const isIntegrationOriginated = event.originatingConnectionId != null;
    // Shares pubsub.computeEffectiveHopCount so the integration-at-hop-0-counts-as-1
    // floor can't drift from the live budget gate.
    const effectiveHopCount = computeEffectiveHopCount({
      originatingConnectionId: event.originatingConnectionId ?? null,
      hopCount: event.hopCount ?? 0,
    });
    const hopBudgetExceeded =
      isIntegrationOriginated && effectiveHopCount > hopBudgetMax;

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
      // Hop budget is event-wide — surface the reason per-row so the operator
      // sees why every subscriber is skipped, not just the first.
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
      const conn = await storage.items.get(body.connection_id, spaceId);
      if (!conn) {
        throw new MarfaError(
          ErrorCode.CONNECTION_NOT_FOUND,
          "Connection not found in this space scope",
          { connection_id: body.connection_id },
        );
      }
      const entry = await buildEntryForConnection(storage, {
        id: conn.id,
        state: conn.state,
        properties: conn.properties,
        space_id: conn.space_id ?? null,
      });
      considerSubscriber(conn.id, entry);
    } else {
      let cursor: string | undefined;
      const PAGE = 200;
      for (;;) {
        const page = await storage.items.list({
          ...(spaceId !== undefined && { spaceId }),
          type: "system.connection",
          limit: PAGE,
          ...(cursor !== undefined && { cursor }),
        });
        for (const conn of page.data) {
          const entry = await buildEntryForConnection(storage, {
            id: conn.id,
            state: conn.state,
            properties: conn.properties,
            space_id: conn.space_id ?? null,
          });
          if (!entry) continue; // skip non-subscribers in the unfiltered walk — noise; filtered case includes them
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

  // Pause and resume are the same mediated write with a different target.
  // One body serves both so they cannot drift the way the two direct
  // implementations did.
  const applyRuntimeState = async (
    verb: "pause" | "resume",
    connectionId: string,
    apiKey: { id: string; space_id?: string },
    clientIp: string | null,
  ) => {
    const controlPlaneUrl = process.env.MARFA_RUNTIME_CONTROL_URL;
    const runtimeBrokerKey = process.env.MARFA_RUNTIME_BROKER_KEY;
    const run = verb === "pause" ? performPause : performResume;
    try {
      return await run(storage, {
        apiKeyId: apiKey.id,
        spaceId: apiKey.space_id ?? undefined,
        connectionId,
        clientIp,
        integrationRuntime: options.integrationRuntime,
        ...(controlPlaneUrl !== undefined ? { controlPlaneUrl } : {}),
        ...(runtimeBrokerKey !== undefined ? { runtimeBrokerKey } : {}),
      });
    } catch (err) {
      if (err instanceof PauseError) {
        if (err.code === "connection_not_found") {
          throw new MarfaError(ErrorCode.CONNECTION_NOT_FOUND, err.message);
        }
        throw new MarfaError(ErrorCode.VALIDATION_ERROR, err.message, {
          pause_error_code: err.code,
        });
      }
      throw err;
    }
  };

  r.openapi(pauseRoute, async (c) => {
    const apiKey = requireSpaceAdmin(c);
    const { id } = c.req.valid("param");
    const result = await applyRuntimeState("pause", id, apiKey, c.var.clientIp);
    return c.json(result, 200);
  });

  r.openapi(resumeRoute, async (c) => {
    const apiKey = requireSpaceAdmin(c);
    const { id } = c.req.valid("param");
    const result = await applyRuntimeState(
      "resume",
      id,
      apiKey,
      c.var.clientIp,
    );
    return c.json(result, 200);
  });

  r.openapi(uninstallRoute, async (c) => {
    const apiKey = requireSpaceAdmin(c);
    const { id: connectionId } = c.req.valid("param");
    const spaceId = apiKey.space_id ?? undefined;
    const clientIp = c.var.clientIp;

    try {
      // Hosted-substrate coordinates for the schedule-disarm step. The
      // substrate itself comes from config, not from whether these are
      // set — see ConnectionRoutesOptions.
      const controlPlaneUrl = process.env.MARFA_RUNTIME_CONTROL_URL;
      const runtimeBrokerKey = process.env.MARFA_RUNTIME_BROKER_KEY;
      const result = await performUninstall(storage, {
        apiKeyId: apiKey.id,
        spaceId,
        connectionId,
        clientIp,
        integrationRuntime: options.integrationRuntime,
        ...(controlPlaneUrl !== undefined ? { controlPlaneUrl } : {}),
        ...(runtimeBrokerKey !== undefined ? { runtimeBrokerKey } : {}),
      });
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof UninstallError) {
        if (err.code === "connection_not_found") {
          throw new MarfaError(ErrorCode.CONNECTION_NOT_FOUND, err.message);
        }
        throw new MarfaError(ErrorCode.VALIDATION_ERROR, err.message, {
          uninstall_error_code: err.code,
        });
      }
      throw err;
    }
  });

  return r;
}
