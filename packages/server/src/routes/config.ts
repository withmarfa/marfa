import { createRoute, z } from "@hono/zod-openapi";
import type { InstanceConfig } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireSpacePermission, requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  readInstanceConfig,
  writeInstanceConfig,
} from "../storage/instance-config.js";
import { enforcementSchema } from "./_schemas.js";

/**
 * One shape, built twice: permissive for reads and strict for the write.
 * `enforcementSchema` in `_schemas.ts` carries the levers, because a key's
 * override is the same shape and the two must not drift.
 */
const instanceConfigShape = (strict: boolean) => ({
  enforcement: enforcementSchema(strict).optional(),
  // Retention overrides for the cleanup jobs. Each falls back to the
  // instance env default when unset. `0` disables the job (matches
  // env-default semantics for `TRASH_RETENTION_DAYS=0`); negatives are
  // rejected.
  audit_retention_days: z.number().int().min(0).optional(),
  event_log_retention_hours: z.number().int().min(0).optional(),
  trash_retention_days: z.number().int().min(0).optional(),
  activity_retention_days: z.number().int().min(0).optional(),
});

/** The read shape, permissive at every level. */
const InstanceConfigSchema = z.object(instanceConfigShape(false));

/**
 * The write shape, which refuses a key it does not know, at every level.
 *
 * `PUT` is a full replacement, so stripping an unknown key is destructive
 * rather than merely useless: `{"activity_retention_day": 30}` is one missing
 * letter, and it used to answer 200 having erased every override the instance
 * had. A caller cannot tell that from success.
 *
 * Read stays permissive, deliberately and all the way down. A client that
 * refuses to parse a field added after it shipped is the mirror-image failure,
 * and a response has never erased anything.
 */
const InstanceConfigWriteSchema = z.strictObject(instanceConfigShape(true));

const getConfigRoute = createRoute({
  operationId: "getConfig",
  method: "get",
  path: "/",
  tags: ["Config"],
  summary: "Get the instance configuration",
  description:
    "Returns the instance configuration — the optional `enforcement` levers plus the cleanup-job retention overrides. Returns an empty object when nothing is configured. Requires `config.manage`.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": { schema: InstanceConfigSchema },
      },
      description: "Instance config",
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
  operationId: "replaceConfig",
  method: "put",
  path: "/",
  tags: ["Config"],
  summary: "Replace the instance configuration",
  description:
    "Overwrites the instance config with the supplied object — full replacement, not a merge. An unknown key is refused rather than dropped, because a full replacement that ignores a typo erases every override the instance had. Cleanup-job retention overrides must be non-negative, where `0` disables the corresponding job. Requires `config.manage`.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: InstanceConfigWriteSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: InstanceConfigSchema },
      },
      description: "Instance config updated",
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

export function configRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getConfigRoute, async (c) => {
    requireAuth(c);
    requireSpacePermission(c, "config.manage");
    const config = await readInstanceConfig(storage.settings);
    return c.json(config ?? {}, 200);
  });

  router.openapi(putConfigRoute, async (c) => {
    const key = requireAuth(c);
    requireSpacePermission(c, "config.manage");
    // No cast. The validated shape and `InstanceConfig` are the same type,
    // because the schema declares every field the interface does — a cast
    // between them would hide a field this route cannot set.
    const body: InstanceConfig = c.req.valid("json");

    await writeInstanceConfig(storage.settings, body);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: key.id,
      action: "space.config.update",
      resource_type: "space",
      resource_id: "me",
    });

    return c.json(body, 200);
  });

  return router;
}
