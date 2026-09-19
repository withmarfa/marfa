import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { InstanceConfig } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requirePermission, requireAuth } from "../middleware/auth.js";
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

/**
 * The read shape, permissive at every level, with the instance's identity
 * beside the levers.
 *
 * `instance_id` is not configuration and nothing here sets it — it names the
 * deployment whose configuration this is, which is the fact an operator
 * holding two of them needs and cannot get from the levers. It is always
 * present, so it is required rather than optional: a caller that has to
 * handle its absence would be handling a state the door does not produce.
 */
const InstanceConfigSchema = z.object({
  instance_id: z.string(),
  ...instanceConfigShape(false),
});

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
const InstanceConfigWriteSchema = z.strictObject({
  // Accepted so that the natural use of a full-replacement door — read it,
  // change one lever, send it back — is not refused for carrying the field
  // the read just handed over. It sets nothing: the handler refuses a value
  // that is not this instance's own and never persists it either way.
  // Silently dropping it instead would make `PUT` answer `200` to a body
  // addressed to a different instance, which is the failure a backup script
  // pointed at the wrong host produces.
  instance_id: z.string().min(1).optional(),
  ...instanceConfigShape(true),
});

const getConfigRoute = createRoute({
  operationId: "getConfig",
  method: "get",
  path: "/",
  tags: ["Config"],
  summary: "Get the instance configuration",
  description:
    "Returns the instance configuration — the optional `enforcement` levers plus the cleanup-job retention overrides — under `instance_id`, the identifier this deployment answers to. Only `instance_id` is present when nothing is configured. Requires `config.manage`.",
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
    "Overwrites the instance config with the supplied object — full replacement, not a merge. An unknown key is refused rather than dropped, because a full replacement that ignores a typo erases every override the instance had. Cleanup-job retention overrides must be non-negative, where `0` disables the corresponding job. `instance_id` may be sent back as read, so a body taken from `GET /config` round trips; it sets nothing, and one naming a different instance answers `400 validation_error` rather than being ignored. Requires `config.manage`.",
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

export function configRoutes(storage: Storage, instanceId: string) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getConfigRoute, async (c) => {
    requireAuth(c);
    requirePermission(c, "config.manage");
    const config = await readInstanceConfig(storage.settings);
    // The identity last, so a stored row carrying the key cannot shadow it.
    // `readInstanceConfig` parses without a runtime schema, so whatever is
    // in that row is spread verbatim — and a wrong identity served with a
    // 200 is the one answer this door must not give.
    return c.json({ ...(config ?? {}), instance_id: instanceId }, 200);
  });

  router.openapi(putConfigRoute, async (c) => {
    const key = requireAuth(c);
    requirePermission(c, "config.manage");
    const { instance_id: addressed, ...rest } = c.req.valid("json");
    if (addressed !== undefined && addressed !== instanceId) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "instance_id names a different instance",
        {
          errors: [
            {
              path: "instance_id",
              message: `this instance is ${instanceId}`,
            },
          ],
        },
      );
    }
    // No cast. What is left after the identity is removed and
    // `InstanceConfig` are the same type, because the schema declares every
    // field the interface does — a cast between them would hide a field this
    // route cannot set.
    const body: InstanceConfig = rest;

    await writeInstanceConfig(storage.settings, body);
    void storage.audit.log({
      client_ip: c.get("clientIp") ?? null,
      key_id: key.id,
      action: "config.update",
      resource_type: "config",
    });

    // Echoed with the identity the read carries, so the two doors answer the
    // same shape and a client can send back what either one gave it.
    return c.json({ ...body, instance_id: instanceId }, 200);
  });

  return router;
}
