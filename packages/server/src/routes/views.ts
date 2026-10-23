/**
 * /views: the one door that writes `system.view`. The item doors refuse
 * every `system.*` write, so a view is created, changed and deleted here,
 * gated on write to `system.view` in the caller's type map. Nothing here
 * returns the items a view lists: a view never widens what a key reads.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorCode,
  MarfaError,
  getEdgeTypeSchema,
  isValidId,
  maxStringLength,
} from "@withmarfa/shared";
import type { Item, Metadata } from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  checkTypePermission,
  itemProvenanceSource,
  requireAuth,
  standingRule,
} from "../middleware/auth.js";
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
import { ItemWithMetadataSchema } from "./_schemas.js";
import { AncestorUnavailableSchema, ConflictResponseSchema } from "./items.js";
import { readableMetadata } from "./_extension-reach.js";
import { requestBlobProof } from "./_blob-reach.js";
import {
  assertItemQuery,
  itemQuerySchema,
  settingRefusal,
} from "./_item-query.js";

const VIEW_TYPE = "system.view";
const MAX_LAYOUTS = 50;

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

const DateFieldSchema = z
  .string()
  .regex(fieldPattern([...DATE_FIELDS, PROPERTY].join("|")), {
    message:
      "A date field is `created_at`, `updated_at`, `occurred_at` or `properties.<name>`",
  });

const PropertyFieldSchema = z.string().regex(fieldPattern(PROPERTY), {
  message: "This option takes `properties.<name>`",
});

const GroupValueSchema = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .describe("A value of the field the layout groups by.");

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

const LayoutKindSchema = z
  .enum([
    "list",
    "table",
    "board",
    "gallery",
    "calendar",
    "timeline",
    "chart",
    "map",
  ])
  .describe(
    "How a layout shows items. `list`: rows. `table`: rows with columns. `board`: columns by `group`. `gallery`: cards. `calendar`: on dates. `timeline`: as spans. `chart`: as a chart. `map`: on a map.",
  )
  .openapi("ViewLayoutKind");

type LayoutKind = z.infer<typeof LayoutKindSchema>;

const SortSchema = z
  .strictObject({
    by: FieldSchema.describe("The field to sort by."),
    direction: z
      .enum(["asc", "desc"])
      .describe("`asc` sorts smallest first, `desc` largest first."),
  })
  .openapi("ViewSort", { description: "One key a layout sorts by." });

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
      .describe("The values whose groups the layout leaves out."),
  })
  .openapi("ViewGroup", { description: "How a layout groups its items." });

const ChartValueSchema = z
  .union([
    z.literal("count"),
    z.strictObject({
      sum: PropertyFieldSchema.describe(
        "The number property whose values are added up.",
      ),
    }),
  ])
  .describe(
    'What a chart measures: `count` of items, or `{ "sum": "properties.<name>" }`.',
  );

const LayoutSchema = z
  .strictObject({
    id: maxStringLength(z.string().min(1), 100).describe(
      "The layout's ID, unique in the view, which an app keeps to reopen it.",
    ),
    kind: LayoutKindSchema.describe("How the layout shows items."),
    title: maxStringLength(z.string().min(1), 500)
      .optional()
      .describe("The layout's name. Absent, an app names it by its kind."),
    sort: z
      .array(SortSchema)
      .max(10)
      .optional()
      .describe("The keys the layout sorts by, first key first."),
    group: GroupSchema.optional().describe(
      "How the layout groups its items. A `board` requires it.",
    ),
    shown: z
      .array(FieldSchema)
      .max(200)
      .optional()
      .describe("The fields the layout shows, in order."),
    image: PropertyFieldSchema.optional().describe(
      "For a `gallery`, the property that holds each card's image.",
    ),
    date: DateFieldSchema.optional().describe(
      "For a `calendar`, the date field that places each item.",
    ),
    start: DateFieldSchema.optional().describe(
      "For a `timeline`, the date field each span starts at. Required for a `timeline`.",
    ),
    end: DateFieldSchema.optional().describe(
      "For a `calendar` or `timeline`, the date field each span ends at. Required for a `timeline`.",
    ),
    x: FieldSchema.optional().describe(
      "For a `chart`, the field along its horizontal axis.",
    ),
    y: ChartValueSchema.optional(),
    location: PropertyFieldSchema.optional().describe(
      "For a `map`, the property that holds each item's place.",
    ),
  })
  .openapi("ViewLayout", {
    description:
      "One way a view shows its items. A layout takes only the options its `kind` takes, and never narrows which items the view lists.",
  });

const LayoutsSchema = z
  .array(LayoutSchema)
  .min(1)
  .max(MAX_LAYOUTS)
  .describe("How the view shows its items, in order. At least one.");

type Layout = z.infer<typeof LayoutSchema>;

const TitleSchema = maxStringLength(z.string().min(1), 500);

const CreateViewSchema = z.strictObject({
  title: TitleSchema.describe("The view's title."),
  query: ViewQuerySchema.optional().describe(
    "Which items the view lists. Absent lists every item the reading key can read, except `system.*`.",
  ),
  layouts: LayoutsSchema,
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
  layouts: LayoutsSchema.optional().describe(
    "New layouts, which replace the current ones whole. At least one.",
  ),
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
  ViewLayoutKind: LayoutKindSchema,
  ViewSort: SortSchema,
  ViewGroup: GroupSchema,
};

// ---------------------------------------------------------------------------
// Validation the schemas cannot express
// ---------------------------------------------------------------------------

const KIND_ONLY_OPTIONS = [
  "image",
  "date",
  "start",
  "end",
  "x",
  "y",
  "location",
] as const;

/** The kind-only options each kind takes, and those it requires. */
const KINDS: Record<
  LayoutKind,
  {
    takes: readonly (typeof KIND_ONLY_OPTIONS)[number][];
    requires: readonly string[];
  }
> = {
  list: { takes: [], requires: [] },
  table: { takes: [], requires: [] },
  board: { takes: [], requires: ["group"] },
  gallery: { takes: ["image"], requires: [] },
  calendar: { takes: ["date", "end"], requires: [] },
  timeline: { takes: ["start", "end"], requires: ["start", "end"] },
  chart: { takes: ["x", "y"], requires: [] },
  map: { takes: ["location"], requires: [] },
};

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

function assertLayout(path: string, layout: Layout): void {
  const kind = KINDS[layout.kind];
  for (const option of KIND_ONLY_OPTIONS) {
    if (layout[option] !== undefined && !kind.takes.includes(option)) {
      throw settingRefusal(
        ErrorCode.VALIDATION_ERROR,
        `${path}.${option}`,
        `A ${layout.kind} layout does not take ${option}`,
      );
    }
  }
  for (const option of kind.requires) {
    if (layout[option as keyof Layout] === undefined) {
      const field = `${path}.${option}`;
      throw new MarfaError(
        ErrorCode.MISSING_REQUIRED_FIELD,
        `A ${layout.kind} layout requires ${option}`,
        { field },
      );
    }
  }
  if (layout.group !== undefined) {
    assertGroupBy(`${path}.group.by`, layout.group.by);
    if (layout.group.bucket !== undefined && !isDateField(layout.group.by)) {
      throw settingRefusal(
        ErrorCode.VALIDATION_ERROR,
        `${path}.group.bucket`,
        `${layout.group.by} is not a date field, so it takes no bucket`,
      );
    }
  }
}

interface Settings {
  query?: z.infer<typeof ViewQuerySchema> | undefined;
  layouts?: Layout[] | undefined;
}

function assertSettings({ query, layouts }: Settings): void {
  if (query !== undefined) assertItemQuery("query", query);
  const seen = new Map<string, number>();
  layouts?.forEach((layout, i) => {
    const path = `layouts.${String(i)}`;
    const first = seen.get(layout.id);
    if (first !== undefined) {
      throw settingRefusal(
        ErrorCode.VALIDATION_ERROR,
        `${path}.id`,
        `Layout id "${layout.id}" is already used by layouts.${String(first)}`,
      );
    }
    seen.set(layout.id, i);
    assertLayout(path, layout);
  });
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
  "- `validation_error`: a setting is malformed or undeclared, such as a repeated layout `id`. `details.errors[0].path` or `details.unknown_body_fields` names it.";

const SETTING_TYPE_UNKNOWN =
  "- `unknown_type`: `query.types` names a type that isn't registered.";

const createViewRoute = createRoute({
  operationId: "createView",
  method: "post",
  path: "/",
  tags: ["Views"],
  summary: "Create a view",
  description:
    "Creates a view: a `system.view` item whose properties say which items it lists and how its layouts show them. The item endpoints can't write one.",
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
      description: `${SETTING_MALFORMED}\n- \`missing_required_field\`: \`title\`, \`layouts\` or a part a layout requires is missing. \`details.field\` names it.\n${SETTING_TYPE_UNKNOWN}`,
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
    "Updates a view's title, query or layouts. Each one you send replaces the current value whole, and those you leave out stay as they are. Send the `version` you read.",
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
          ]),
        },
      },
      description: `${SETTING_MALFORMED} Also returned for no setting.\n- \`missing_required_field\`: \`version\` or a part a layout requires is missing. \`details.field\` names it.\n${SETTING_TYPE_UNKNOWN}\n- \`invalid_id\`: the ID is invalid.`,
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
    "Deletes a view permanently, with no trash. Marfa announces it as `item.purged`, so every app drops it. The items it listed don't change.",
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
        rememberItemSubject(view, "write", true);
        return await writeItem(
          storage,
          { kind: "platform", by: requestWriter(c) },
          {
            op: "update",
            id,
            properties: settings,
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
    // A purge takes only a row already out of `active`, so the view passes
    // through `revoked` unannounced and the purge alone is announced.
    await runAuditedTransaction(
      storage,
      async () => {
        requireViewWrite(c);
        const view = await requireView(storage, id);
        rememberItemSubject(view, "write", true);
        const writer = { kind: "platform", by: requestWriter(c) } as const;
        await writeItem(
          storage,
          writer,
          { op: "transition", id, state: "revoked" },
          { announce: false },
        );
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
