/**
 * `/admin/*` operator surface. Every route in this file is platform-
 * admin only (`requireAdmin` enforces). The CLI's `my platform` command
 * tree is the canonical consumer; the routes are also reachable directly
 * via the SDK's `client.admin` namespace.
 *
 * Routes:
 *
 *   - POST   /admin/spaces                       — create a space
 *   - GET    /admin/spaces                       — list all spaces
 *   - GET    /admin/spaces/:id                   — full row + quotas + recent activity
 *   - POST   /admin/spaces/:id/suspend           — flip status to 'suspended'
 *   - POST   /admin/spaces/:id/unsuspend         — flip status to 'active'
 *   - GET    /admin/spaces/:id/metrics           — usage snapshot
 *   - GET    /admin/spaces/:id/keys              — a space's API keys
 *   - POST   /admin/spaces/:id/keys              — mint a key bound to that space
 *   - POST   /admin/account-deletion/purge-now    — force a one-shot pending-delete sweep
 *
 * Quotas READ/WRITE for a specific space reuses the existing
 * `/spaces/:id/quotas` GET + PUT (already platform-admin-gated). No
 * `/admin/spaces/:id/quotas` shim is added — the CLI hits the existing
 * route directly.
 *
 * Suspend / unsuspend each emit a `space.suspend` / `space.unsuspend`
 * audit row with the actor key id, target space id, and timestamp.
 * `account-deletion/purge-now` emits an `admin.account_deletion.purge_now`
 * audit row with `space_id: null` (instance-wide sweep). Suspended
 * spaces reject writes at the auth middleware layer
 * (`middleware/space-suspension.ts`); platform admins bypass.
 */
import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { ApiKey } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { hashApiKey, requireAdmin } from "../middleware/auth.js";
import { assertUnreservedSource } from "./keys.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { evictSpaceStatus } from "../middleware/space-suspension.js";
import { PendingDeletePurger } from "../storage/retention.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SpaceSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  created_at: z.string(),
  status: z.enum(["active", "suspended"]),
});

const AdminSpaceSchema = SpaceSchema.extend({
  owner_email: z.string().nullable(),
  owner_email_verified: z.boolean().nullable(),
  // The id `POST /admin/accounts/{id}/delete` takes. Without it that route was
  // unusable through the API: it is keyed on the account's auth user id, no
  // route returned one, and the space delete route's own refusal names it as
  // the way forward. An operator following that instruction reached a route
  // whose required input the platform would not give them, and the only way
  // through was a hand-written query against the database — an irreversible
  // action driven by a lookup with no audit trail of its own.
  owner_auth_user_id: z.string().nullable(),
});

const QuotaSchema = z.object({
  space_id: z.string(),
  items_limit: z.number().int().nullable(),
  webhooks_limit: z.number().int().nullable(),
  blobs_limit: z.number().int().nullable(),
  storage_bytes_limit: z.number().int().nullable(),
  rate_per_minute_limit: z.number().int().nullable(),
  updated_at: z.string().nullable(),
});

const ActivityEntrySchema = z.object({
  id: z.string(),
  severity: z.string(),
  summary: z.string(),
  created_at: z.string(),
});

const SpaceShowSchema = z.object({
  space: AdminSpaceSchema,
  quotas: QuotaSchema.nullable(),
  recent_activity: z.array(ActivityEntrySchema),
});

const SpaceMetricsSchema = z.object({
  space_id: z.string(),
  items: z.object({
    total: z.number(),
    active: z.number(),
    archived: z.number(),
    trashed: z.number(),
  }),
  blobs: z.object({
    count: z.number(),
    total_size: z.number(),
  }),
  recent_activity: z.array(ActivityEntrySchema),
  generated_at: z.string(),
});

const ApiKeySummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.string(),
  role: z.string(),
  is_platform: z.boolean(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

const KeyResponseSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  source: z.string(),
  role: z.enum(["admin", "space_admin", "member"]),
  default_tier: z.enum(["library", "feed"]),
  is_platform: z.boolean(),
  type_permissions: z.record(z.string(), z.enum(["read", "write", "none"])),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: z.record(z.string(), z.enum(["read", "write"])).optional(),
  metadata_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

const CreateSpaceKeyBodySchema = z.object({
  label: z.string().min(1, "label is required"),
  source: z.string().min(1, "source display name is required").max(200),
  role: z.enum(["admin", "space_admin", "member"]).optional(),
  default_tier: z.enum(["library", "feed"]).optional(),
  type_permissions: z
    .record(z.string(), z.enum(["read", "write", "none"]))
    .optional(),
  extension_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
  edge_permissions: z.record(z.string(), z.enum(["read", "write"])).optional(),
  metadata_permissions: z
    .record(z.string(), z.enum(["read", "write"]))
    .optional(),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createSpaceRoute = createRoute({
  operationId: "adminCreateSpace",
  method: "post",
  path: "/spaces",
  tags: ["Admin"],
  summary: "Create a space",
  description:
    "Creates an empty space and returns it. Platform-admin only. Pair with `POST /admin/spaces/{id}/keys` to issue a credential scoped to it.\n\nEvery other operator verb on a space already existed, so before this a space could only come into being through a hosted sign-up. That left an operator unable to provision a space for someone, and left anything that needs a space-scoped credential — a conformance suite, a test harness, a self-hoster seeding an instance — with no supported path to one.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z
              .string()
              .min(1)
              .max(200)
              .optional()
              .describe(
                "Human-readable label. Optional; the space is identified by its id.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: SpaceSchema } },
      description: "Space created",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Invalid body",
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
      description: "Forbidden",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Instance is not multi-space",
    },
  },
});

const listSpacesRoute = createRoute({
  operationId: "adminListSpaces",
  method: "get",
  path: "/spaces",
  tags: ["Admin"],
  summary: "List spaces",
  description:
    "Lists every space in the instance with current operator status. Platform-admin only.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(AdminSpaceSchema) }),
        },
      },
      description: "Space list",
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
      description: "Forbidden",
    },
  },
});

const showSpaceRoute = createRoute({
  operationId: "adminGetSpace",
  method: "get",
  path: "/spaces/{id}",
  tags: ["Admin"],
  summary: "Show a space",
  description:
    "Returns the space row, its current quota overrides, and a slice of recent activity. Quota overrides are null when none are configured. Platform-admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Space id.") }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SpaceShowSchema } },
      description: "Space detail",
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
      description: "Forbidden",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Space not found",
    },
  },
});

const suspendSpaceRoute = createRoute({
  operationId: "adminSuspendSpace",
  method: "post",
  path: "/spaces/{id}/suspend",
  tags: ["Admin"],
  summary: "Suspend a space",
  description:
    "Suspends the space, after which its credentials are rejected on writes while reads still pass through. Idempotent; re-suspending is a no-op.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Space id to suspend.") }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SpaceSchema } },
      description: "Updated space row",
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
      description: "Forbidden",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Space not found",
    },
  },
});

const unsuspendSpaceRoute = createRoute({
  operationId: "adminUnsuspendSpace",
  method: "post",
  path: "/spaces/{id}/unsuspend",
  tags: ["Admin"],
  summary: "Unsuspend a space",
  description:
    "Reactivates a suspended space, restoring write access. Idempotent.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Space id to unsuspend.") }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SpaceSchema } },
      description: "Updated space row",
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
      description: "Forbidden",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Space not found",
    },
  },
});

const spaceMetricsRoute = createRoute({
  operationId: "adminGetSpaceMetrics",
  method: "get",
  path: "/spaces/{id}/metrics",
  tags: ["Admin"],
  summary: "Get space metrics",
  description:
    "Returns a per-space usage snapshot covering item, blob, and storage counts plus recent activity. Platform-admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Space id.") }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SpaceMetricsSchema } },
      description: "Metrics snapshot",
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
      description: "Forbidden",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Space not found",
    },
  },
});

const listSpaceKeysRoute = createRoute({
  operationId: "adminListSpaceKeys",
  method: "get",
  path: "/spaces/{id}/keys",
  tags: ["Admin"],
  summary: "List a space's API keys",
  description:
    "Lists active (non-revoked) API keys for a space, for emergency revocation paired with key deletion. Platform-admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Space id.") }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(ApiKeySummarySchema) }),
        },
      },
      description: "Key list",
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
      description: "Forbidden",
    },
  },
});

const createSpaceKeyRoute = createRoute({
  operationId: "adminCreateSpaceKey",
  method: "post",
  path: "/spaces/{id}/keys",
  tags: ["Admin"],
  summary: "Create a space-bound API key",
  description:
    "Creates an API key bound to the specified space. Platform-admin only. The plaintext key is returned only in this response.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("Space id.") }),
    body: {
      content: { "application/json": { schema: CreateSpaceKeyBodySchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: KeyResponseSchema } },
      description: "Space-bound API key created",
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
        "application/json": { schema: makeErrorResponseSchema(["forbidden"]) },
      },
      description: "Forbidden",
    },
    404: {
      content: {
        "application/json": { schema: makeErrorResponseSchema(["not_found"]) },
      },
      description: "Space not found",
    },
  },
});

const PurgeNowResponseSchema = z.object({
  purged_count: z.number().int().nonnegative(),
  run_at: z.string(),
});

const accountDeletionPurgeNowRoute = createRoute({
  operationId: "adminPurgePendingDeletions",
  method: "post",
  path: "/account-deletion/purge-now",
  tags: ["Admin"],
  summary: "Force a one-shot run of the pending-delete purger",
  description:
    "Runs the pending-deletion sweep immediately instead of waiting for the scheduled job, returning the count purged. Only sweeps accounts already past their grace window; it does not bypass that window.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: PurgeNowResponseSchema } },
      description: "Purge sweep completed; returns count + timestamp",
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
      description: "Forbidden",
    },
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const RECENT_ACTIVITY_LIMIT = 10;

interface ActivitySummary {
  id: string;
  severity: string;
  summary: string;
  created_at: string;
}

async function loadRecentActivity(
  storage: Storage,
  spaceId: string,
  limit: number = RECENT_ACTIVITY_LIMIT,
): Promise<ActivitySummary[]> {
  const page = await storage.items.list({
    spaceId,
    type: "system.activity",
    sort: "created_at",
    direction: "desc",
    limit,
  });
  return page.data.map((item) => {
    const props = item.properties;
    return {
      id: item.id,
      severity: typeof props.severity === "string" ? props.severity : "info",
      summary: typeof props.summary === "string" ? props.summary : "",
      created_at: item.created_at,
    };
  });
}

function apiKeySummary(key: ApiKey): z.infer<typeof ApiKeySummarySchema> {
  return {
    id: key.id,
    label: key.label,
    source: key.source,
    role: key.role,
    is_platform: key.is_platform,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
  };
}

/** Options threaded into `adminRoutes()` for routes that need
 *  config-derived knobs. `graceDays` is the same value the long-lived
 *  `PendingDeletePurger` singleton uses; the purge-now route constructs
 *  an ad-hoc purger with this value to keep the same eligibility math. */
export interface AdminRoutesOptions {
  graceDays: number;
  apiKeySalt: string;
}

const deleteSpaceRoute = createRoute({
  operationId: "adminDeleteSpace",
  method: "post",
  path: "/spaces/{id}/delete",
  tags: ["Admin"],
  summary: "Delete a space and everything it holds, immediately",
  description:
    "Hard-deletes a space that no account owns, along with its items, edges, blobs, keys, webhooks, connection tokens and quota. There is no grace window and no undo. A space that still has users is refused: that case belongs to `POST /accounts/{id}/delete`, which owns the account teardown as well. The body's `confirm` must be the space id, spelled exactly; the mismatch refusal is the fat-finger gate on an action with no undo.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.string().describe("The space id.") }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            confirm: z
              .string()
              .min(1)
              .describe(
                "The space id, exactly. Refused otherwise. The id rather than the name because a space name is neither required nor unique.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ deleted: z.literal(true) }),
        },
      },
      description: "Space deleted",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "confirm did not match the space id",
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
      description: "Forbidden",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["not_found"]),
        },
      },
      description: "Space not found",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description: "The space still has users; delete the account instead",
    },
  },
});

const deleteAccountRoute = createRoute({
  operationId: "adminDeleteAccount",
  method: "post",
  path: "/accounts/{id}/delete",
  tags: ["Admin"],
  summary: "Delete an account and everything it owns, immediately",
  description:
    "Operator-initiated account deletion. Runs the same cascade the grace-window purger runs — space rows, credentials, sessions, grants, and the audit-trail redaction — but now, with no grace window. The body's `confirm` must be the account's email address, spelled exactly; the mismatch refusal is the fat-finger gate on an action with no undo.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("The account's auth user id."),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            confirm: z
              .string()
              .min(1)
              .describe(
                "The account's email address, exactly. Refused otherwise.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ deleted: z.literal(true) }),
        },
      },
      description: "The account and everything it owned are gone.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "`confirm` does not name this account's email address, or this deployment has no user accounts.",
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
      description: "Forbidden",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["conflict"]),
        },
      },
      description:
        "Another deletion of this account is in progress, or the account changed state mid-delete.",
    },
  },
});

export function adminRoutes(storage: Storage, opts: AdminRoutesOptions) {
  const router = createOpenAPIRouter<AppEnv>();

  async function withOwner(space: z.infer<typeof SpaceSchema>) {
    if (!storage.users) {
      return {
        ...space,
        owner_email: null,
        owner_email_verified: null,
        owner_auth_user_id: null,
      };
    }
    const user = await storage.users.getBySpaceId(space.id);
    const owner = user?.auth_user_id
      ? await storage.users.getAuthUserEmail(user.auth_user_id)
      : null;
    return {
      ...space,
      owner_email: owner?.email ?? null,
      owner_email_verified: owner?.email_verified ?? null,
      // Already in hand from the lookup above, and previously discarded.
      owner_auth_user_id: user?.auth_user_id ?? null,
    };
  }

  router.openapi(createSpaceRoute, async (c) => {
    requireAdmin(c);
    // A single-space deployment has no space store at all. `NOT_FOUND`
    // rather than a dedicated code, matching every sibling route here: the
    // resource does not exist on this instance.
    if (!storage.spaces) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Space store not available");
    }
    const body = c.req.valid("json");
    const space = await storage.spaces.create(body.name);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: space.id,
      key_id: c.get("apiKey")?.id,
      action: "admin.space.create",
      resource_type: "space",
      resource_id: space.id,
      details: { name: space.name },
    });
    return c.json(
      {
        id: space.id,
        name: space.name,
        created_at: space.created_at,
        status: space.status,
      },
      201,
    );
  });

  router.openapi(listSpacesRoute, async (c) => {
    requireAdmin(c);
    if (!storage.spaces) {
      return c.json({ data: [] }, 200);
    }
    const data = await Promise.all(
      (await storage.spaces.list()).map(withOwner),
    );
    return c.json({ data }, 200);
  });

  router.openapi(showSpaceRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    if (!storage.spaces) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Space store not available");
    }
    const space = await storage.spaces.get(id);
    if (!space) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Space ${id} not found`);
    }

    const [spaceWithOwner, quota] = await Promise.all([
      withOwner(space),
      storage.spaceQuotas.get(id),
    ]);
    const quotas = quota
      ? {
          space_id: id,
          items_limit: quota.items_limit ?? null,
          webhooks_limit: quota.webhooks_limit ?? null,
          blobs_limit: quota.blobs_limit ?? null,
          storage_bytes_limit: quota.storage_bytes_limit ?? null,
          rate_per_minute_limit: quota.rate_per_minute_limit ?? null,
          updated_at: quota.updated_at,
        }
      : null;

    const recent_activity = await loadRecentActivity(storage, id);
    return c.json({ space: spaceWithOwner, quotas, recent_activity }, 200);
  });

  router.openapi(suspendSpaceRoute, async (c) => {
    const actor = requireAdmin(c);
    const { id } = c.req.valid("param");
    if (!storage.spaces) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Space store not available");
    }
    const updated = await storage.spaces.suspend(id);
    if (!updated) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Space ${id} not found`);
    }
    // Drop the per-instance status cache so the next gated write reads
    // the fresh `suspended` value instead of waiting out the 5s TTL.
    evictSpaceStatus(id);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      // Stamp the target space so the suspended space's own audit
      // feed surfaces the event. (The actor is a platform admin and
      // space-less; using their space_id here would hide the row from
      // the target space's `GET /audit` scope.)
      space_id: id,
      key_id: actor.id,
      action: "space.suspend",
      resource_type: "space",
      resource_id: id,
    });
    return c.json(updated, 200);
  });

  router.openapi(unsuspendSpaceRoute, async (c) => {
    const actor = requireAdmin(c);
    const { id } = c.req.valid("param");
    if (!storage.spaces) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Space store not available");
    }
    const updated = await storage.spaces.unsuspend(id);
    if (!updated) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Space ${id} not found`);
    }
    evictSpaceStatus(id);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      // Stamp the target space so the suspended space's own audit
      // feed surfaces the event. (The actor is a platform admin and
      // space-less; using their space_id here would hide the row from
      // the target space's `GET /audit` scope.)
      space_id: id,
      key_id: actor.id,
      action: "space.unsuspend",
      resource_type: "space",
      resource_id: id,
    });
    return c.json(updated, 200);
  });

  router.openapi(spaceMetricsRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    if (!storage.spaces) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Space store not available");
    }
    const space = await storage.spaces.get(id);
    if (!space) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Space ${id} not found`);
    }

    // Custom type count is omitted — `TypeStore.countCustom` is
    // instance-wide with no space-scoped equivalent; surfacing it here
    // would imply a per-space breakdown that doesn't exist.
    const [itemStats, blobsCount, storageBytes, recent] = await Promise.all([
      storage.items.stats(id),
      storage.spaceQuotas.count(id, "blobs"),
      storage.spaceQuotas.count(id, "storage_bytes"),
      loadRecentActivity(storage, id),
    ]);
    const total = Object.values(itemStats).reduce((a, b) => a + b, 0);
    const active = itemStats.active ?? 0;
    const archived = itemStats.archived ?? 0;
    const trashed = itemStats.trashed ?? 0;

    return c.json(
      {
        space_id: id,
        items: { total, active, archived, trashed },
        blobs: { count: blobsCount, total_size: storageBytes },
        recent_activity: recent,
        generated_at: new Date().toISOString(),
      },
      200,
    );
  });

  router.openapi(listSpaceKeysRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    if (!storage.spaces) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Space store not available");
    }
    const space = await storage.spaces.get(id);
    if (!space) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Space ${id} not found`);
    }
    const keys = await storage.keys.listForSpace(id);
    return c.json({ data: keys.map(apiKeySummary) }, 200);
  });

  router.openapi(createSpaceKeyRoute, async (c) => {
    const actor = requireAdmin(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!storage.spaces) {
      throw new MarfaError(ErrorCode.NOT_FOUND, "Space store not available");
    }
    const space = await storage.spaces.get(id);
    if (!space) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Space ${id} not found`);
    }

    assertUnreservedSource(body.source);

    const rawKey = `marfa_k1_${randomBytes(32).toString("hex")}`;
    const stored = await storage.keys.create(
      {
        label: body.label.trim(),
        source: body.source.trim(),
        role: body.role ?? "member",
        default_tier: body.default_tier,
        // This route deliberately cannot create platform credentials. Its
        // purpose is issuing a credential whose authority is confined to id.
        is_platform: false,
        type_permissions: body.type_permissions ?? {},
        extension_permissions: body.extension_permissions,
        edge_permissions: body.edge_permissions,
        metadata_permissions: body.metadata_permissions,
      },
      hashApiKey(rawKey, opts.apiKeySalt),
      id,
    );

    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: id,
      key_id: actor.id,
      action: "key.create",
      resource_type: "key",
      resource_id: stored.id,
      details: { issued_by_platform_admin: true },
    });

    return c.json(
      {
        id: stored.id,
        key: rawKey,
        label: stored.label,
        source: stored.source,
        role: stored.role,
        default_tier: stored.default_tier,
        is_platform: stored.is_platform,
        type_permissions: stored.type_permissions,
        extension_permissions: stored.extension_permissions,
        edge_permissions: stored.edge_permissions,
        metadata_permissions: stored.metadata_permissions,
        created_at: stored.created_at,
        last_used_at: stored.last_used_at,
      },
      201,
    );
  });

  router.openapi(accountDeletionPurgeNowRoute, async (c) => {
    const actor = requireAdmin(c);
    // Construct an ad-hoc purger — the long-lived singleton in
    // `index.ts` carries its own timer + coordination lock; this
    // one-shot doesn't need either of those wired in (intervalMs is
    // unused by `runOnce()`). Coordination is still passed through so
    // the per-account inner lock prevents racing the cascade against
    // the periodic sweeper.
    const purger = new PendingDeletePurger(
      storage,
      opts.graceDays,
      0,
      undefined,
      storage.coordination,
    );
    const runAt = new Date().toISOString();
    const purgedCount = await purger.runOnce();
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      // Instance-wide sweep — no target space. NULL space_id keeps
      // the row out of any specific space's `GET /audit` scope; only
      // a platform-admin reading the raw audit_log surfaces it.
      space_id: null,
      key_id: actor.id,
      action: "admin.account_deletion.purge_now",
      resource_type: "system",
      resource_id: "account-deletion-purger",
      details: { purged_count: purgedCount, run_at: runAt },
    });
    return c.json({ purged_count: purgedCount, run_at: runAt }, 200);
  });

  router.openapi(deleteSpaceRoute, async (c) => {
    const actor = requireAdmin(c);
    const { id } = c.req.valid("param");
    const { confirm } = c.req.valid("json");

    // The account route confirms on the email, a second fact independent
    // of the path. A space has no such fact: `name` is optional and not
    // unique — staging currently holds four spaces named "Probe 453" and
    // several with no name at all — so confirming on it would refuse
    // legitimate deletes and accept the wrong space. The id typed twice
    // still catches the common error, which is a wrong value pasted into
    // a script.
    if (confirm !== id) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "confirm must be the space id, exactly",
      );
    }

    const outcome = await storage.deleteSpace(id);
    if (outcome === "not_found") {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Space ${id} not found`);
    }
    if (outcome === "has_users") {
      // Names the id the other route needs, rather than a placeholder. This
      // refusal is the documented way forward and used to point at a route
      // whose required input nothing served, so following it led to the
      // database. `GET /admin/spaces/{id}` now carries the same value.
      const owner = storage.users ? await storage.users.getBySpaceId(id) : null;
      throw new MarfaError(
        ErrorCode.CONFLICT,
        owner?.auth_user_id
          ? `Space ${id} still has users. Delete the account instead, with POST /admin/accounts/${owner.auth_user_id}/delete, which removes this space with it.`
          : `Space ${id} still has users, but no account could be resolved for it. That should not happen: it means a user row references this space and its auth user is missing.`,
      );
    }

    // Drop the per-instance status cache: a gated write holding a stale
    // `active` for a space that no longer exists would read as a puzzling
    // permission error rather than a missing space.
    evictSpaceStatus(id);

    // Awaited rather than fire-and-forget, matching the account delete:
    // an operator-initiated deletion should not answer before its own
    // trail is durable. The store swallows write failures internally, so
    // this cannot throw.
    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: null,
      key_id: actor.id,
      action: "space.hard_deleted",
      resource_type: "space",
      resource_id: id,
      details: {},
    });

    return c.json({ deleted: true as const }, 200);
  });

  router.openapi(deleteAccountRoute, async (c) => {
    const actor = requireAdmin(c);
    const { id } = c.req.valid("param");
    const { confirm } = c.req.valid("json");

    const lifecycle = storage.accountLifecycle;
    if (!lifecycle) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "This deployment has no user accounts to delete",
      );
    }
    // The confirm value resolves to an account, and that account must be
    // the one the path names — checking both directions is what makes a
    // pasted-wrong id and a pasted-wrong email each fail loudly.
    const byEmail = await lifecycle.getAccountLifecycleByEmail(confirm);
    if (byEmail?.auth_user_id !== id) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "confirm must be the account's email address, exactly",
      );
    }

    // The purger's own per-account lock, so an operator delete and a
    // grace-window purge of the same account serialize rather than racing.
    // Inside it: mark, then cascade with a cutoff just past the mark, so
    // the cascade's own FOR-UPDATE re-check ("pending and due") passes for
    // exactly this marking and still refuses if anything else moved the
    // account in between.
    const nowIso = new Date().toISOString();
    const cutoffIso = new Date(Date.parse(nowIso) + 1_000).toISOString();
    const outcome = await storage.coordination.withJobLock(
      `account-delete:${id}`,
      async () => {
        await lifecycle.markPendingDeletion(id, nowIso);
        return storage.deleteAccountCascade(id, cutoffIso);
      },
    );
    if (outcome === undefined) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        "Another deletion of this account is already in progress",
      );
    }
    if (!outcome) {
      throw new MarfaError(
        ErrorCode.CONFLICT,
        "The account changed state while the delete was running; nothing was deleted",
      );
    }

    // The cascade wrote its own in-transaction `auth.account.hard_deleted`
    // row, which survives the redaction sweep. This one records WHO: an
    // operator-initiated deletion is a different event from a grace-window
    // purge, and the operator's key id is the fact worth keeping. Awaited,
    // unlike the fire-and-forget auth rows: the store swallows write
    // failures internally, so this cannot throw, and an operator deletion
    // should not answer before its own trail is durable.
    await storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: null,
      key_id: actor.id,
      action: "admin.account.deleted",
      resource_type: "account",
      resource_id: id,
    });
    return c.json({ deleted: true as const }, 200);
  });

  return router;
}
