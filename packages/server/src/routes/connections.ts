import { createRoute, z } from "@hono/zod-openapi";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import type {
  PreviewEventEnvelope,
  PreviewEventResult,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireSpacePermission, requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  performPause,
  performResume,
  PauseError,
} from "../connections/pause-pipeline.js";
import type { PauseResult } from "../connections/pause-pipeline.js";
import {
  performUninstall,
  UninstallError,
} from "../connections/uninstall-pipeline.js";
import type { UninstallResult } from "../connections/uninstall-pipeline.js";
import {
  performUpgrade,
  previewUpgrade,
  UpgradeError,
} from "../connections/upgrade-pipeline.js";
import { resolveConnectionManifest } from "../connections/resolve-manifest.js";
import { listPendingConsent } from "../connections/auto-upgrade.js";
import type { LocalRuntime } from "../integrations/local-runtime/types.js";
import { performInstall } from "../connections/install-pipeline.js";
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
// Auth model: `requireAuth` plus `requireSpacePermission(c,
// "space.connections")` on every route. The permission decides who, and the
// caller's `space_id` decides where: storage lookups and writes are scoped by
// it, so a space-bound credential reaches only its own space's connections,
// while a space-less operator key reaches every
// one. A credential without the permission is rejected with 403.
// ---------------------------------------------------------------------------

/**
 * The connection id in the path, described per operation.
 *
 * One shared declaration used to carry one sentence onto all seven operations
 * in this file — "Id of the connection to uninstall" — so six of them published
 * a description true of a different route. The reference is generated, so
 * nobody reads that sentence beside the operation it lands on, and no shape
 * guard can judge prose: a description is the one part of a route definition
 * that is wrong silently.
 *
 * A function rather than seven hand-written objects, so the shape stays in one
 * place and only the sentence varies.
 */
function connectionIdParam(description: string) {
  return z.object({ id: z.string().describe(description) });
}

const InstallRequestSchema = z.object({
  /** id of the system.integration item (a manifest registered via
   *  `POST /integrations`). The install pipeline reads its manifest and
   *  binds the new connection's `integration_ref` to this id. */
  integration_id: z.string(),
  /** Optional id of an existing `system.credential` (kind `oauth_token`)
   *  to reference instead of provisioning a fresh provider credential.
   *  Lets multiple integrations of the same upstream (e.g.
   *  `google/calendar` + `google/tasks`) share one OAuth client config.
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
  activity_id: z.string(),
});

const installRoute = createRoute({
  operationId: "installConnection",
  method: "post",
  path: "/install",
  tags: ["Connections"],
  summary: "Install an integration",
  description:
    "Installs a connection from a registered integration manifest without the browser consent screen, for non-interactive operator and tooling use. Requires `space.connections`; runs the same compensating-write pipeline and audit trail as the HTML consent flow.",
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
        "Connection installed. Returns the new connection id and activity id.",
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
      description: "Caller does not hold `space.connections`.",
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

// Three kinds of credential, and the response distinguishes them. A
// reader who sees only the first two concludes the secret they handed
// Marfa is gone, because nothing on the wire said otherwise.
const UpstreamCredentialOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("already_gone"), credential_id: z.string() }),
  z.object({ status: z.literal("purged"), credential_id: z.string() }),
  z.object({
    status: z.literal("retained"),
    credential_id: z.string(),
    reason: z.literal("in_use_by_other_connections"),
    connection_ids: z.array(z.string()),
  }),
]);

const UninstallResultSchema = z.object({
  connection_id: z.string(),
  revoked_credential_ids: z.array(z.string()),
  oauth_tokens_deleted: z.boolean(),
  upstream_credential: UpstreamCredentialOutcomeSchema,
  leased_tokens_revoked: z.number().int().nonnegative(),
  inbound_webhooks_disabled: z.number().int().nonnegative(),
  activity_id: z.string(),
});

const PauseResultSchema = z.object({
  connection_id: z.string(),
  runtime_status: z.enum(["paused", "healthy"]),
  activity_id: z.string(),
});

const pauseResponses = {
  200: {
    content: { "application/json": { schema: PauseResultSchema } },
    description:
      "Runtime status updated. The scheduler, reactive fan-out, and inbound webhook receipt all gate on it; queued schedule and item-event work is discarded, and a queued webhook dispatch retries toward the dead-letter surface.",
  },
  400: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["validation_error"]),
      },
    },
    description:
      "Connection kind is not `integration`, is revoked, is already in the requested state, or (for resume) is not paused.",
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
    description: "Caller does not hold `space.connections`.",
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
    "Stops a connection without tearing it down: sets `runtime_status` to `paused` — the scheduler skips it, reactive fan-out drops it, and new inbound webhook deliveries are refused with a retryable 503 so the sender redelivers after resume. Queued schedule and item-event work is discarded without running; a queued webhook dispatch retries and dead-letters if the pause outlasts it. Credentials and the upstream OAuth grant are left intact, so `resume` restores everything without a fresh consent round trip. Pausing an already-paused connection returns 400.",
  security: [{ bearerAuth: [] }],
  request: { params: connectionIdParam("Id of the connection to pause.") },
  responses: pauseResponses,
});

const resumeRoute = createRoute({
  operationId: "resumeConnection",
  method: "post",
  path: "/{id}/resume",
  tags: ["Connections"],
  summary: "Resume a paused integration connection",
  description:
    "Reverses `pause`: sets `runtime_status` back to `healthy`, and the scheduler, reactive fan-out, and inbound webhook receipt all pick the connection up again with nothing to re-arm. Resuming a connection that is not paused returns 400, and a revoked connection cannot be resumed — that is what reinstalling is for.",
  security: [{ bearerAuth: [] }],
  request: {
    params: connectionIdParam("Id of the paused connection to resume."),
  },
  responses: pauseResponses,
});

const UpgradeGrantSchema = z.object({
  name: z.string(),
  from: z.enum(["read", "write"]).optional(),
  to: z.enum(["read", "write"]),
});

const UpgradePreviewSchema = z.object({
  connection_id: z.string(),
  current: z.object({
    manifest_name: z.string(),
    manifest_version: z.string(),
  }),
  candidate: z
    .object({ manifest_name: z.string(), manifest_version: z.string() })
    .nullable(),
  candidate_integration_ref: z.string().nullable(),
  delta: z
    .object({
      widens: z.boolean(),
      types: z.array(UpgradeGrantSchema),
      extensions: z.array(UpgradeGrantSchema),
      edges: z.array(UpgradeGrantSchema),
      oauth: z.array(
        z.object({
          name: z.string(),
          from: z.string().optional(),
          to: z.string(),
        }),
      ),
      tokens: z.array(z.object({ name: z.string(), to: z.string() })),
      configurationRequired: z.array(z.string()),
    })
    .nullable(),
  consent_lines: z.array(z.string()),
});

const upgradePreviewRoute = createRoute({
  operationId: "previewConnectionUpgrade",
  method: "get",
  path: "/{id}/upgrade",
  tags: ["Connections"],
  summary: "See what moving a connection to a newer manifest would change",
  description:
    "A connection resolves the manifest it was installed against, frozen on its catalog row, so a newer version of the same integration does not reach it until somebody moves it. This reports whether a newer version is registered and exactly what it would newly be allowed to do, computed as a permission diff rather than a version comparison. `consent_lines` is empty when the move takes no more than the connection already has.",
  security: [{ bearerAuth: [] }],
  request: {
    params: connectionIdParam(
      "Id of the connection whose upgrade is being previewed.",
    ),
  },
  responses: {
    200: {
      content: { "application/json": { schema: UpgradePreviewSchema } },
      description: "What an upgrade would change.",
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
        "The connection carries no integration reference, or the manifest it resolves no longer validates.",
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
      description: "Caller does not hold `space.connections`.",
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

const PendingConsentSchema = z.object({
  pending: z.array(
    z.object({
      connection_id: z.string(),
      manifest_name: z.string(),
      from_version: z.string(),
      to_version: z.string(),
      consent_lines: z.array(z.string()),
    }),
  ),
});

const pendingUpgradesRoute = createRoute({
  operationId: "listConnectionUpgradesPendingConsent",
  method: "get",
  path: "/upgrades/pending",
  tags: ["Connections"],
  summary: "List connections held back because moving them would grant more",
  description:
    "Connections whose newest registered manifest version reaches further than the one they were installed against. The automatic pass moves everything that takes the same or less and leaves these, so this is the list that needs a person. `consent_lines` says what each move would newly allow, in the same words the install consent screen uses. Approve one with `POST /connections/{id}/upgrade/approve`.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: PendingConsentSchema } },
      description: "Connections awaiting a decision.",
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
      description: "Caller does not hold `space.connections`.",
    },
  },
});

const ApproveUpgradeSchema = z.object({
  to_version: z
    .string()
    .min(1)
    .describe(
      "The version the caller was shown. The approval applies to that version and no other: a newer one registered since is refused rather than silently approved.",
    ),
});

const approveUpgradeRoute = createRoute({
  operationId: "approveConnectionUpgrade",
  method: "post",
  path: "/{id}/upgrade/approve",
  tags: ["Connections"],
  summary: "Approve a move that would grant a connection more than it has",
  description:
    "The decision `POST /connections/{id}/upgrade` refuses to make on its own. `to_version` names the version the caller was shown, and the move is refused with 409 if that is no longer the candidate, so an approval cannot carry over to a widening nobody read. Everything else about the move is identical to the ordinary upgrade, including keeping the cursor state and revoking runtime credentials.",
  security: [{ bearerAuth: [] }],
  request: {
    params: connectionIdParam(
      "Id of the connection whose upgrade is being approved.",
    ),
    body: {
      content: { "application/json": { schema: ApproveUpgradeSchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            connection_id: z.string(),
            from: z.object({
              manifest_name: z.string(),
              manifest_version: z.string(),
            }),
            to: z.object({
              manifest_name: z.string(),
              manifest_version: z.string(),
            }),
            integration_ref: z.string(),
            revoked_credential_ids: z.array(z.string()),
            activity_id: z.string(),
          }),
        },
      },
      description: "The connection now resolves the newer manifest.",
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
        "A malformed body, or a connection whose kind is not `integration`, is revoked, carries no integration reference, or whose settings do not satisfy the newer manifest. A connection found to be already current before the move starts answers 409; one that another caller moves first, while this one waits for the connection's lock, answers 400 because the approved version is no longer ahead of it.",
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
      description: "Caller does not hold `space.connections`.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["connection_not_found"]),
        },
      },
      description: "Connection not found.",
    },
    409: {
      content: {
        "application/json": { schema: makeErrorResponseSchema(["conflict"]) },
      },
      description:
        "The candidate version is not the one the caller approved, the connection is already on the newest version, the move no longer widens, or it would strand this connection's stored user mapping.",
    },
  },
});

const upgradeRoute = createRoute({
  operationId: "upgradeConnection",
  method: "post",
  path: "/{id}/upgrade",
  tags: ["Connections"],
  summary: "Move a connection to a newer version of its integration",
  description:
    "Re-binds the connection to a newer registered version of the same integration, keeping its cursor state, and revokes its runtime credentials so the next mint projects permissions from the manifest it now resolves. Refuses with 403 when the newer manifest would grant more than the connection was installed with, naming exactly what is new: that move needs approval through the install consent screen. Returns 400 when the connection already resolves the newest registered version, or when its stored settings do not satisfy the new manifest.",
  security: [{ bearerAuth: [] }],
  request: {
    params: connectionIdParam(
      "Id of the connection to move to a newer version.",
    ),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            connection_id: z.string(),
            from: z.object({
              manifest_name: z.string(),
              manifest_version: z.string(),
            }),
            to: z.object({
              manifest_name: z.string(),
              manifest_version: z.string(),
            }),
            integration_ref: z.string(),
            revoked_credential_ids: z.array(z.string()),
            activity_id: z.string(),
          }),
        },
      },
      description: "The connection now resolves the newer manifest.",
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
        "Connection kind is not `integration`, revoked, already current, carrying no integration reference, or its settings do not satisfy the newer manifest.",
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
      description:
        "Caller does not hold `space.connections`, or the newer manifest widens what the connection may do and needs consent.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["connection_not_found"]),
        },
      },
      description: "Connection not found.",
    },
    409: {
      content: {
        "application/json": { schema: makeErrorResponseSchema(["conflict"]) },
      },
      description:
        "The move would strand this connection's stored user mapping, because the newer version does not support mappings.",
    },
  },
});

const runRoute = createRoute({
  operationId: "runConnection",
  method: "post",
  path: "/{id}/run",
  tags: ["Connections"],
  summary: "Run a connection now",
  description:
    "Dispatches the connection's sweep immediately instead of waiting for its next scheduled tick. Only connections whose manifest declares the `manual` trigger may be run this way, and only where this deployment can actually dispatch the integration: a manifest declaring `runs_on: client` is refused, because its code runs on a machine Marfa does not have, and so is one this deployment does not install. A paused connection is refused. The run is queued the same way a cron tick is, so it takes the same per-connection lock and cannot overlap a run already in flight.",
  security: [{ bearerAuth: [] }],
  request: { params: connectionIdParam("Id of the connection to run now.") },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({
            connection_id: z.string(),
            integration_name: z.string(),
            queued: z.literal(true),
          }),
        },
      },
      description: "The run is queued.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "Connection kind is not `integration`, revoked, paused, the manifest declares `runs_on: client` or no `manual` trigger, or this deployment does not install it.",
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
      description: "Caller does not hold `space.connections`.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["connection_not_found"]),
        },
      },
      description: "Connection not found.",
    },
    503: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["local_runtime_not_available"]),
        },
      },
      description: "No integration runtime is available on this instance.",
    },
  },
});

const uninstallRoute = createRoute({
  operationId: "uninstallConnection",
  method: "post",
  path: "/{id}/uninstall",
  tags: ["Connections"],
  summary: "Uninstall an integration connection",
  description:
    "Tears down a connection in one pass: revokes its runtime credentials and leased tokens, drops the proxy's cached upstream OAuth tokens, disables inbound webhooks, transitions it to `revoked`, and removes the upstream credential it was installed with unless another live connection still shares it. `upstream_credential` in the response says which of those happened. Idempotent per artifact, but rejects with 400 when the connection itself is already revoked.",
  security: [{ bearerAuth: [] }],
  request: {
    params: connectionIdParam("Id of the connection to uninstall."),
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
      description: "Connection kind is not `integration`, or already revoked.",
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
      description: "Caller does not hold `space.connections`.",
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
    "system_type",
    "type_not_targeted",
    "hop_budget_exceeded",
    "subscription_inactive",
    "subscription_paused",
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
      description: "Caller does not hold `space.connections`.",
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

export function connectionRoutes(
  storage: Storage,
  localRuntime: LocalRuntime | null = null,
) {
  const r = createOpenAPIRouter<AppEnv>();

  r.openapi(installRoute, async (c) => {
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.connections");
    const {
      integration_id,
      credential_ref: credentialRef,
      configuration,
    } = c.req.valid("json");
    const spaceId = apiKey.space_id ?? undefined;
    const clientIp = c.var.clientIp;

    // Manifests are platform-scoped (space_id IS NULL) — the widening
    // lets a space-bound caller look them up; the resulting connection
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

    const result = await performInstall(storage, {
      apiKeyId: apiKey.id,
      spaceId,
      integrationItemId: integration.id,
      manifest: props.manifest,
      clientIp,
      ...(credentialRef !== undefined ? { credentialRef } : {}),
      ...(configuration !== undefined ? { configuration } : {}),
    });

    // Publish a `created` event for the new connection so the reactive bridge's
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
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.connections");
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

    // spaceId is omitted where the row carries no space; the dispatch evaluator
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
      runtimeStatus?: string,
    ): void => {
      if (!entryOrNull) {
        envelopes.push({
          connection_id: connectionId,
          integration_name: "",
          would_dispatch: false,
          // Pause is the one inactive cause an operator flips on purpose
          // and can flip back, so it earns its own reason — "why did
          // nothing fire" is exactly what this route exists to answer.
          dispatch_reason:
            runtimeStatus === "paused"
              ? "subscription_paused"
              : "subscription_inactive",
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
      considerSubscriber(
        conn.id,
        entry,
        (conn.properties as { runtime_status?: string }).runtime_status,
      );
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
    const run = verb === "pause" ? performPause : performResume;
    let result: PauseResult;
    try {
      result = await run(storage, {
        apiKeyId: apiKey.id,
        spaceId: apiKey.space_id ?? undefined,
        connectionId,
        clientIp,
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
    // Publish the status flip so the reactive bridge's invalidation
    // subscriber re-evaluates its cached subscription entry. The write
    // above is a plain storage update, which publishes nothing on its
    // own — without this event the elected drainer's in-memory map
    // keeps (or keeps missing) the connection until the next rebuild,
    // and pause reports success while fanout carries on. Outside the
    // try, deliberately: a publish failure here must not be mapped to a
    // pause error the write did not have.
    const spaceId = apiKey.space_id ?? undefined;
    const connection = await storage.items.get(connectionId, spaceId);
    if (connection) {
      const metadata = await storage.metadata.get(connection.id);
      await publish({ type: "updated", item: connection, metadata, spaceId });
    }
    return result;
  };

  r.openapi(pauseRoute, async (c) => {
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.connections");
    const { id } = c.req.valid("param");
    const result = await applyRuntimeState("pause", id, apiKey, c.var.clientIp);
    return c.json(result, 200);
  });

  r.openapi(resumeRoute, async (c) => {
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.connections");
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
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.connections");
    const { id: connectionId } = c.req.valid("param");
    const spaceId = apiKey.space_id ?? undefined;
    const clientIp = c.var.clientIp;

    let uninstalled: UninstallResult;
    try {
      const result = await performUninstall(storage, {
        apiKeyId: apiKey.id,
        spaceId,
        connectionId,
        clientIp,
      });
      uninstalled = result;
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
    // Same invalidation contract as pause/resume above: the pipeline's
    // transition is a storage write, so the bridge only drops the
    // revoked connection's subscription entry if the route says so.
    const revoked = await storage.items.get(connectionId, spaceId);
    if (revoked) {
      const metadata = await storage.metadata.get(revoked.id);
      await publish({
        type: "state_changed",
        item: revoked,
        metadata,
        spaceId,
      });
    }
    return c.json(uninstalled, 200);
  });

  r.openapi(runRoute, async (c) => {
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.connections");
    const { id } = c.req.valid("param");
    const spaceId = apiKey.space_id ?? undefined;

    if (!localRuntime) {
      throw new MarfaError(
        ErrorCode.LOCAL_RUNTIME_NOT_AVAILABLE,
        "This instance has no integration runtime, so there is nothing to run.",
      );
    }

    const connection = await storage.items.get(id, spaceId);
    if (connection?.type !== "system.connection") {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Connection ${id} not found`);
    }
    const props = connection.properties as {
      kind?: string;
      runtime_status?: string;
    };
    if (props.kind !== "integration") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Connection ${id} has kind "${props.kind ?? "<missing>"}"; only integration connections run`,
      );
    }
    if (connection.state === "revoked") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Connection ${id} is revoked; there is nothing to run`,
      );
    }
    // Pause means stopped. Queueing a run against a paused connection
    // would be discarded at dispatch, so refusing here says so instead of
    // accepting work that silently evaporates.
    if (props.runtime_status === "paused") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `Connection ${id} is paused; resume it before running it`,
      );
    }

    const resolved = await resolveConnectionManifest(storage, id, spaceId);

    // The first gate, and it is a declaration rather than an inference.
    // A client-run integration's code runs on a machine this deployment
    // does not have, so there is nothing here to dispatch — and asking
    // the manifest is what makes that answer true of every client rather
    // than of whichever one this build happens to ship. It sits ahead of
    // the trigger check because "no trigger declared" would otherwise be
    // the reported reason, which is a consequence of running elsewhere
    // rather than the reason for the refusal.
    if (resolved.manifest.runs_on === "client") {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${resolved.manifest.name} declares runs_on "client", so its code runs on your own machine and the program that owns it starts the run. Marfa has nothing to dispatch.`,
      );
    }

    const declaresManual = (resolved.manifest.triggers ?? []).some(
      (trigger) => trigger.type === "manual",
    );
    if (!declaresManual) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${resolved.manifest.name} does not accept manual runs: its manifest declares no "manual" trigger.`,
      );
    }

    // The last gate, and the one that stops a silent no-op. A server-run
    // integration this deployment does not carry cannot be dispatched
    // here at all: the supervisor acks an envelope naming an unknown
    // integration and skips it, so accepting the request would report a
    // queued run that never happens. This is now only about what the
    // image installs — where the code runs is settled above, by the
    // manifest, rather than being read off a registration miss.
    const registration = localRuntime.getRegistration(resolved.manifest.name);
    if (!registration) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `${resolved.manifest.name} runs on a Marfa deployment, but this one does not install it, so there is nothing here to run.`,
      );
    }
    if (!registration.triggerKinds.has("manual")) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `The build of ${resolved.manifest.name} running here does not accept manual runs. The connection's manifest and the running code disagree; upgrading the connection resolves it.`,
      );
    }

    await localRuntime.enqueue({
      integration_name: resolved.manifest.name,
      message: {
        kind: "manual",
        integration_name: resolved.manifest.name,
        connection_id: id,
        ...(spaceId !== undefined ? { space_id: spaceId } : {}),
        requested_at_ms: Date.now(),
      },
    });

    await storage.audit.log({
      client_ip: c.var.clientIp ?? null,
      space_id: spaceId ?? null,
      key_id: apiKey.id,
      action: "integration.run",
      resource_type: "item",
      resource_id: id,
      details: { integration_name: resolved.manifest.name },
    });

    return c.json(
      {
        connection_id: id,
        integration_name: resolved.manifest.name,
        queued: true as const,
      },
      202,
    );
  });

  r.openapi(upgradePreviewRoute, async (c) => {
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.connections");
    const { id } = c.req.valid("param");
    try {
      const preview = await previewUpgrade(storage, {
        spaceId: apiKey.space_id ?? undefined,
        connectionId: id,
      });
      return c.json(preview, 200);
    } catch (err) {
      throw mapUpgradeError(err);
    }
  });

  // `/upgrades/pending` cannot be read as a connection id: the only route
  // it could shadow is `GET /{id}/upgrade`, and their second segments
  // differ. Registration order does not enter into it, which is worth
  // saying because it looks like it should.
  r.openapi(pendingUpgradesRoute, async (c) => {
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.connections");
    const pending = await listPendingConsent(
      storage,
      apiKey.space_id ?? undefined,
    );
    return c.json({ pending }, 200);
  });

  r.openapi(approveUpgradeRoute, async (c) => {
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.connections");
    const { id } = c.req.valid("param");
    const { to_version } = c.req.valid("json");
    const spaceId = apiKey.space_id ?? undefined;

    // Approve what was read, not whatever is newest now. Between the list
    // and this call a further version can register, and carrying the
    // approval onto it would grant something nobody was shown: the whole
    // point of the gate.
    let preview;
    try {
      preview = await previewUpgrade(storage, {
        spaceId,
        connectionId: id,
      });
    } catch (err) {
      throw mapUpgradeError(err);
    }
    if (preview.candidate === null) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Connection ${id} already resolves the newest registered version of ${preview.current.manifest_name}`,
      );
    }
    // `previewUpgrade` sets the candidate and its row together, so this is
    // not reachable. Refusing rather than falling back to an unpinned call
    // is the point: the fallback for "I could not pin" has to be no move,
    // not a move onto whatever is newest with consent attached.
    const candidateRef = preview.candidate_integration_ref;
    if (candidateRef === null) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `The candidate version for connection ${id} could not be resolved to a catalog entry, so there is nothing to approve.`,
      );
    }
    if (preview.candidate.manifest_version !== to_version) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `The candidate is now ${preview.candidate.manifest_version}, not the ${to_version} this approval names. Read what it would newly allow and approve that version instead.`,
        {
          approved_version: to_version,
          candidate_version: preview.candidate.manifest_version,
        },
      );
    }
    if (preview.delta?.widens !== true) {
      // Nothing to approve. Refusing rather than quietly upgrading keeps
      // this route's meaning single: it is the one that carries consent,
      // and a move needing none belongs on the ordinary upgrade route
      // where the automatic pass will take it anyway.
      throw new MarfaError(
        ErrorCode.CONFLICT,
        `Moving ${preview.current.manifest_name} to ${to_version} grants no more than this connection already has, so it needs no approval. Use POST /connections/${id}/upgrade.`,
      );
    }

    let result;
    try {
      result = await performUpgrade(storage, {
        apiKeyId: apiKey.id,
        spaceId,
        connectionId: id,
        clientIp: c.var.clientIp,
        // The pinned row, not the newest. Checking the version above and
        // then letting the pipeline resolve the candidate again would
        // leave the whole race open: it re-previews inside a lock it may
        // wait on, so a version registered in between is what would
        // actually be applied, carrying a consent nobody gave it.
        targetIntegrationItemId: candidateRef,
        // The one place this is set. A person has seen the lines
        // above and named the version they apply to.
        consentedToWidening: true,
      });
    } catch (err) {
      throw mapUpgradeError(err);
    }
    const upgraded = await storage.items.get(id, spaceId);
    if (upgraded) {
      const metadata = await storage.metadata.get(upgraded.id);
      await publish({ type: "updated", item: upgraded, metadata, spaceId });
    }
    return c.json(result, 200);
  });

  r.openapi(upgradeRoute, async (c) => {
    const apiKey = requireAuth(c);
    requireSpacePermission(c, "space.connections");
    const { id } = c.req.valid("param");
    const spaceId = apiKey.space_id ?? undefined;
    let result;
    try {
      // `consentedToWidening` is deliberately not readable from the
      // request. A widening move is approved by a person on the consent
      // screen, and a caller that could set the flag on its own request
      // would be approving it for them.
      result = await performUpgrade(storage, {
        apiKeyId: apiKey.id,
        spaceId,
        connectionId: id,
        clientIp: c.var.clientIp,
      });
    } catch (err) {
      throw mapUpgradeError(err);
    }
    // Same invalidation contract as pause/resume: the pipeline's write is
    // a storage write, so the reactive bridge re-reads this connection's
    // subscription entry only if the route says so — and it must, because
    // the triggers it subscribes on may have just changed.
    const upgraded = await storage.items.get(id, spaceId);
    if (upgraded) {
      const metadata = await storage.metadata.get(upgraded.id);
      await publish({ type: "updated", item: upgraded, metadata, spaceId });
    }
    return c.json(result, 200);
  });

  return r;
}

/** Map the pipeline's typed failures onto the wire. `consent_required` is
 *  a 403 carrying the grant lines, so a caller is told what to approve
 *  rather than only that it was refused. */
function mapUpgradeError(err: unknown): unknown {
  if (!(err instanceof UpgradeError)) return err;
  if (err.code === "connection_not_found") {
    // `connection_not_found`, not the generic `not_found`: every other
    // route on this surface answers the specific code, and the three
    // upgrade routes declared it while emitting the generic one.
    return new MarfaError(ErrorCode.CONNECTION_NOT_FOUND, err.message);
  }
  if (err.code === "consent_required") {
    return new MarfaError(ErrorCode.FORBIDDEN, err.message, {
      upgrade_error_code: err.code,
      ...(err.detail ?? {}),
    });
  }
  if (err.code === "mapping_would_be_stranded") {
    // A conflict rather than a refusal to authorize: the caller is allowed
    // to do this, and the connection is in a state that has to change
    // first.
    return new MarfaError(ErrorCode.CONFLICT, err.message, {
      upgrade_error_code: err.code,
      ...(err.detail ?? {}),
    });
  }
  return new MarfaError(ErrorCode.VALIDATION_ERROR, err.message, {
    upgrade_error_code: err.code,
    ...(err.detail ?? {}),
  });
}
