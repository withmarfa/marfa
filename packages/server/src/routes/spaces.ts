import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { SpaceConfig } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin, requireSpaceAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { QuotaSchema } from "./_schemas.js";

const TYPE_LIST = z.array(z.string());

/**
 * One shape, built twice: permissive for reads and strict for the write.
 *
 * `.strict()` does not recurse, so the outer object refusing an unknown key
 * while `enforcement` accepted one would leave the same silent drop a level
 * down, on the block where a dropped key means a rule nobody is enforcing.
 * Applying it at every level is the fix, and it has to be applied to the write
 * shape alone: sharing one strict `enforcement` between the two would make the
 * response strict inside and permissive outside, which is both inconsistent
 * and the wrong half to tighten.
 *
 * Taking the shape as a parameter rather than writing it out twice is what
 * stops the two drifting, which is the failure this whole change is about.
 */
const enforcementSchema = (strict: boolean) => {
  const obj = strict ? z.strictObject : z.object;
  const typesAndSources = { types: TYPE_LIST, sources: z.array(z.string()) };
  return obj({
    strict_mode: obj({ types: TYPE_LIST }).optional(),
    source_allowlist: obj(typesAndSources).optional(),
    source_filter: obj(typesAndSources).optional(),
  }).optional();
};

const spaceConfigShape = (strict: boolean) => ({
  enforcement: enforcementSchema(strict),
  // How many hops a single event may travel before the bus drops it as a
  // suspected cycle. `0` stops integration-originated events propagating at
  // all, which is the tightest the leash goes; human-originated writes are
  // never subject to it. Resolved per space on the publish path and at the
  // runtime's own boundary, so raising it takes effect for both.
  //
  // Capped, unlike the retention windows below, because the two fail
  // differently. A retention window set absurdly high keeps data longer; a hop
  // budget set absurdly high is the protection switched off, and the thing it
  // protects against is an integration spinning a feedback loop. The ceiling
  // is a backstop against "effectively unbounded" rather than a view on how
  // deep a pipeline may reasonably be: twenty times the default is already far
  // past any real chain.
  max_event_hop_budget: z.number().int().min(0).max(100).optional(),
  // Per-space retention overrides for the cleanup jobs. Each falls back
  // to the instance env default when unset. `0` disables the job for
  // that space (matches env-default semantics for `TRASH_RETENTION_DAYS=0`);
  // negatives are rejected.
  audit_retention_days: z.number().int().min(0).optional(),
  event_log_retention_hours: z.number().int().min(0).optional(),
  trash_retention_days: z.number().int().min(0).optional(),
  activity_retention_days: z.number().int().min(0).optional(),
});

/** The read shape, permissive at every level. */
const SpaceConfigSchema = z.object(spaceConfigShape(false));

/**
 * The write shape, which refuses a key it does not know, at every level.
 *
 * `PUT` is a full replacement, so stripping an unknown key is destructive
 * rather than merely useless: `{"activity_retention_day": 30}` is one missing
 * letter, and it used to answer 200 having erased every override the space
 * had. A caller cannot tell that from success.
 *
 * Read stays permissive, deliberately and all the way down. A client that
 * refuses to parse a field added after it shipped is the mirror-image failure,
 * and a response has never erased anything.
 */
const SpaceConfigWriteSchema = z.strictObject(spaceConfigShape(true));

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
    "Overwrites the space's config with the supplied object — full replacement, not a merge. An unknown key is refused rather than dropped, because a full replacement that ignores a typo erases every override the space had. Cleanup-job retention overrides must be non-negative, where `0` disables the corresponding job for this space. Admin or space_admin.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: SpaceConfigWriteSchema },
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
    // No cast. The validated shape and `SpaceConfig` are the same type now
    // that the schema declares every field the interface does, and the cast
    // that used to bridge them was hiding exactly the field this route could
    // not set.
    const body: SpaceConfig = c.req.valid("json");

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
