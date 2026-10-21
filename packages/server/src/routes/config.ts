import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { InstanceConfig } from "@withmarfa/shared";
import { InstanceNameSchema } from "../instance-name.js";
import { MAX_RETENTION_DAYS, MAX_RETENTION_HOURS } from "../config.js";
import type { AppConfig } from "../config.js";
import { validateEffectiveConfig } from "../effective-config.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  requirePermission,
  authorityId,
  standingPermission,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  mergeInstanceConfig,
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

const liveConfigShape = {
  version_recent_days: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .optional()
    .describe(
      "Days within which every version is kept. Zero makes this window empty. Absent: the environment default applies.",
    ),
  version_daily_snapshot_days: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .optional()
    .describe(
      "Days within which a daily version is kept. Must be at least `version_recent_days`. Absent: the environment default applies.",
    ),
  version_weekly_snapshot_days: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .optional()
    .describe(
      "Days within which a weekly version is kept. Must be at least `version_daily_snapshot_days`. Absent: the environment default applies.",
    ),
  version_max_versions: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "Maximum versions per item, after applying the time windows. Per-type policy overrides these instance defaults.",
    ),
  grant_inactivity_days: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .optional()
    .describe(
      "Disconnect apps unused for this many days. Zero disables retirement.",
    ),
  enrichment_enabled: z
    .boolean()
    .optional()
    .describe(
      "`true` if Marfa reads text and dimensions from files. An active extraction can finish after disabling. Absent: the environment default applies.",
    ),
  enrichment_ocr_enabled: z
    .boolean()
    .optional()
    .describe(
      "`true` if file reading includes image text. Enabling reconsiders previously skipped images. Absent: the environment default applies.",
    ),
  error_reporting_enabled: z
    .boolean()
    .optional()
    .describe(
      "`true` if error alerts and exception reports are sent. Enabling requires a configured receiver. Absent: the environment default applies.",
    ),
  heartbeat_enabled: z
    .boolean()
    .optional()
    .describe(
      "`true` if scheduled heartbeat requests are sent. Enabling requires a configured receiver. Absent: the environment default applies.",
    ),
};

const instanceConfigShape = (strict: boolean) => ({
  ...liveConfigShape,
  name: InstanceNameSchema.optional(),
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
    "The instance configuration: its display name, enforcement levers and live settings, with the instance's ID.",
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

const CLEARS = " `null` removes it, so the server's default applies.";

const clearableDays = (what: string) =>
  z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_DAYS)
    .nullable()
    .optional()
    .describe(`${what} ${KEPT_FOREVER}${CLEARS}`);

/**
 * The patch shape: the write shape with each setting clearable by `null`.
 * Strict for the reason `PUT` is: a key one letter wrong would otherwise be
 * dropped while the answer says the change was made.
 */
const InstanceConfigPatchSchema = z.strictObject({
  ...(Object.fromEntries(
    Object.entries(liveConfigShape).map(([name, schema]) => [
      name,
      schema
        .nullable()
        .optional()
        .describe(`${schema.description ?? ""}${CLEARS}`),
    ]),
  ) as {
    [K in keyof typeof liveConfigShape]: z.ZodOptional<
      z.ZodNullable<(typeof liveConfigShape)[K]>
    >;
  }),
  instance_id: InstanceConfigWriteSchema.shape.instance_id,
  name: InstanceNameSchema.nullable()
    .optional()
    .describe(`The instance's display name.${CLEARS}`),
  enforcement: EnforcementWriteSchema.nullable()
    .optional()
    .describe(
      "The instance's enforcement levers. Sending this replaces all three levers, so include every lever you want on. `null` removes them all.",
    ),
  audit_retention_days: clearableDays(
    "Days Marfa keeps audit log entries and outbound webhook delivery history.",
  ),
  event_log_retention_hours: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETENTION_HOURS)
    .nullable()
    .optional()
    .describe(
      `Hours Marfa keeps events, which a stream can replay from a cursor, and the answers it replays for an \`Idempotency-Key\`. ${KEPT_FOREVER}${CLEARS}`,
    ),
  trash_retention_days: clearableDays(
    "Days an item stays in the trash before Marfa purges it.",
  ),
  inbound_handled_retention_days: clearableDays(
    "Days Marfa keeps inbound webhook deliveries a connector has marked handled.",
  ),
  inbound_pending_retention_days: clearableDays(
    "Days Marfa keeps inbound webhook deliveries no connector has marked handled.",
  ),
});

/** Every configuration door takes `config.manage`. */
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
    "Returns the instance configuration: its display name, enforcement levers and live settings, with its `instance_id`. A setting nobody has set is left out. Requires `config.manage`.",
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
    "Replaces the instance configuration with the body and returns it. A setting you leave out goes back to its default, so send the whole configuration with your change. To change only some settings, use `PATCH`. Requires `config.manage`.",
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
        "- `missing_required_field`: a lever lacks `types` or `sources`.\n- `validation_error`: the body names a setting Marfa doesn't know, a value is out of range, the effective version windows are out of order, reporting is enabled without a configured receiver, the name is invalid, or `instance_id` names a different instance.",
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

const patchConfigRoute = createRoute({
  operationId: "updateConfig",
  method: "patch",
  path: "/",
  tags: ["Instance"],
  summary: "Update the configuration",
  description:
    "Changes only the settings the body names and returns the whole configuration. A setting you leave out stays as it is, and `null` removes one so its default applies. `enforcement` is one setting: send every lever you want on. Requires `config.manage`.",
  security: [{ bearerAuth: [] }],
  middleware: managesConfig,
  request: {
    body: {
      content: {
        "application/json": { schema: InstanceConfigPatchSchema },
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
        "- `missing_required_field`: a lever lacks `types` or `sources`.\n- `validation_error`: the body names a setting Marfa doesn't know, a value is out of range, the effective version windows are out of order, reporting is enabled without a configured receiver, the name is invalid, or `instance_id` names a different instance.",
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

export function configRoutes(
  storage: Storage,
  instanceId: string,
  config: AppConfig,
) {
  const router = createOpenAPIRouter<AppEnv>();

  function refuseOtherInstance(addressed: string | undefined): void {
    if (addressed === undefined || addressed === instanceId) return;
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
    refuseOtherInstance(addressed);
    // No cast. What is left after the identity is removed and
    // `InstanceConfig` are the same type, because the schema declares every
    // field the interface does — a cast between them would hide a field this
    // route cannot set.
    const body: InstanceConfig = rest;

    await runAuditedTransaction(
      storage,
      () => {
        validateEffectiveConfig(config, body);
        return writeInstanceConfig(storage.settings, body);
      },
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

  router.openapi(patchConfigRoute, async (c) => {
    requirePermission(c, "config.manage");
    const { instance_id: addressed, ...changes } = c.req.valid("json");
    refuseOtherInstance(addressed);

    // Read and written in one transaction, so a second caller's change
    // between the two cannot be written over.
    const stored = await runAuditedTransaction(
      storage,
      async () => {
        const merged = mergeInstanceConfig(
          await readInstanceConfig(storage.settings),
          changes,
        );
        validateEffectiveConfig(config, merged, changes);
        await writeInstanceConfig(storage.settings, merged);
        return merged;
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: authorityId(c),
        action: "config.update",
        resource_type: "config",
      },
    );
    return c.json({ ...stored, instance_id: instanceId }, 200);
  });

  return router;
}
