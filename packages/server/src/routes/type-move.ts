import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorCode,
  MarfaError,
  generateId,
  getTypeSchema,
  isValidTypeIdentifier,
  malformedTypeIdentifier,
  resolveEnforcement,
} from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  checkTypeAccess,
  credentialHandle,
  requireAuth,
  standingRule,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { resolveLiveCredential } from "../auth/live-credential.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { notifyBulkJobEnqueued } from "../bulk-actions/enqueue-signal.js";
import { yieldBulkWork } from "../bulk-actions/yield.js";
import { sourceHiddenItemIds } from "../bulk-actions/source-visibility.js";
import {
  BulkActionJobSchema,
  TypeSettingSchema,
  type TypeMoveInput,
} from "../bulk-actions/types.js";
import {
  blockedSettings,
  planSettings,
  typeGrants,
} from "../type-move/settings.js";
import { isLockedPlatformType } from "./_schema-reach.js";
import { WrittenPropertiesSchema } from "./_schemas.js";
import { jobRowToEnvelope } from "./bulk.js";
import * as clock from "../clock.js";

/** The most items one move takes, as for a bulk action. */
const MAX_MOVE_ITEMS = 50_000;
const PAGE = 200;

export const TypeGrantSchema = z
  .object({
    kind: z
      .enum(["key", "app"])
      .describe("`key` for an API key, `app` for an app someone signed in to."),
    id: z.string().describe("The ID of the key, or the app's client ID."),
    label: z
      .string()
      .optional()
      .describe("The key's label. Absent for an app."),
  })
  .describe("A key or app whose type map names a type outright.")
  .openapi("TypeGrant");

const TypeMoveDryRunSchema = z
  .object({
    dry_run: z.literal(true).describe("Always `true`."),
    from: z.string().describe("The type the items are in now."),
    to: z.string().describe("The type the items would move to."),
    matched: z
      .number()
      .int()
      .describe(
        "How many items of `from` the move would take, in any state. Items your source filter hides aren't counted or moved.",
      ),
    ids: z.array(z.string()).describe("The IDs of those items."),
    settings: z
      .array(TypeSettingSchema)
      .describe(
        "Every folder, view and webhook setting that names `from`, which the move rewrites to name `to` once no item of `from` remains.",
      ),
    grants: z
      .array(TypeGrantSchema)
      .describe(
        "The keys and apps whose type map names `from`, which the move doesn't change. Keys are listed if you have `keys.manage`, and apps if you have `grants.manage`.",
      ),
  })
  .describe("What a type move would do, written nowhere.")
  .openapi("TypeMoveDryRun");

/**
 * Write on the type the path names, asked before the body is read. A platform
 * type is refused first, as its replacement and deletion are.
 */
const writesMovedType = standingRule("write on the type it moves", (c) => {
  const key = requireAuth(c);
  const from = c.req.param("id") ?? "";
  if (isLockedPlatformType(from)) throw coreTypeImmutable();
  checkTypeAccess(key, from, "write");
});

function coreTypeImmutable(): MarfaError {
  return new MarfaError(
    ErrorCode.CORE_TYPE_IMMUTABLE,
    "Items of a type Marfa ships stay in it",
  );
}

const moveTypeRoute = createRoute({
  operationId: "moveType",
  method: "post",
  path: "/{id}/move",
  tags: ["Types"],
  summary: "Move items to another type",
  description:
    "Moves every item of the type that you can see, in any state, to another type and queues a bulk-action job. Once no item of the type remains, it rewrites the folders, views and webhooks that name the type. With `dry_run: true` it returns what it would do.",
  security: [{ bearerAuth: [] }],
  middleware: writesMovedType,
  request: {
    params: z.object({
      id: z
        .string()
        .describe(
          "The identifier of the type to move items out of, such as `acme.deal`.",
        ),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.strictObject({
            to: z
              .string()
              .describe(
                "The identifier of the type to move items to, such as `acme.contract`. It must be registered.",
              ),
            properties: WrittenPropertiesSchema.optional().describe(
              "Properties to merge into every item as it moves, such as a field the new type requires. A `null` value removes a property.",
            ),
            dry_run: z
              .boolean()
              .optional()
              .describe(
                "`true` returns the items and settings the move would change and writes nothing. Defaults to `false`.",
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: TypeMoveDryRunSchema } },
      description: "With `dry_run: true`, returns what the move would do.",
    },
    202: {
      content: { "application/json": { schema: BulkActionJobSchema } },
      description:
        "Returns the queued job. Poll it with `GET /items/bulk-actions/jobs/{id}`. Its `result` lists the first 100 items it couldn't move in `errors`, counts the items of the type still left in `remaining` and `remaining_hidden`, and says in `settings_rewritten` whether it rewrote `settings`. Run the move again to move what remains.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "unknown_type",
            "bulk_cap_exceeded",
          ]),
        },
      },
      description:
        "- `validation_error`: `to` is malformed or names the type itself.\n- `unknown_type`: no type has the identifier `to`.\n- `bulk_cap_exceeded`: the type holds over 50,000 items.",
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
          schema: makeErrorResponseSchema([
            "core_type_immutable",
            "type_not_permitted",
          ]),
        },
      },
      description:
        "- `core_type_immutable`: Marfa ships the type, and its items stay in it.\n- `type_not_permitted`: your type map doesn't grant write on both types.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_found"]),
        },
      },
      description: "`type_not_found`: no type has this identifier.",
    },
    409: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_move_blocked"]),
        },
      },
      description:
        "`type_move_blocked`: a folder, view or webhook names the type in a way the move can't rewrite. `details.settings` lists each, with its `reason`. Change them, then move.",
    },
  },
});

export function typeMoveRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(moveTypeRoute, async (c) => {
    const key = requireAuth(c);
    const { id: from } = c.req.valid("param");
    const body = c.req.valid("json");
    const { to } = body;

    if (!getTypeSchema(from))
      throw new MarfaError(
        ErrorCode.TYPE_NOT_FOUND,
        `Type "${from}" not found`,
      );
    if (!isValidTypeIdentifier(to))
      throw malformedTypeIdentifier(
        "to",
        `"${to}" is not a type identifier, such as acme.contract`,
      );
    if (!getTypeSchema(to))
      throw new MarfaError(ErrorCode.UNKNOWN_TYPE, `Type "${to}" not found`, {
        type: to,
      });
    if (to === from)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "The items are already that type. Name another type in `to`.",
      );
    checkTypeAccess(key, to, "write");

    const credential = await resolveLiveCredential(storage, key.id, {
      tokenOutlivesExpiry: false,
    });
    if (credential === null)
      throw new MarfaError(ErrorCode.UNAUTHORIZED, "Unauthorized");

    const plan = await planSettings(storage, from, to, credential);
    const blocked = blockedSettings(plan);
    if (blocked.length > 0)
      throw new MarfaError(
        ErrorCode.TYPE_MOVE_BLOCKED,
        `${String(blocked.length)} ${blocked.length === 1 ? "setting names" : "settings name"} ${from} in a way the move can't rewrite. Change ${blocked.length === 1 ? "it" : "them"} first: ${blocked.map((setting) => setting.message).join(" ")}`,
        { settings: blocked },
      );

    // Items in any state, so a binned item moves and stays in the bin. A
    // subtype's items keep their own type.
    const sourceFilter = resolveEnforcement(
      await readInstanceConfig(storage.settings),
      key,
    ).source_filter;
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await storage.items.list({
        type: from,
        all_states: true,
        limit: PAGE,
        cursor,
      });
      const hidden = await sourceHiddenItemIds(
        storage,
        new Map(page.data.map((row) => [row.id, row])),
        sourceFilter,
      );
      for (const row of page.data)
        if (row.type === from && !hidden.has(row.id)) ids.push(row.id);
      if (ids.length > MAX_MOVE_ITEMS)
        throw new MarfaError(
          ErrorCode.BULK_CAP_EXCEEDED,
          `Type "${from}" holds more than ${String(MAX_MOVE_ITEMS)} items`,
          { matched: ids.length, cap: MAX_MOVE_ITEMS },
        );
      cursor = page.next_cursor ?? undefined;
      if (cursor !== undefined) await yieldBulkWork();
    } while (cursor !== undefined);

    if (body.dry_run === true) {
      const grants = await typeGrants(storage, c, from);
      return c.json(
        {
          dry_run: true as const,
          from,
          to,
          matched: ids.length,
          ids,
          settings: plan.settings,
          grants,
        },
        200,
      );
    }

    const input: TypeMoveInput = {
      action: "type_move",
      from,
      to,
      ...(body.properties !== undefined && { properties: body.properties }),
    };
    const job = await runAuditedTransaction(
      storage,
      () =>
        storage.bulkActionJobs.create({
          id: generateId(),
          api_key_id: key.id,
          credential: credentialHandle(c),
          action: input.action,
          input: JSON.stringify(input),
          matched_ids: JSON.stringify(ids),
          matched_count: ids.length,
          created_at: clock.now().toISOString(),
        }),
      (job) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: key.id,
        action: "type.move",
        resource_type: "type",
        resource_id: from,
        details: { to, matched: ids.length, job_id: job.id },
      }),
    );
    notifyBulkJobEnqueued();
    return c.json(jobRowToEnvelope(job), 202);
  });

  return router;
}
