import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { SpaceConfig } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin, requireSpaceAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

const EnforcementSchema = z
  .object({
    strict_mode: z.object({ types: z.array(z.string()) }).optional(),
    source_allowlist: z
      .object({
        types: z.array(z.string()),
        sources: z.array(z.string()),
      })
      .optional(),
    source_filter: z
      .object({
        types: z.array(z.string()),
        sources: z.array(z.string()),
      })
      .optional(),
  })
  .optional();

const SpaceConfigSchema = z.object({
  enforcement: EnforcementSchema,
  // Per-space retention overrides for the cleanup jobs. Each falls back
  // to the instance env default when unset. `0` disables the job for
  // that space (matches env-default semantics for `TRASH_RETENTION_DAYS=0`);
  // negatives are rejected.
  audit_retention_days: z.number().int().min(0).optional(),
  event_log_retention_hours: z.number().int().min(0).optional(),
  trash_retention_days: z.number().int().min(0).optional(),
});

const getConfigRoute = createRoute({
  operationId: "getSpaceConfig",
  method: "get",
  path: "/me/config",
  tags: ["Spaces"],
  summary: "Get the current space's configuration",
  description:
    "Returns the calling space's configuration — the optional `enforcement` levers plus the per-space cleanup-job retention overrides. Returns an empty object when nothing is configured. Admin or space_admin.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": { schema: SpaceConfigSchema },
      },
      description: "Space config",
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

const putConfigRoute = createRoute({
  operationId: "replaceSpaceConfig",
  method: "put",
  path: "/me/config",
  tags: ["Spaces"],
  summary: "Replace the current space's configuration",
  description:
    "Overwrites the space's config with the supplied object — full replacement, not a merge. Cleanup-job retention overrides must be non-negative, where `0` disables the corresponding job for this space. Admin or space_admin.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: SpaceConfigSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: SpaceConfigSchema },
      },
      description: "Space config updated",
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
          schema: makeErrorResponseSchema(["forbidden"]),
        },
      },
      description: "Forbidden",
    },
  },
});

// ---------------------------------------------------------------------------
// Space quotas
// ---------------------------------------------------------------------------

const QuotaSchema = z.object({
  space_id: z.string(),
  items_limit: z.number().int().nullable(),
  webhooks_limit: z.number().int().nullable(),
  blobs_limit: z.number().int().nullable(),
  storage_bytes_limit: z.number().int().nullable(),
  rate_per_minute_limit: z.number().int().nullable(),
  updated_at: z.string().nullable(),
});

const getQuotasRoute = createRoute({
  operationId: "getSpaceQuotas",
  method: "get",
  path: "/{id}/quotas",
  tags: ["Spaces"],
  summary: "Get space quotas",
  description:
    "Returns the per-space quota ceilings for a specific space. A `null` field means the env default applies, and an entirely-null payload means no per-space override is configured. Platform-admin only — space admins use `GET /spaces/me/quotas` to read their own ceilings without knowing their space id.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("ID of the space whose quotas to read"),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: QuotaSchema } },
      description:
        "Quota row. Null fields mean 'fall back to env defaults'. " +
        "An entirely-null payload means no per-space override is set.",
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

// `GET /spaces/me/quotas` resolves the calling key's space_id from
// `c.var.apiKey` so space_admins don't need to know their own space_id
// to read their ceilings. The explicit `/{space_id}/quotas` route is
// for platform admins.
const getOwnQuotasRoute = createRoute({
  operationId: "getOwnQuotas",
  method: "get",
  path: "/me/quotas",
  tags: ["Spaces"],
  summary: "Get current space quotas",
  description:
    "Returns the calling space's quota ceilings, resolved from the credential so the caller doesn't need to know its own space id. A platform-admin key with no space id receives `400` — use `GET /spaces/{id}/quotas` with an explicit id instead. Admin or space_admin.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: QuotaSchema } },
      description: "Quota row for the calling space.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description: "Caller has no space_id (platform admin).",
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

const putQuotasRoute = createRoute({
  operationId: "updateSpaceQuotas",
  method: "put",
  path: "/{id}/quotas",
  tags: ["Spaces"],
  summary: "Update space quotas",
  description:
    "Sets the per-space quota ceilings for a specific space. Each field is independent — a non-null value overrides the env default, while `null` resets that field to the env default. Platform-admin only.",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe("ID of the space whose quotas to set"),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items_limit: z.number().int().nullable().optional(),
            webhooks_limit: z.number().int().nullable().optional(),
            blobs_limit: z.number().int().nullable().optional(),
            storage_bytes_limit: z.number().int().nullable().optional(),
            rate_per_minute_limit: z.number().int().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: QuotaSchema } },
      description: "Quota row updated.",
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

export function spaceRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // `/me/config` addresses the caller's OWN space and reads nothing else,
  // so the space-bounded gate is the right one: the space admins that
  // hosted sign-up provisions are the intended operators of their own
  // space's config. Every storage call below is keyed on `key.space_id`,
  // which satisfies the widening rule for a space-scoped callsite.
  router.openapi(getConfigRoute, async (c) => {
    const key = requireSpaceAdmin(c);
    if (!key.space_id || !storage.spaces) {
      return c.json({}, 200);
    }
    const config = await storage.spaces.getConfig(key.space_id);
    return c.json(config ?? {}, 200);
  });

  router.openapi(putConfigRoute, async (c) => {
    const key = requireSpaceAdmin(c);
    const body = c.req.valid("json") as SpaceConfig;

    if (!key.space_id || !storage.spaces) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Space config requires a space-scoped credential",
      );
    }

    await storage.spaces.updateConfig(key.space_id, body);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: key.id,
      action: "space.config.update",
      resource_type: "space",
      resource_id: key.space_id,
    });

    return c.json(body, 200);
  });

  // **Route order matters.** `/me/quotas` is registered BEFORE `/{id}/quotas`
  // so a request to `GET /spaces/me/quotas` matches the space-admin handler
  // instead of the platform-admin handler with `id="me"`. Hono dispatches in
  // registration order; flipping these would 403 space_admin callers.
  router.openapi(getOwnQuotasRoute, async (c) => {
    const key = requireSpaceAdmin(c);
    const spaceId = key.space_id;
    if (!spaceId) {
      // Platform admin keys (no space_id) hit this — they should use
      // the explicit `/spaces/{id}/quotas` route instead.
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Caller has no space_id; use GET /spaces/{id}/quotas with an explicit space id.",
      );
    }
    const quota = await storage.spaceQuotas.get(spaceId);
    return c.json(
      {
        space_id: spaceId,
        items_limit: quota?.items_limit ?? null,
        webhooks_limit: quota?.webhooks_limit ?? null,
        blobs_limit: quota?.blobs_limit ?? null,
        storage_bytes_limit: quota?.storage_bytes_limit ?? null,
        rate_per_minute_limit: quota?.rate_per_minute_limit ?? null,
        updated_at: quota?.updated_at ?? null,
      },
      200,
    );
  });

  // Platform-admin only — reading another space's caps is cross-space authority.
  router.openapi(getQuotasRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    const result = await storage.spaceQuotas.getForExistingSpace(id);
    if (!result.exists) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Space ${id} not found`);
    }
    const quota = result.quota;
    return c.json(
      {
        space_id: id,
        items_limit: quota?.items_limit ?? null,
        webhooks_limit: quota?.webhooks_limit ?? null,
        blobs_limit: quota?.blobs_limit ?? null,
        storage_bytes_limit: quota?.storage_bytes_limit ?? null,
        rate_per_minute_limit: quota?.rate_per_minute_limit ?? null,
        updated_at: quota?.updated_at ?? null,
      },
      200,
    );
  });

  router.openapi(putQuotasRoute, async (c) => {
    const key = requireAdmin(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await storage.spaceQuotas.setForExistingSpace(id, body);
    if (!result) {
      throw new MarfaError(ErrorCode.NOT_FOUND, `Space ${id} not found`);
    }
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: c.get("apiKey")?.space_id ?? null,
      key_id: key.id,
      action: "space.quotas.update",
      resource_type: "space",
      resource_id: id,
      details: body,
    });
    return c.json(
      {
        space_id: id,
        items_limit: result.items_limit ?? null,
        webhooks_limit: result.webhooks_limit ?? null,
        blobs_limit: result.blobs_limit ?? null,
        storage_bytes_limit: result.storage_bytes_limit ?? null,
        rate_per_minute_limit: result.rate_per_minute_limit ?? null,
        updated_at: result.updated_at,
      },
      200,
    );
  });

  return router;
}
