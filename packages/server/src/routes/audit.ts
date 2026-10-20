import { createRoute, z } from "@hono/zod-openapi";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  pageLimit,
  pageCursor,
} from "../page-limits.js";
import type { AppEnv } from "../middleware/auth.js";
import { requirePermission, standingPermission } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  AUDIT_KINDS,
  AUDIT_KIND_WORDS,
  AUDIT_SEARCH_MAX_LENGTH,
} from "../storage/audit-kinds.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { pageOf } from "./_schemas.js";

const AuditEntrySchema = z
  .object({
    id: z.string().describe("Unique identifier for the entry."),
    created_at: z.string().describe("When Marfa recorded the entry, in UTC."),
    key_id: z
      .string()
      .nullable()
      .describe(
        "The ID of the credential that acted, or `null` if the entry names none, as for Marfa's own housekeeping.",
      ),
    action: z
      .string()
      .describe("What happened, such as `key.create` or `owner.claimed`."),
    resource_type: z
      .string()
      .describe("The kind of resource acted on, such as `key`."),
    resource_id: z
      .string()
      .nullable()
      .describe("The ID of the resource acted on, or `null` if there is none."),
    client_ip: z
      .string()
      .nullable()
      .describe(
        "The IP address of the request that acted, or `null` if the entry records none.",
      ),
    details: z
      .record(z.string(), z.unknown())
      .describe("More about the action. What it holds depends on `action`."),
  })
  .describe("An audit log entry records one action and who took it.")
  .openapi("AuditEntry");

const listAuditRoute = createRoute({
  operationId: "listAuditLog",
  method: "get",
  path: "/",
  tags: ["Instance"],
  summary: "List audit log entries",
  description:
    "Returns audit log entries, newest first. Marfa records changes, sign-ins and exports here, not other reads. Requires `audit.read`.",
  security: [{ bearerAuth: [] }],
  middleware: standingPermission("audit.read"),
  request: {
    query: z.object({
      action: z
        .string()
        .optional()
        .describe(
          "Only return entries with this action, such as `key.create`.",
        ),
      resource_type: z
        .string()
        .optional()
        .describe(
          "Only return entries for this kind of resource, such as `key`.",
        ),
      resource_id: z
        .string()
        .optional()
        .describe("Only return entries for the resource with this ID."),
      kind: z
        .enum(AUDIT_KINDS)
        .optional()
        .describe(
          `Only return entries of this kind: \`access\` is ${AUDIT_KIND_WORDS.access}, \`data\` is ${AUDIT_KIND_WORDS.data}, \`settings\` is ${AUDIT_KIND_WORDS.settings}, and \`housekeeping\` is ${AUDIT_KIND_WORDS.housekeeping}.`,
        ),
      q: z
        .string()
        .max(AUDIT_SEARCH_MAX_LENGTH)
        .optional()
        .describe(
          "Only return entries that hold every word of this text, in any order and ignoring case, in their action, resource, key, address or details.",
        ),
      created_after: z
        .string()
        .optional()
        .describe("Only return entries recorded after this time."),
      created_before: z
        .string()
        .optional()
        .describe("Only return entries recorded before this time."),
      limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(AuditEntrySchema, "AuditEntryPage", {
            page: "One page of audit log entries.",
            data: "The entries, newest first.",
          }),
        },
      },
      description: "Returns a page of entries.",
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
      description:
        "- `forbidden`: you don't hold `audit.read`. `details.required_scope` names it.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["validation_error"]),
        },
      },
      description:
        "- `validation_error`: a query parameter is unknown or invalid, such as a time that isn't a timestamp, or `cursor` is malformed or came from another listing.",
    },
  },
});

export function auditRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(listAuditRoute, async (c) => {
    requirePermission(c, "audit.read");
    const {
      action,
      resource_type,
      resource_id,
      kind,
      q,
      created_after,
      created_before,
      limit,
      cursor,
    } = c.req.valid("query");

    const result = await storage.audit.list({
      action,
      resource_type,
      resource_id,
      kind,
      q,
      created_after,
      created_before,
      limit,
      cursor,
    });

    return c.json(result, 200);
  });

  return router;
}
