import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { InstanceConfig } from "@withmarfa/shared";
import { MAX_RETENTION_DAYS, MAX_RETENTION_HOURS } from "../config.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  requirePermission,
  authorityId,
  standingPermission,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  readInstanceConfig,
  writeInstanceConfig,
} from "../storage/instance-config.js";
import { EnforcementReadSchema, EnforcementWriteSchema } from "./_schemas.js";

/**
 * One shape, built twice: permissive for reads and strict for the write.
 * `_schemas.ts` carries the two levers blocks, because a key's override is
 * the same shape and the two must not drift, and because building a second
 * from the factory would register a second schema under the component names
 * the first one took.
 */
const KEPT_FOREVER = "`0` keeps them with no age limit.";
const SERVER_DEFAULT = "Absent: the server's default applies.";

const instanceConfigShape = (strict: boolean) => ({
  enforcement: (strict ? EnforcementWriteSchema : EnforcementReadSchema)
    .optional()
    .describe(
      "The instance's enforcement levers. Each applies to every credential that doesn't set the same lever itself. Absent: no lever is on.",
    ),
  // Retention overrides for the cleanup jobs. Each falls back to the
  // instance's setting when unset, and `0` keeps everything, as the setting
  // does.
  audit_retention_days: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .optional()
    .describe(
      `Days Marfa keeps audit log entries and outbound webhook delivery history. ${KEPT_FOREVER} ${SERVER_DEFAULT}`,
    ),
  event_log_retention_hours: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_HOURS)
    .optional()
    .describe(
      `Hours Marfa keeps events, which a stream can replay from a cursor, and the answers it replays for an \`Idempotency-Key\`. ${KEPT_FOREVER} ${SERVER_DEFAULT}`,
    ),
  trash_retention_days: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .optional()
    .describe(
      `Days an item stays in the trash before Marfa purges it. ${KEPT_FOREVER} ${SERVER_DEFAULT}`,
    ),
  inbound_handled_retention_days: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .optional()
    .describe(
      `Days Marfa keeps inbound webhook deliveries a connector has marked handled. ${KEPT_FOREVER} ${SERVER_DEFAULT}`,
    ),
  inbound_pending_retention_days: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .optional()
    .describe(
      `Days Marfa keeps inbound webhook deliveries no connector has marked handled. ${KEPT_FOREVER} ${SERVER_DEFAULT}`,
    ),
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
const InstanceConfigSchema = z
  .object({
    instance_id: z
      .string()
      .describe(
        "Unique identifier for the instance, the same value `GET /` returns.",
      ),
    ...instanceConfigShape(false),
  })
  .describe(
    "The instance configuration: its enforcement levers and retention settings, with the instance's ID.",
  )
  .openapi("InstanceConfig");

/**
 * The write shape, which refuses a key it does not know, at every level.
 *
 * `PUT` is a full replacement, so stripping an unknown key is destructive
 * rather than merely useless: `{"trash_retention_day": 30}` is one missing
 * letter, and answering 200 to it would erase every override the instance
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
  instance_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "This instance's ID, accepted so you can send back what `GET /config` returned. It sets nothing.",
    ),
  ...instanceConfigShape(true),
});

/** Both configuration doors take `config.manage`. */
const managesConfig = standingPermission("config.manage");

const CONFIG_MANAGE_REFUSAL =
  "- `forbidden`: you don't hold `config.manage`. `details.required_scope` names it.";

const getConfigRoute = createRoute({
  operationId: "getConfig",
  method: "get",
  path: "/",
  tags: ["Instance"],
  summary: "Get the configuration",
  description:
    "Returns the instance configuration: its enforcement levers and retention settings, with its `instance_id`. A setting nobody has set is left out. Requires `config.manage`.",
  security: [{ bearerAuth: [] }],
  middleware: managesConfig,
  responses: {
    200: {
      content: {
        "application/json": { schema: InstanceConfigSchema },
      },
      description: "Returns the configuration.",
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
      description: CONFIG_MANAGE_REFUSAL,
    },
  },
});

const putConfigRoute = createRoute({
  operationId: "replaceConfig",
  method: "put",
  path: "/",
  tags: ["Instance"],
  summary: "Replace the configuration",
  description:
    "Replaces the instance configuration with the body and returns it. A setting you leave out goes back to its default, so send the whole configuration with your change. Requires `config.manage`.",
  security: [{ bearerAuth: [] }],
  middleware: managesConfig,
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
      description: "Returns the configuration as stored.",
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
        "- `missing_required_field`: a lever lacks `types` or `sources`.\n- `validation_error`: the body names a setting Marfa doesn't know, a retention value is out of range, or `instance_id` names a different instance.",
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
      description: CONFIG_MANAGE_REFUSAL,
    },
  },
});

export function configRoutes(storage: Storage, instanceId: string) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getConfigRoute, async (c) => {
    requirePermission(c, "config.manage");
    const config = await readInstanceConfig(storage.settings);
    // The identity last, so a stored row carrying the key cannot shadow it.
    // `readInstanceConfig` parses without a runtime schema, so whatever is
    // in that row is spread verbatim — and a wrong identity served with a
    // 200 is the one answer this door must not give.
    return c.json({ ...(config ?? {}), instance_id: instanceId }, 200);
  });

  router.openapi(putConfigRoute, async (c) => {
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

    await runAuditedTransaction(
      storage,
      () => writeInstanceConfig(storage.settings, body),
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: authorityId(c),
        action: "config.update",
        resource_type: "config",
      },
    );

    // Echoed with the identity the read carries, so the two doors answer the
    // same shape and a client can send back what either one gave it.
    return c.json({ ...body, instance_id: instanceId }, 200);
  });

  return router;
}
