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
  getTypeSchema,
  isSystemType,
  isValidId,
  isValidTypeIdentifier,
  parseFilter,
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

const FOLDER_TYPE = "system.folder";
const MAX_DEFAULT_EDGE_TYPES = 100;
const MAX_DEFAULT_EDGE_TARGETS = 100;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FolderSearchSchema = z
  .strictObject({
    types: z
      .array(z.string())
      .max(100)
      .optional()
      .describe(
        "Type identifiers, each with its subtypes. Empty or absent holds every type the folder's key reads.",
      ),
    tier: TierEnum.optional().describe(
      "The one tier the folder holds; absent is `library`.",
    ),
    state: z
      .array(z.enum(["active", "archived"]))
      .min(1)
      .optional()
      .describe("The states the folder holds; absent is both."),
    filter: z
      .string()
      .optional()
      .describe("An expression in the listing grammar's `filter`."),
    beneath: z
      .string()
      .optional()
      .describe(
        "An item id: that item and everything under it by `parent-of`.",
      ),
  })
  .openapi("FolderSearch");

const FolderDefaultsSchema = z
  .strictObject({
    type: z.string().optional(),
    tier: TierEnum.optional(),
    properties: WrittenPropertiesSchema.optional(),
    tags: z.array(TagSchema).max(MAX_TAGS_PER_ITEM).optional(),
    edges: z
      .record(z.string(), z.array(z.string()).max(MAX_DEFAULT_EDGE_TARGETS))
      .optional()
      .describe(
        `A map from edge type to the item ids a new file takes an edge with: at most ${String(MAX_DEFAULT_EDGE_TYPES)} edge types, each with at most ${String(MAX_DEFAULT_EDGE_TARGETS)} ids. Each edge runs from the new file to the item named, except \`parent-of\`, which runs from the item named to the new file, making the new file its child.`,
      ),
  })
  .openapi("FolderDefaults");

const PatternListSchema = z.array(z.string().min(1).max(1024)).max(1000);

const RemovalThresholdSchema = z
  .strictObject({
    files: z.number().int().min(0).optional(),
    fraction: z.number().min(0).max(1).optional(),
  })
  .openapi("FolderRemovalThreshold");

const settingsShape = {
  search: FolderSearchSchema.describe("Which items the folder holds."),
  defaults: FolderDefaultsSchema.describe(
    "What a new file takes where its frontmatter leaves a blank.",
  ),
  include: PatternListSchema.describe(
    "Gitignore patterns, relative to the folder's root, naming the paths the folder takes; empty or absent takes every path. A dot-led path is taken only where a line names a dot-led name on its way, and no line reaches what the built-in lists name.",
  ),
  ignore: PatternListSchema.describe(
    "Gitignore patterns, relative to the folder's root, naming the paths the folder leaves alone, winning over `include`; the built-in lists, of files a machine or an editor writes for itself and of secrets, apply whatever either list says.",
  ),
  first_placement: z
    .record(z.string(), z.string().min(1).max(1024))
    .describe(
      "A map from type identifier to the directory, relative to the folder's root, where a new item of that type made elsewhere first appears.",
    ),
  removal_threshold: RemovalThresholdSchema.describe(
    "A removal pauses when it is more than `files` files and more than `fraction` of the folder; absent members are 10 and 0.25.",
  ),
};

type Settings = {
  [K in keyof typeof settingsShape]?: z.infer<(typeof settingsShape)[K]>;
};

const CreateFolderSchema = z.strictObject({
  title: z.string().min(1).max(500),
  search: settingsShape.search.optional(),
  defaults: settingsShape.defaults.optional(),
  include: settingsShape.include.optional(),
  ignore: settingsShape.ignore.optional(),
  first_placement: settingsShape.first_placement.optional(),
  removal_threshold: settingsShape.removal_threshold.optional(),
});

const UpdateFolderSchema = z.strictObject({
  version: z.number().int().min(0).describe("The version the caller read."),
  title: z.string().min(1).max(500).optional(),
  search: settingsShape.search.optional(),
  defaults: settingsShape.defaults.optional(),
  include: settingsShape.include.optional(),
  ignore: settingsShape.ignore.optional(),
  first_placement: settingsShape.first_placement.optional(),
  removal_threshold: settingsShape.removal_threshold.optional(),
});

const IdParam = z.object({
  id: z.string().describe("The folder's `system.folder` item id"),
});

// ---------------------------------------------------------------------------
// Validation the schemas cannot express
// ---------------------------------------------------------------------------

function settingRefusal(
  code: ErrorCode,
  path: string,
  message: string,
): MarfaError {
  return new MarfaError(code, message, { errors: [{ path, message }] });
}

function assertKnownType(path: string, id: string): void {
  if (!isValidTypeIdentifier(id)) {
    throw settingRefusal(
      ErrorCode.VALIDATION_ERROR,
      path,
      `Invalid type identifier: ${id}`,
    );
  }
  if (isSystemType(id)) {
    throw settingRefusal(
      ErrorCode.VALIDATION_ERROR,
      path,
      `${id} is a system type, which no item door writes`,
    );
  }
  if (getTypeSchema(id) === undefined) {
    throw settingRefusal(ErrorCode.UNKNOWN_TYPE, path, `Unknown type: ${id}`);
  }
}

function assertSettings(settings: Settings): void {
  const { search, defaults, first_placement: placement } = settings;
  search?.types?.forEach((id, i) => {
    assertKnownType(`search.types.${String(i)}`, id);
  });
  if (search?.filter !== undefined) {
    try {
      parseFilter(search.filter);
    } catch (err) {
      if (!(err instanceof MarfaError)) throw err;
      throw settingRefusal(
        ErrorCode.VALIDATION_ERROR,
        "search.filter",
        err.message,
      );
    }
  }
  if (search?.beneath !== undefined && !isValidId(search.beneath)) {
    throw settingRefusal(
      ErrorCode.VALIDATION_ERROR,
      "search.beneath",
      `Invalid item id: ${search.beneath}`,
    );
  }
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

/** Asks the type map alone: `checkTypeAccess` fences `system.*` writes off from every key. */
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
      "The credential's type map does not grant write on `system.folder`.",
  },
};

const notFound = {
  404: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["item_not_found"]),
      },
    },
    description: "No `system.folder` has this id.",
  },
};

const SETTING_REFUSAL =
  "A setting is malformed, `details.errors[0].path` naming it: `unknown_type` for a well-formed type nothing registered, `validation_error` for anything else, a `system.*` type among it.";

const createRefusal = {
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
    description: SETTING_REFUSAL,
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
        ]),
      },
    },
    description: `${SETTING_REFUSAL} \`validation_error\` is also a query parameter, such as \`conflict\`, which this door does not take. \`invalid_id\`: the id is malformed. \`invalid_transition\`: the folder is revoked.`,
  },
};

const createFolderRoute = createRoute({
  operationId: "createFolder",
  method: "post",
  path: "/",
  tags: ["Folders"],
  summary: "Create a folder",
  description:
    "Creates a `system.folder` item holding a folder's settings and publishes it as `item.created`. Needs write on `system.folder` in the credential's type map. Each setting is validated before the write.",
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
      description: "Folder created",
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
    "Changes the settings named in the body, each replaced whole, and publishes the folder as `item.updated`. `version` is required: at a stale version a change to a setting nobody changed since merges.",
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
      description: "Folder changed",
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
        "`version_conflict`: a setting this change names was changed since `version`. `conflicting_fields` names it. `ancestor_unavailable`: no snapshot of `version` is held.",
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
    "Moves the folder to `revoked`, its terminal state, stamps `revoked_at`, and publishes it as `item.state_changed`. Items placed in it keep their `in-folder` edges.",
  security: [{ bearerAuth: [] }],
  middleware: writesFolders,
  request: { params: IdParam },
  responses: {
    200: {
      content: { "application/json": { schema: ItemWithMetadataSchema } },
      description: "Folder revoked",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id", "invalid_transition"]),
        },
      },
      description:
        "`invalid_id`: the id is malformed. `invalid_transition`: the folder is already revoked.",
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
    const credential = c.get("apiKey");
    const { item, metadata } = await runAuditedTransaction(
      storage,
      () =>
        writeItem(
          storage,
          { kind: "platform" },
          {
            op: "create",
            type: FOLDER_TYPE,
            properties: body,
            source: itemProvenanceSource(credential),
            blob_proof: requestBlobProof(c, storage),
          },
        ),
      ({ item }) => ({
        client_ip: c.get("clientIp") ?? null,
        key_id: credential?.id,
        action: "folder.create",
        resource_type: "item",
        resource_id: item.id,
      }),
    );

    rememberItemSubject(item, "write", true);
    return c.json(
      { item, metadata: readableMetadata(metadata, credential) },
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
        const folder = await requireFolder(storage, id);
        rememberItemSubject(folder, "write", true);
        refuseRevoked(folder);
        return await writeItem(
          storage,
          { kind: "platform" },
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
        const folder = await requireFolder(storage, id);
        rememberItemSubject(folder, "write", true);
        refuseRevoked(folder);
        await writeItem(
          storage,
          { kind: "platform" },
          {
            op: "update",
            id,
            properties: { revoked_at: new Date().toISOString() },
            blob_proof: requestBlobProof(c, storage),
          },
          { announce: false },
        );
        const { item: revoked } = await writeItem(
          storage,
          { kind: "platform" },
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
