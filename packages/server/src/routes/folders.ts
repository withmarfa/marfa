import { maxStringLength } from "@withmarfa/shared";
import { runAuditedTransaction } from "../storage/audited-transaction.js";
import { rememberItemSubject } from "../middleware/replay-requirements.js";
/**
 * /folders: the one door that writes `system.folder`. The item doors refuse
 * every `system.*` write, so a folder's settings are created, changed and
 * revoked here, gated on write to `system.folder` in the caller's type map.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorCode,
  MarfaError,
  getEdgeTypeSchema,
  isValidId,
} from "@withmarfa/shared";
import type { Item, Metadata } from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  itemProvenanceSource,
  requireAuth,
  checkTypePermission,
  standingRule,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { writeItem } from "../storage/item-write.js";
import { requestWriter } from "../auth/version-writer.js";
import type { ItemWriteResult } from "../storage/item-write.js";
import { depthInsideFolder } from "../folder-path.js";
import { MAX_TAGS_PER_ITEM } from "../tag-limits.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import {
  ItemWithMetadataSchema,
  TagSchema,
  TierEnum,
  WrittenPropertiesSchema,
} from "./_schemas.js";
import { AncestorUnavailableSchema, ConflictResponseSchema } from "./items.js";
import { readableMetadata } from "./_extension-reach.js";
import { requestBlobProof } from "./_blob-reach.js";
import {
  assertItemQuery,
  assertKnownType,
  itemQuerySchema,
  settingRefusal,
} from "./_item-query.js";
import * as clock from "../clock.js";

const FOLDER_TYPE = "system.folder";
const MAX_DEFAULT_EDGE_TYPES = 100;
const MAX_DEFAULT_EDGE_TARGETS = 100;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FolderQuerySchema = itemQuerySchema(
  {
    name: "FolderQuery",
    description: "The query that decides which items a folder holds.",
    types:
      "The types the folder holds, each with its subtypes. Empty or absent holds every type the machine's key can read, except `system.*`.",
    tier: "The tiers the folder holds: `library`, `feed`, or `all` for both. Absent means `library`.",
    state: "The states the folder holds. Absent means both.",
    filter:
      "A filter expression, as on `GET /items`, that narrows what the folder holds.",
    beneath:
      "An item ID. The folder holds that item and everything under it by `parent-of`, at any depth.",
  },
  z.enum(["library", "feed", "all"]),
);

const FolderDefaultsSchema = z
  .strictObject({
    type: z
      .string()
      .optional()
      .describe("The type a new file becomes if its frontmatter names none."),
    tier: TierEnum.optional().describe(
      "The tier a new file takes if its frontmatter names none.",
    ),
    properties: WrittenPropertiesSchema.optional().describe(
      "Properties a new file takes where its frontmatter doesn't set them. A default for the type's body field is never taken: the file's body is that property. A whole number whose digits a 64-bit float doesn't keep is refused.",
    ),
    tags: z
      .array(TagSchema)
      .max(MAX_TAGS_PER_ITEM)
      .optional()
      .describe("Tags a new file takes if its frontmatter has no `tags` line."),
    edges: z
      .record(z.string(), z.array(z.string()).max(MAX_DEFAULT_EDGE_TARGETS))
      .optional()
      .describe(
        `Edges a new file takes, as a map from edge type to item IDs: at most ${String(MAX_DEFAULT_EDGE_TYPES)} edge types, ${String(MAX_DEFAULT_EDGE_TARGETS)} IDs each. An edge runs from the new file to the item, except \`parent-of\`, which makes the new file its child.`,
      ),
  })
  .openapi("FolderDefaults", {
    description:
      "What a new file takes where its frontmatter leaves a blank. A change to a file already in the folder never takes them.",
  });

const PatternListSchema = z
  .array(maxStringLength(z.string().min(1), 1024))
  .max(1000);

const RemovalThresholdSchema = z
  .strictObject({
    files: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "A removal waits to be confirmed only if it takes more than this many files. Absent means 10.",
      ),
    fraction: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "A removal waits to be confirmed only if it takes more than this fraction of the folder's files. Absent means 0.25.",
      ),
  })
  .openapi("FolderRemovalThreshold", {
    description:
      "How large a removal must be to wait for confirmation before it goes ahead.",
  });

const settingsShape = {
  query: FolderQuerySchema.describe("Which items the folder holds."),
  defaults: FolderDefaultsSchema.describe(
    "What a new file takes where its frontmatter leaves a blank.",
  ),
  include: PatternListSchema.describe(
    "Gitignore patterns, relative to the folder's root, for the paths the folder takes. Empty or absent takes every path. A dot-led name is taken only if a pattern names it. Secrets and files a machine or editor writes for itself are never taken.",
  ),
  ignore: PatternListSchema.describe(
    "Gitignore patterns, relative to the folder's root, for the paths the folder leaves alone. They win over `include`.",
  ),
  first_placement: z
    .record(z.string(), maxStringLength(z.string().min(1), 1024))
    .describe(
      "Where an item made elsewhere first appears in the folder: a map from type identifier to a directory relative to the folder's root. The most specific matching type wins.",
    ),
  removal_threshold: RemovalThresholdSchema.describe(
    "A removal waits to be confirmed when it takes more than `files` files and more than `fraction` of the folder's files.",
  ),
};

type Settings = {
  [K in keyof typeof settingsShape]?: z.infer<(typeof settingsShape)[K]>;
};

const CreateFolderSchema = z.strictObject({
  title: maxStringLength(z.string().min(1), 500).describe(
    "The folder's title.",
  ),
  query: settingsShape.query.optional(),
  defaults: settingsShape.defaults.optional(),
  include: settingsShape.include.optional(),
  ignore: settingsShape.ignore.optional(),
  first_placement: settingsShape.first_placement.optional(),
  removal_threshold: settingsShape.removal_threshold.optional(),
});

const UpdateFolderSchema = z.strictObject({
  version: z
    .number()
    .int()
    .min(0)
    .describe(
      "The version of the folder you read. If the folder has changed since, Marfa merges your change where nothing collides.",
    ),
  title: maxStringLength(z.string().min(1), 500)
    .optional()
    .describe("A new title for the folder."),
  query: settingsShape.query.optional(),
  defaults: settingsShape.defaults.optional(),
  include: settingsShape.include.optional(),
  ignore: settingsShape.ignore.optional(),
  first_placement: settingsShape.first_placement.optional(),
  removal_threshold: settingsShape.removal_threshold.optional(),
});

const IdParam = z.object({
  id: z.string().describe("The ID of the folder."),
});

// ---------------------------------------------------------------------------
// Validation the schemas cannot express
// ---------------------------------------------------------------------------

function assertSettings(settings: Settings): void {
  const { query, defaults, first_placement: placement } = settings;
  if (query !== undefined) assertItemQuery("query", query);
  if (defaults?.type !== undefined) {
    assertKnownType("defaults.type", defaults.type);
  }
  const defaultEdges = Object.entries(defaults?.edges ?? {});
  if (defaultEdges.length > MAX_DEFAULT_EDGE_TYPES) {
    throw settingRefusal(
      ErrorCode.VALIDATION_ERROR,
      "defaults.edges",
      `At most ${String(MAX_DEFAULT_EDGE_TYPES)} edge types`,
    );
  }
  for (const [edgeType, targets] of defaultEdges) {
    const path = `defaults.edges.${edgeType}`;
    // A default names targets alone, and an in-folder edge needs a path.
    if (edgeType === "in-folder") {
      throw settingRefusal(
        ErrorCode.VALIDATION_ERROR,
        path,
        "in-folder is not a default: it needs the file's own path",
      );
    }
    if (getEdgeTypeSchema(edgeType) === undefined) {
      throw settingRefusal(
        ErrorCode.VALIDATION_ERROR,
        path,
        `Unknown edge type: ${edgeType}`,
      );
    }
    const bad = targets.find((target) => !isValidId(target));
    if (bad !== undefined) {
      throw settingRefusal(
        ErrorCode.VALIDATION_ERROR,
        path,
        `Invalid item id: ${bad}`,
      );
    }
  }
  for (const [type, dir] of Object.entries(placement ?? {})) {
    const path = `first_placement.${type}`;
    assertKnownType(path, type);
    if (depthInsideFolder(dir) === null) {
      throw settingRefusal(
        ErrorCode.VALIDATION_ERROR,
        path,
        `"${dir}" is not a directory inside the folder: write a path relative to its root, with "/" between names, that does not climb out of it`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Gate and lookup
// ---------------------------------------------------------------------------

/**
 * Asks the type map alone: `checkTypeAccess` fences `system.*` writes off from
 * every key. Asked at the door and again inside each write's transaction.
 */
function requireFolderWrite(c: Context<AppEnv>): void {
  const key = requireAuth(c);
  checkTypePermission(key, FOLDER_TYPE, "write");
}

/** Every folder door that writes takes write on `system.folder`. */
const writesFolders = standingRule(
  `write on ${FOLDER_TYPE}`,
  requireFolderWrite,
);

async function requireFolder(storage: Storage, id: string): Promise<Item> {
  if (!isValidId(id)) {
    throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
  }
  const item = await storage.items.get(id);
  if (item?.type !== FOLDER_TYPE) {
    throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, `Folder ${id} not found`);
  }
  return item;
}

function refuseRevoked(folder: Item): void {
  if (folder.state === "revoked") {
    throw new MarfaError(
      ErrorCode.INVALID_TRANSITION,
      `Folder ${folder.id} is revoked, and a revoked folder does not change`,
    );
  }
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
      "- `type_not_permitted`: you don't have write on `system.folder`.",
  },
};

const notFound = {
  404: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["item_not_found"]),
      },
    },
    description: "- `item_not_found`: no `system.folder` has this ID.",
  },
};

const SETTING_MALFORMED =
  "a setting is malformed or undeclared, such as a `system.*` type or a `first_placement` outside the folder. `details.errors[0].path` or `details.unknown_body_fields` names it.";

const SETTING_TYPE_UNKNOWN = "- `unknown_type`: a setting's type is unknown.";

const SETTING_PROPERTIES_INEXACT =
  "- `invalid_properties`: `defaults.properties` has a whole number a 64-bit float can't keep.";

const createRefusal = {
  400: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema([
          "validation_error",
          "missing_required_field",
          "unknown_type",
          "invalid_properties",
        ]),
      },
    },
    description: `- \`validation_error\`: ${SETTING_MALFORMED}\n- \`missing_required_field\`: \`title\` is missing.\n${SETTING_TYPE_UNKNOWN}\n${SETTING_PROPERTIES_INEXACT}`,
  },
};

const updateRefusal = {
  400: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema([
          "validation_error",
          "missing_required_field",
          "unknown_type",
          "invalid_id",
          "invalid_transition",
          "invalid_properties",
        ]),
      },
    },
    description: `- \`validation_error\`: a setting is malformed or undeclared (\`details.errors[0].path\` or \`details.unknown_body_fields\` names it).\n- \`missing_required_field\`: \`version\` is missing.\n${SETTING_TYPE_UNKNOWN}\n${SETTING_PROPERTIES_INEXACT}\n- \`invalid_id\`: the ID is invalid.\n- \`invalid_transition\`: the folder is revoked.`,
  },
};

const createFolderRoute = createRoute({
  operationId: "createFolder",
  method: "post",
  path: "/",
  tags: ["Folders"],
  summary: "Create a folder",
  description:
    "Creates a folder: a `system.folder` item whose properties are the settings every machine bound to the folder shares. The item endpoints can't write one.",
  security: [{ bearerAuth: [] }],
  middleware: writesFolders,
  request: {
    body: {
      content: { "application/json": { schema: CreateFolderSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: ItemWithMetadataSchema } },
      description:
        "Returns the new folder, a `system.folder` item, and its metadata.",
    },
    ...createRefusal,
    ...unauthorized,
    ...notPermitted,
  },
});

const updateFolderRoute = createRoute({
  operationId: "updateFolder",
  method: "patch",
  path: "/{id}",
  tags: ["Folders"],
  summary: "Update a folder",
  description:
    "Updates a folder's title and settings at the version you read. Each setting you send replaces its value whole; omitted settings stay. Removes stored properties the folder type does not declare.",
  security: [{ bearerAuth: [] }],
  middleware: writesFolders,
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: UpdateFolderSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ItemWithMetadataSchema } },
      description: "Returns the updated folder and its metadata.",
    },
    ...updateRefusal,
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

const revokeFolderRoute = createRoute({
  operationId: "revokeFolder",
  method: "post",
  path: "/{id}/revoke",
  tags: ["Folders"],
  summary: "Revoke a folder",
  description:
    "Revokes a folder: moves it to `revoked`, a terminal state, and sets `revoked_at`. The items placed in it keep their `in-folder` edges.",
  security: [{ bearerAuth: [] }],
  middleware: writesFolders,
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: ItemWithMetadataSchema } },
      description: "Returns the revoked folder and its metadata.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id", "invalid_transition"]),
        },
      },
      description:
        "- `invalid_id`: the ID is malformed.\n- `invalid_transition`: the folder is already revoked.",
    },
    ...unauthorized,
    ...notPermitted,
    ...notFound,
  },
});

/** The row a folder write left, which every folder write leaves. */
function written(result: ItemWriteResult): { item: Item; metadata: Metadata } {
  if (result.outcome === "created" || result.outcome === "updated") {
    return { item: result.item, metadata: result.metadata };
  }
  throw new Error(`A folder write answered ${result.outcome}`);
}

export function folderRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(createFolderRoute, async (c) => {
    const body = c.req.valid("json");
    assertSettings(body);
    const { item, metadata } = await runAuditedTransaction(
      storage,
      () => {
        requireFolderWrite(c);
        return writeItem(
          storage,
          { kind: "platform", by: requestWriter(c) },
          {
            op: "create",
            type: FOLDER_TYPE,
            properties: body,
            source: itemProvenanceSource(c.get("apiKey")),
            blob_proof: requestBlobProof(c, storage),
          },
        );
      },
      ({ item }) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "folder.create",
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

  router.openapi(updateFolderRoute, async (c) => {
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
        requireFolderWrite(c);
        const folder = await requireFolder(storage, id);
        rememberItemSubject(folder, "write", true);
        refuseRevoked(folder);
        return await writeItem(
          storage,
          { kind: "platform", by: requestWriter(c) },
          {
            op: "update",
            id,
            properties: settings,
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
              action: "folder.update",
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
      throw new Error("A folder update always carries settings to merge");
    }
    const { item, metadata } = written(result);

    rememberItemSubject(item, "write", true);
    return c.json(
      { item, metadata: readableMetadata(metadata, c.get("apiKey")) },
      200,
    );
  });

  router.openapi(revokeFolderRoute, async (c) => {
    const { id } = c.req.valid("param");
    // One change to a subscriber: the stamp rides on the state change that
    // announces both.
    const { item, metadata } = await runAuditedTransaction(
      storage,
      async () => {
        requireFolderWrite(c);
        const folder = await requireFolder(storage, id);
        rememberItemSubject(folder, "write", true);
        refuseRevoked(folder);
        await writeItem(
          storage,
          { kind: "platform", by: requestWriter(c) },
          {
            op: "update",
            id,
            properties: { revoked_at: clock.now().toISOString() },
            blob_proof: requestBlobProof(c, storage),
          },
          { announce: false },
        );
        const { item: revoked } = await writeItem(
          storage,
          { kind: "platform", by: requestWriter(c) },
          { op: "transition", id, state: "revoked" },
        );
        return { item: revoked, metadata: await storage.metadata.get(id) };
      },
      {
        client_ip: c.get("clientIp") ?? null,
        key_id: c.get("apiKey")?.id,
        action: "folder.revoke",
        resource_type: "item",
        resource_id: id,
      },
    );

    rememberItemSubject(item, "write", true);
    return c.json(
      { item, metadata: readableMetadata(metadata, c.get("apiKey")) },
      200,
    );
  });

  return router;
}
