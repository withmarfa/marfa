/**
 * /views: the one door that writes `system.view`. The item doors refuse
 * every `system.*` write, so a view is created, changed and deleted here,
 * gated on write to `system.view` in the caller's type map. The door that
 * lists a view's items asks the reader's own type map of every row, so a view
 * never widens what a key reads.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorCode,
  MarfaError,
  getEdgeTypeSchema,
  isValidId,
  maxStringLength,
  resolveEnforcement,
} from "@withmarfa/shared";
import type { Item, Metadata } from "@withmarfa/shared";
import type { Context } from "hono";
import { snapshotReadRoute } from "../middleware/read-snapshot.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  pageCursor,
  pageLimit,
} from "../page-limits.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  checkTypePermission,
  getTypeFilter,
  itemProvenanceSource,
  readsSomeType,
  requireAuth,
  requireEdgePermission,
  requireReadableRow,
  standingRule,
} from "../middleware/auth.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { PARENT_OF } from "../storage/view-listing.js";
import { assertFilterEdgeTermsReadable } from "./_edge-visibility.js";
import { rememberItemSubject } from "../middleware/replay-requirements.js";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import type { Storage } from "../storage/interface.js";
import { writeItem } from "../storage/item-write.js";
import type { ItemWriteResult } from "../storage/item-write.js";
import { requestWriter } from "../auth/version-writer.js";
import {
  createOpenAPIRouter,
  makeErrorResponseSchema,
  OkResponseSchema,
} from "../openapi.js";
import { ItemSchema, ItemWithMetadataSchema, pageOf } from "./_schemas.js";
import { AncestorUnavailableSchema, ConflictResponseSchema } from "./items.js";
import { readableMetadata } from "./_extension-reach.js";
import { requestBlobProof } from "./_blob-reach.js";
import {
  assertItemQuery,
  itemQuerySchema,
  settingRefusal,
} from "./_item-query.js";

const VIEW_TYPE = "system.view";

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const PROPERTY = "properties\\.[A-Za-z_][A-Za-z0-9_]*";
const OWN_FIELDS = [
  "title",
  "created_at",
  "updated_at",
  "occurred_at",
  "type",
  "state",
  "tier",
  "tags",
] as const;
const DATE_FIELDS: ReadonlySet<string> = new Set([
  "created_at",
  "updated_at",
  "occurred_at",
]);
const EDGE_REF = /^(edge|backref)\[([^\]\s]+)\]$/;

const FIELD_WORDS = `an own field (${OWN_FIELDS.map((f) => `\`${f}\``).join(", ")}) or \`properties.<name>\``;

function fieldPattern(alternatives: string): RegExp {
  return new RegExp(`^(?:${alternatives})$`);
}

const FieldSchema = z
  .string()
  .regex(fieldPattern([...OWN_FIELDS, PROPERTY].join("|")), {
    message: `A field is ${FIELD_WORDS}`,
  })
  .describe(`A field: ${FIELD_WORDS}.`)
  .openapi("ViewField", { example: "properties.status" });

const GroupValueSchema = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .describe("A value of the field the view groups by.");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ViewQuerySchema = itemQuerySchema(
  {
    name: "ViewQuery",
    description: "The query that decides which items a view lists.",
    types:
      "The types the view lists, each with its subtypes. Empty or absent lists every type the reading key can read, except `system.*`.",
    tier: "The tier the view lists. Absent means `all`.",
    state: "The states the view lists. Absent means both.",
    filter:
      "A filter expression, as on `GET /items`, that narrows what the view lists.",
    beneath:
      "An item ID. The view lists that item and everything under it by `parent-of`, at any depth.",
  },
  z
    .enum(["library", "feed", "all"])
    .describe("A tier: `library`, `feed`, or `all` for both.")
    .openapi("ViewTier"),
);

const SortSchema = z
  .strictObject({
    by: FieldSchema.describe("The field to sort by."),
    direction: z
      .enum(["asc", "desc"])
      .describe("`asc` sorts smallest first, `desc` largest first."),
  })
  .openapi("ViewSort", { description: "One key a view sorts by." });

const SortsSchema = z
  .array(SortSchema)
  .max(10)
  .describe("The keys the view sorts by, first key first.");

const GroupSchema = z
  .strictObject({
    by: z
      .string()
      .describe(
        "The field to group by: a field, or `edge[<type>]` or `backref[<type>]` for the item an edge of that type joins.",
      )
      .openapi({ example: "properties.status" }),
    bucket: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe(
        "For a date field, the span each group covers. Absent groups by the value.",
      ),
    order: z
      .array(GroupValueSchema)
      .max(1000)
      .optional()
      .describe(
        "The values whose groups come first, in this order. Other groups follow.",
      ),
    hidden: z
      .array(GroupValueSchema)
      .max(1000)
      .optional()
      .describe("The values whose groups the view leaves out."),
  })
  .openapi("ViewGroup", { description: "How a view groups its items." });

const TitleSchema = maxStringLength(z.string().min(1), 500);

const CreateViewSchema = z.strictObject({
  title: TitleSchema.describe("The view's title."),
  query: ViewQuerySchema.optional().describe(
    "Which items the view lists. Absent lists every item the reading key can read, except `system.*`.",
  ),
  sort: SortsSchema.optional(),
  group: GroupSchema.optional().describe(
    "How the view groups the items it lists.",
  ),
});

const UpdateViewSchema = z.strictObject({
  version: z
    .number()
    .int()
    .min(0)
    .describe(
      "The version of the view you read. If the view has changed since, Marfa merges your change where nothing collides.",
    ),
  title: TitleSchema.optional().describe("A new title for the view."),
  query: ViewQuerySchema.optional().describe(
    "A new query, which replaces the current one whole.",
  ),
  sort: SortsSchema.optional().describe(
    "A new sort, which replaces the current one whole.",
  ),
  group: z
    .union([GroupSchema, z.null()])
    .optional()
    .describe(
      "A new grouping, which replaces the current one whole. `null` removes the grouping.",
    ),
});

/** The two settings a listing reads, from a stored view. */
const StoredViewSchema = z.looseObject({
  query: ViewQuerySchema.optional(),
  sort: SortsSchema.optional(),
});

const IdParam = z.object({
  id: z.string().describe("The ID of the view."),
});

/** This module's part of `DESCRIBED_ONLY_BY_REFERENCE` in `_schemas.ts`. */
export const VIEW_SCHEMAS_DESCRIBED_BY_REFERENCE: Readonly<
  Record<string, z.ZodType>
> = {
  ViewField: FieldSchema,
  ViewTier: ViewQuerySchema.shape.tier.unwrap(),
  ViewSort: SortSchema,
  ViewGroup: GroupSchema,
};

// ---------------------------------------------------------------------------
// Validation the schemas cannot express
// ---------------------------------------------------------------------------

function isDateField(field: string): boolean {
  return DATE_FIELDS.has(field) || field.startsWith("properties.");
}

function assertGroupBy(path: string, by: string): void {
  const edge = EDGE_REF.exec(by);
  if (edge) {
    const edgeType = edge[2] ?? "";
    if (getEdgeTypeSchema(edgeType) === undefined) {
      throw settingRefusal(
        ErrorCode.VALIDATION_ERROR,
        path,
        `Unknown edge type: ${edgeType}`,
      );
    }
    return;
  }
  if (!FieldSchema.safeParse(by).success) {
    throw settingRefusal(
      ErrorCode.VALIDATION_ERROR,
      path,
      `A group is by ${FIELD_WORDS}, or by \`edge[<type>]\` or \`backref[<type>]\``,
    );
  }
}

type UpdateSettings = Omit<z.infer<typeof UpdateViewSchema>, "version">;

interface Settings {
  query?: z.infer<typeof ViewQuerySchema> | undefined;
  group?: z.infer<typeof GroupSchema> | null | undefined;
}

function assertSettings({ query, group }: Settings): void {
  if (query !== undefined) assertItemQuery("query", query);
  if (group === undefined || group === null) return;
  assertGroupBy("group.by", group.by);
  if (group.bucket !== undefined && !isDateField(group.by)) {
    throw settingRefusal(
      ErrorCode.VALIDATION_ERROR,
      "group.bucket",
      `${group.by} is not a date field, so it takes no bucket`,
    );
  }
}

// ---------------------------------------------------------------------------
// Gate and lookup
// ---------------------------------------------------------------------------

/**
 * Asks the type map alone: `checkTypeAccess` fences `system.*` writes off from
 * every key. Asked at the door and again inside each write's transaction.
 */
function requireViewWrite(c: Context<AppEnv>): void {
  const key = requireAuth(c);
  checkTypePermission(key, VIEW_TYPE, "write");
}

/** Every view door takes write on `system.view`. */
const writesViews = standingRule(`write on ${VIEW_TYPE}`, requireViewWrite);

async function requireView(storage: Storage, id: string): Promise<Item> {
  if (!isValidId(id)) {
    throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
  }
  const item = await storage.items.get(id);
  if (item?.type !== VIEW_TYPE) {
    throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `View ${id} not found`);
  }
  return item;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const unauthorized = {
  401: {
    content: {
      "application/json": { schema: makeErrorResponseSchema(["unauthorized"]) },
    },
    description: "Unauthorized",
  },
};

const notPermitted = {
  403: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["type_not_permitted"]),
      },
    },
    description:
      "- `type_not_permitted`: you don't have write on `system.view`.",
  },
};

const notFound = {
  404: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["item_not_found"]),
      },
    },
    description: "- `item_not_found`: no `system.view` has this ID.",
  },
};

const SETTING_MALFORMED =
  "- `validation_error`: a setting is malformed or undeclared, `details.errors[0].path` or `details.unknown_body_fields` names it.";

const SETTING_TYPE_UNKNOWN =
  "- `unknown_type`: `query.types` names a type that isn't registered.";

const createViewRoute = createRoute({
  operationId: "createView",
  method: "post",
  path: "/",
  tags: ["Views"],
  summary: "Create a view",
  description:
    "Creates a view: a `system.view` item whose properties say which items it lists, in what order and how they group. The item endpoints can't write one.",
  security: [{ bearerAuth: [] }],
  middleware: writesViews,
  request: {
    body: {
      content: { "application/json": { schema: CreateViewSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: ItemWithMetadataSchema } },
      description:
        "Returns the new view, a `system.view` item, and its metadata.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "unknown_type",
          ]),
        },
      },
      description: `${SETTING_MALFORMED}\n- \`missing_required_field\`: \`title\` is missing. \`details.field\` names it.\n${SETTING_TYPE_UNKNOWN}`,
    },
    ...unauthorized,
    ...notPermitted,
  },
});

const updateViewRoute = createRoute({
  operationId: "updateView",
  method: "patch",
  path: "/{id}",
  tags: ["Views"],
  summary: "Update a view",
  description:
    "Updates a view's title, query, sort or group. Each one you send replaces the current value whole, and those you leave out stay as they are. Send `group: null` to remove the grouping. Send the `version` you read.",
  security: [{ bearerAuth: [] }],
  middleware: writesViews,
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: UpdateViewSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ItemWithMetadataSchema } },
      description: "Returns the updated view and its metadata.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "missing_required_field",
            "unknown_type",
            "invalid_id",
            "invalid_transition",
          ]),
        },
      },
      description: `- \`validation_error\`: no setting, or a malformed or undeclared setting; \`details\` names it.\n- \`missing_required_field\`: \`version\` is missing; \`details.field\` names it.\n${SETTING_TYPE_UNKNOWN}\n- \`invalid_id\`: the ID is invalid.\n- \`invalid_transition\`: the view is revoked.`,
    },
    ...unauthorized,
    ...notPermitted,
    ...notFound,
    409: {
      content: {
        "application/json": {
          schema: z.union([ConflictResponseSchema, AncestorUnavailableSchema]),
        },
      },
      description:
        "- `version_conflict`: a setting you sent has changed since `version`. `conflicting_fields` names it.\n- `ancestor_unavailable`: Marfa holds no snapshot of `version` to merge from.",
    },
  },
});

const deleteViewRoute = createRoute({
  operationId: "deleteView",
  method: "delete",
  path: "/{id}",
  tags: ["Views"],
  summary: "Delete a view",
  description:
    "Deletes an active or revoked view permanently, with no trash. Marfa announces it as `item.purged`, so every app drops it. The items it listed don't change.",
  security: [{ bearerAuth: [] }],
  middleware: writesViews,
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: OkResponseSchema } },
      description: "Returns `ok: true`.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id"]),
        },
      },
      description: "- `invalid_id`: the ID is malformed.",
    },
    ...unauthorized,
    ...notPermitted,
    ...notFound,
  },
});

const listViewItemsRoute = createRoute({
  operationId: "listViewItems",
  method: "get",
  path: "/{id}/items",
  tags: ["Views"],
  summary: "List a view's items",
  description:
    "Returns a page of the items a view lists, in the view's sort order. Items of types you can't read are left out. A view's grouping isn't applied.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    params: IdParam,
    query: z.object({
      limit: pageLimit({ max: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT }),
      cursor: pageCursor(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: pageOf(ItemSchema, "ViewItemPage", {
            page: "A page of the items a view lists.",
            data: "The items on this page, in the view's sort order.",
          }),
        },
      },
      description: "Returns a page of items.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "validation_error",
            "invalid_id",
            "invalid_transition",
          ]),
        },
      },
      description:
        "- `validation_error`: `cursor` came from another view or ordering, or the view holds a setting that can't be listed.\n- `invalid_id`: the ID is invalid.\n- `invalid_transition`: the view is revoked.",
    },
    ...unauthorized,
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "type_not_permitted",
            "edge_permission_denied",
          ]),
        },
      },
      description:
        "- `type_not_permitted`: your credential reaches no type.\n- `edge_permission_denied`: the view's filter names an edge type, or its `beneath` needs `parent-of`, that you can't read.",
    },
    404: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["item_not_found"]),
        },
      },
      description:
        "- `item_not_found`: no `system.view` you can read has this ID.",
    },
  },
});

/**
 * The properties a change writes. A merge cannot remove a property, so a
 * `group` of `null` is a clear: the store removes it, and at a stale version
 * treats it as a change to `group` alone.
 */
function changedProperties({ group, ...rest }: UpdateSettings): {
  properties: Record<string, unknown>;
  clear_properties?: string[];
} {
  if (group === null) return { properties: rest, clear_properties: ["group"] };
  return { properties: group === undefined ? rest : { ...rest, group } };
}

/** The row a view write left, which every create and change leaves. */
function written(result: ItemWriteResult): { item: Item; metadata: Metadata } {
  if (result.outcome === "created" || result.outcome === "updated") {
    return { item: result.item, metadata: result.metadata };
  }
  throw new Error(`A view write answered ${result.outcome}`);
}

export function viewRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createViewRoute, async (c) => {
    const body = c.req.valid("json");
    assertSettings(body);
    const { item, metadata } = await runAuditedTransaction(
      storage,
      () => {
        requireViewWrite(c);
        return writeItem(
          storage,
          { kind: "platform", by: requestWriter(c) },
          {
            op: "create",
            type: VIEW_TYPE,
            properties: body,
            source: itemProvenanceSource(c.get("apiKey")),
            blob_proof: requestBlobProof(c, storage),
          },
        );
      },
      ({ item }) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "view.create",
        resource_type: "item",
        resource_id: item.id,
      }),
    );

    rememberItemSubject(item, "write", true);
    return c.json(
      { item, metadata: readableMetadata(metadata, c.get("apiKey")) },
      201,
    );
  });

  router.openapi(snapshotReadRoute(storage, listViewItemsRoute), async (c) => {
    const { id } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");
    if (!isValidId(id)) {
      throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    const found = await storage.items.get(id);
    const view = requireReadableRow(
      c,
      found?.type === VIEW_TYPE ? found : null,
      () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, `View ${id} not found`),
    );
    if (view.state === "revoked") {
      throw new MarfaError(
        ErrorCode.INVALID_TRANSITION,
        `View ${id} is revoked, and a revoked view lists nothing`,
      );
    }
    const settings = StoredViewSchema.safeParse(view.properties);
    if (!settings.success) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        `View ${id} holds a setting that can't be listed`,
      );
    }
    const query = settings.data.query ?? {};
    assertFilterEdgeTermsReadable(c, query.filter);
    if (query.beneath !== undefined) {
      requireEdgePermission(c, PARENT_OF, "read");
    }
    const reader = getTypeFilter(c);
    const { source_filter } = resolveEnforcement(
      await readInstanceConfig(storage.settings),
      requireAuth(c),
    );
    const page = await storage.items.listInView(
      {
        id,
        query,
        sort: settings.data.sort ?? [],
        reader: {
          source_filter,
          readable_sources: reader,
          allowed_types: reader.allowed,
          excluded_types: reader.excluded,
        },
      },
      { limit, cursor },
    );
    return c.json(page, 200);
  });

  router.openapi(updateViewRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { version, ...settings } = c.req.valid("json");
    if (Object.keys(settings).length === 0) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Name at least one setting to change",
      );
    }
    assertSettings(settings);
    const result = await runAuditedTransaction(
      storage,
      async () => {
        requireViewWrite(c);
        const view = await requireView(storage, id);
        if (view.state === "revoked") {
          throw new MarfaError(
            ErrorCode.INVALID_TRANSITION,
            `View ${id} is revoked, and a revoked view does not change`,
          );
        }
        rememberItemSubject(view, "write", true);
        return await writeItem(
          storage,
          { kind: "platform", by: requestWriter(c) },
          {
            op: "update",
            id,
            ...changedProperties(settings),
            prune_undeclared_properties: true,
            version,
            blob_proof: requestBlobProof(c, storage),
          },
        );
      },
      (result) =>
        result.outcome === "updated" || result.outcome === "created"
          ? {
              client_ip: c.get("clientIp") ?? null,
              key_id: c.get("apiKey")?.id,
              action: "view.update",
              resource_type: "item",
              resource_id: id,
            }
          : null,
    );
    if (result.outcome === "conflict") {
      c.header("X-Error-Code", result.conflict.error.code);
      return c.json(result.conflict, 409);
    }
    if (result.outcome === "stale") {
      throw new Error("A view update always carries settings to merge");
    }
    const { item, metadata } = written(result);

    rememberItemSubject(item, "write", true);
    return c.json(
      { item, metadata: readableMetadata(metadata, c.get("apiKey")) },
      200,
    );
  });

  router.openapi(deleteViewRoute, async (c) => {
    const { id } = c.req.valid("param");
    // A purge takes only a row already out of `active`, so an active view passes
    // through `revoked` unannounced and the purge alone is announced.
    await runAuditedTransaction(
      storage,
      async () => {
        requireViewWrite(c);
        const view = await requireView(storage, id);
        rememberItemSubject(view, "write", true);
        const writer = { kind: "platform", by: requestWriter(c) } as const;
        if (view.state !== "revoked") {
          await writeItem(
            storage,
            writer,
            { op: "transition", id, state: "revoked" },
            { announce: false },
          );
        }
        await writeItem(storage, writer, { op: "purge", id });
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "view.delete",
        resource_type: "item",
        resource_id: id,
      },
    );
    return c.json({ ok: true as const }, 200);
  });

  return router;
}
