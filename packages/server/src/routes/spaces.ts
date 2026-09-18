import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { ApiKey, SpaceConfig } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireSpacePermission, requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

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
    "Returns the calling space's configuration — the optional `enforcement` levers plus the per-space cleanup-job retention overrides. Returns an empty object when nothing is configured. Requires `space.settings`.",
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
    "Overwrites the space's config with the supplied object — full replacement, not a merge. An unknown key is refused rather than dropped, because a full replacement that ignores a typo erases every override the space had. Cleanup-job retention overrides must be non-negative, where `0` disables the corresponding job for this space. Requires `space.settings`.",
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

/**
 * The space the two `/spaces/me/config` doors act on: reading the config
 * and writing it.
 *
 * **A space permission implies a space.** The eleven are held on a
 * credential's row or on its grant; the operator key is the only shape that
 * can carry no space, and it holds none of them and cannot be given one, so
 * the `requireSpacePermission` on each of these doors has already turned away
 * every space-less caller before this is reached.
 *
 * It is one function so that neither carries a refusal no caller
 * can reach, which would read as a protection somebody is relying on.
 * Reaching the throw would mean the gate above had stopped working, which is
 * this file's mistake and not a caller's, so it stops rather than answering
 * as a bad request.
 */
function ownSpaceOfCaller(key: ApiKey): string {
  if (key.space_id === undefined) {
    throw new Error("a space permission admitted a credential with no space");
  }
  return key.space_id;
}

export function spaceRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  // `/me/config` addresses the caller's OWN space and reads nothing else,
  // so the space-bounded gate is the right one: `space.settings`, held by a
  // credential bound to the space whose config it is reading. Every storage
  // call below is keyed on `key.space_id`, which satisfies the widening rule
  // for a space-scoped callsite.
  router.openapi(getConfigRoute, async (c) => {
    const key = requireAuth(c);
    requireSpacePermission(c, "space.settings");
    // The space-less half of this guard went with its twin below: a
    // credential with no space holds none of the eleven, so the gate above
    // has already refused it. What is left is a deployment with no space
    // store, which reads as an unset config rather than as an error.
    if (!storage.spaces) {
      return c.json({}, 200);
    }
    const spaceId = ownSpaceOfCaller(key);
    const config = await storage.spaces.getConfig(spaceId);
    return c.json(config ?? {}, 200);
  });

  router.openapi(putConfigRoute, async (c) => {
    const key = requireAuth(c);
    requireSpacePermission(c, "space.settings");
    // No cast. The validated shape and `SpaceConfig` are the same type now
    // that the schema declares every field the interface does, and the cast
    // that used to bridge them was hiding exactly the field this route could
    // not set.
    const body: SpaceConfig = c.req.valid("json");

    if (!storage.spaces) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "This deployment holds no space configuration",
      );
    }

    const spaceId = ownSpaceOfCaller(key);

    await storage.spaces.updateConfig(spaceId, body);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      space_id: spaceId,
      key_id: key.id,
      action: "space.config.update",
      resource_type: "space",
      resource_id: spaceId,
    });

    return c.json(body, 200);
  });

  return router;
}
