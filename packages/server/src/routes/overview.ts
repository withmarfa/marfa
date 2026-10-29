import { createRoute, z } from "@hono/zod-openapi";
import {
  PERMISSIONS,
  edgePermissionCovers,
  hasPermission,
  isSystemType,
  listEdgeTypes,
  listTypes,
  resolveEnforcement,
} from "@withmarfa/shared";
import type { Item } from "@withmarfa/shared";
import type { Context } from "hono";
import { displayTitle } from "../folder-inventory.js";
import { readInstanceName } from "../instance-name.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  computeTypeFilter,
  heldPermissions,
  mayReadType,
  requireAuth,
} from "../middleware/auth.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { ItemFilters, Storage } from "../storage/interface.js";
import { PermissionEnum, PermissionLevelEnum } from "./_schemas.js";
import { TagWithCountSchema } from "./metadata.js";

const VIEW_TYPE = "system.view";
const FOLDER_TYPE = "system.folder";

/** How many entries each list of the answer holds before it is cut. */
export const OVERVIEW_CAPS = {
  types: 50,
  edge_types: 50,
  tags: 30,
  views: 30,
  folders: 30,
  type_permissions: 30,
} as const;

/** The longest description or title the answer carries, in characters. */
export const OVERVIEW_TEXT_CAP = 100;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const InstanceSchema = z
  .object({
    name: z.string().describe("The instance's display name."),
    build: z.string().describe("The build the instance runs."),
    release: z
      .string()
      .optional()
      .describe(
        "The release the build was made as. Absent for a build that is not a release.",
      ),
  })
  .describe("The instance's name and the build it runs.");

const TypeEntrySchema = z
  .object({
    id: z
      .string()
      .describe("The type's identifier.")
      .openapi({ example: "core.note" }),
    description: z
      .string()
      .optional()
      .describe(
        `What the type holds, cut at ${String(OVERVIEW_TEXT_CAP)} characters. Absent when the type has none.`,
      ),
    count: z
      .number()
      .int()
      .describe("How many active items of the type you can read."),
  })
  .describe("A type you can read, and how many active items it has.")
  .openapi("OverviewType");

const EdgeTypeEntrySchema = z
  .object({
    id: z
      .string()
      .describe("The edge type's identifier.")
      .openapi({ example: "parent-of" }),
    description: z
      .string()
      .optional()
      .describe(
        `What the edge type means, cut at ${String(OVERVIEW_TEXT_CAP)} characters. Absent when it has none.`,
      ),
    access: PermissionLevelEnum.describe(
      "`write` where your edge permissions cover writing edges of the type, otherwise `read`. Creating an edge also needs write access to the type of its source item.",
    ),
  })
  .describe("An edge type your edge permissions cover, and at which level.")
  .openapi("OverviewEdgeType");

const NamedEntrySchema = (name: string, noun: string) =>
  z
    .object({
      id: z
        .string()
        .describe(`The ID of the ${noun}.`)
        .openapi({ example: "019537a0-7b80-7000-8000-000000000000" }),
      title: z
        .string()
        .describe(
          `The ${noun}'s title, cut at ${String(OVERVIEW_TEXT_CAP)} characters.`,
        ),
    })
    .describe(`A ${noun} you can read.`)
    .openapi(name);

const ViewEntrySchema = NamedEntrySchema("OverviewView", "view");
const FolderEntrySchema = NamedEntrySchema("OverviewFolder", "folder");

const CredentialSchema = z
  .object({
    kind: z
      .enum(["key", "app"])
      .describe("`key` for an API key, `app` for a signed-in app's token."),
    label: z
      .string()
      .optional()
      .describe("The key's label. Absent for an app."),
    type_permissions: z
      .object({
        write: z
          .array(z.string())
          .optional()
          .describe(
            "Type patterns you can read and write, such as `core.*`. Absent when none.",
          ),
        read: z
          .array(z.string())
          .optional()
          .describe("Type patterns you can only read. Absent when none."),
        none: z
          .array(z.string())
          .optional()
          .describe(
            "Type patterns denied even where a wider pattern grants access. Absent when none.",
          ),
      })
      .optional()
      .describe(
        `Your type map by level, each list sorted and cut at ${String(OVERVIEW_CAPS.type_permissions)} patterns. Absent when the map is empty.`,
      ),
    permissions: z
      .array(PermissionEnum)
      .optional()
      .describe("The permissions you hold. Absent when you hold none."),
  })
  .describe("The credential that sent the request, and what it may do.");

const OverviewSchema = z
  .object({
    instance: InstanceSchema,
    credential: CredentialSchema,
    types: z
      .array(TypeEntrySchema)
      .optional()
      .describe(
        `The types you can read, most items first, then by identifier, at most ${String(OVERVIEW_CAPS.types)}. Types in the \`system\` namespace are left out. Absent when you can read none.`,
      ),
    edge_types: z
      .array(EdgeTypeEntrySchema)
      .optional()
      .describe(
        `The edge types you can read or write, sorted by identifier, at most ${String(OVERVIEW_CAPS.edge_types)}. Absent when you can use none.`,
      ),
    tags: z
      .array(TagWithCountSchema)
      .optional()
      .describe(
        `The most used tags on items you can read, at most ${String(OVERVIEW_CAPS.tags)}. Absent when there are none.`,
      ),
    views: z
      .array(ViewEntrySchema)
      .optional()
      .describe(
        `The views you can read, sorted by title, at most ${String(OVERVIEW_CAPS.views)}. Absent when there are none.`,
      ),
    folders: z
      .array(FolderEntrySchema)
      .optional()
      .describe(
        `The folders you can read, sorted by title, at most ${String(OVERVIEW_CAPS.folders)}. Absent when there are none.`,
      ),
    truncated: z
      .record(z.string(), z.number().int())
      .optional()
      .describe(
        "Each list that was cut, with how many entries it held before the cut. Names are `types`, `edge_types`, `tags`, `views`, `folders` and `credential.type_permissions.<level>`. Absent when nothing was cut.",
      ),
  })
  .describe(
    "A summary of what this instance holds and what your credential may reach.",
  )
  .openapi("Overview", {
    example: {
      instance: { name: "Marfa", build: "dev" },
      credential: {
        kind: "key",
        label: "Notes agent",
        type_permissions: { write: ["core.note"], read: ["*"] },
        permissions: ["audit.read"],
      },
      types: [
        {
          id: "core.note",
          description: "A piece of writing.",
          count: 128,
        },
      ],
      edge_types: [{ id: "references", access: "write" }],
      tags: [{ tag: "work", count: 40 }],
      views: [
        {
          id: "019537a0-7b80-7000-8000-000000000000",
          title: "Reading list",
        },
      ],
    },
  });

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const getOverviewRoute = createRoute({
  operationId: "getOverview",
  method: "get",
  path: "/",
  tags: ["Instance"],
  summary: "Get an overview",
  description:
    "Returns what the instance holds that your credential can reach: types with item counts, edge types, top tags, views and folders, and what your credential may do. Every list is capped. Needs no type access.",
  security: [{ bearerAuth: [] }],
  request: {},
  responses: {
    200: {
      content: { "application/json": { schema: OverviewSchema } },
      description:
        "Returns the overview. A credential that reaches nothing gets the instance and credential only.",
    },
    401: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["unauthorized"]),
        },
      },
      description: "Unauthorized",
    },
  },
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** `text` cut to `OVERVIEW_TEXT_CAP` characters, ending in an ellipsis. */
function clip(text: string): string {
  const characters = Array.from(text);
  return characters.length > OVERVIEW_TEXT_CAP
    ? `${characters.slice(0, OVERVIEW_TEXT_CAP - 1).join("")}…`
    : text;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The first `cap` of `rows`, recording in `truncated` what the list held
 *  when it was cut. */
function capped<T>(
  rows: readonly T[],
  cap: number,
  name: string,
  truncated: Record<string, number>,
  total: number = rows.length,
): T[] {
  if (total > cap) truncated[name] = total;
  return rows.slice(0, cap);
}

function credentialOf(
  c: Context<AppEnv>,
  truncated: Record<string, number>,
): z.infer<typeof CredentialSchema> {
  const key = requireAuth(c);
  const levels: Record<"write" | "read" | "none", string[]> = {
    write: [],
    read: [],
    none: [],
  };
  for (const [pattern, level] of Object.entries(key.type_permissions)) {
    // A stored level other than `read` or `write` denies, as the resolver
    // reads it.
    levels[level === "write" || level === "read" ? level : "none"].push(
      pattern,
    );
  }
  const typePermissions: Record<string, string[]> = {};
  for (const level of ["write", "read", "none"] as const) {
    if (levels[level].length === 0) continue;
    typePermissions[level] = capped(
      levels[level].sort(),
      OVERVIEW_CAPS.type_permissions,
      `credential.type_permissions.${level}`,
      truncated,
    );
  }
  const app = c.get("authType") === "oauth";
  const held = heldPermissions(c);
  const permissions = PERMISSIONS.filter((permission) =>
    hasPermission(held, permission),
  );
  return {
    kind: app ? "app" : "key",
    ...(!app && { label: key.label }),
    ...(Object.keys(typePermissions).length > 0 && {
      type_permissions: typePermissions,
    }),
    ...(permissions.length > 0 && { permissions }),
  };
}

interface Reads {
  name: string;
  counts: Record<string, number>;
  tags: { tag: string; count: number }[];
  views: Item[];
  folders: Item[];
}

export interface DeployedBuild {
  version: string;
  release?: string | undefined;
}

export function overviewRoutes(storage: Storage, build: DeployedBuild) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(getOverviewRoute, async (c) => {
    const key = requireAuth(c);
    const truncated: Record<string, number> = {};
    const credential = credentialOf(c, truncated);
    const { allowed, excluded } = computeTypeFilter(key);
    // Taken once, ahead of the reads: a type registered or deleted while they
    // run changes nothing here, and a deleted one is read only from this copy.
    const registered = listTypes();
    const edgeTypes = listEdgeTypes();

    const reads = await storage.runInReadSnapshot(
      async (): Promise<Reads> => {
        const name = await readInstanceName(storage.settings);
        // A credential whose map reaches no type reads nothing, and asking
        // the stores with an empty allow-list is how a filter drops out.
        if (allowed?.length === 0) {
          return { name, counts: {}, tags: [], views: [], folders: [] };
        }
        const { source_filter } = resolveEnforcement(
          await readInstanceConfig(storage.settings),
          key,
        );
        const readable: ItemFilters = {
          state: "active",
          source_filter,
          allowed_types: allowed,
          excluded_types: excluded,
        };
        const counts = await storage.items.stats(readable, "type");
        const tags = await storage.metadata.listTags({
          allowedTypes: allowed,
          excludedTypes: excluded,
          source_filter,
        });
        const list = (type: string, cap: number) =>
          (counts[type] ?? 0) === 0
            ? Promise.resolve([])
            : storage.items
                .list({
                  ...readable,
                  type,
                  sort: "properties.title",
                  direction: "asc",
                  limit: cap,
                })
                .then((page) => page.data);
        return {
          name,
          counts,
          tags,
          views: await list(VIEW_TYPE, OVERVIEW_CAPS.views),
          folders: await list(FOLDER_TYPE, OVERVIEW_CAPS.folders),
        };
      },
      { signal: c.req.raw.signal },
    );

    const described = new Map(
      registered.map((schema) => [schema.id, schema.description]),
    );
    // Registered types the credential reads, and any type holding items that
    // the registry no longer names, so no counted item goes unreported.
    const typeIds = new Set<string>();
    for (const id of [...described.keys(), ...Object.keys(reads.counts)]) {
      if (!isSystemType(id) && mayReadType(key, id)) typeIds.add(id);
    }
    const types = [...typeIds]
      .map((id) => {
        const description = described.get(id);
        return {
          id,
          ...(description !== undefined &&
            description !== "" && { description: clip(description) }),
          count: reads.counts[id] ?? 0,
        };
      })
      .sort((a, b) => b.count - a.count || byId(a, b));

    const edgeEntries = edgeTypes
      .filter((edgeType) =>
        edgePermissionCovers(key.edge_permissions, edgeType.id, "read"),
      )
      .map((edgeType) => ({
        id: edgeType.id,
        ...(edgeType.description !== undefined &&
          edgeType.description !== "" && {
            description: clip(edgeType.description),
          }),
        access: edgePermissionCovers(key.edge_permissions, edgeType.id, "write")
          ? ("write" as const)
          : ("read" as const),
      }))
      .sort(byId);

    const { counts } = reads;
    const typeList = capped(types, OVERVIEW_CAPS.types, "types", truncated);
    const edgeList = capped(
      edgeEntries,
      OVERVIEW_CAPS.edge_types,
      "edge_types",
      truncated,
    );
    const tagList = capped(reads.tags, OVERVIEW_CAPS.tags, "tags", truncated);
    const viewList = capped(
      reads.views.map((item) => ({
        id: item.id,
        title: clip(displayTitle(item, "Untitled view")),
      })),
      OVERVIEW_CAPS.views,
      "views",
      truncated,
      counts[VIEW_TYPE] ?? 0,
    );
    const folderList = capped(
      reads.folders.map((item) => ({
        id: item.id,
        title: clip(displayTitle(item, "Untitled folder")),
      })),
      OVERVIEW_CAPS.folders,
      "folders",
      truncated,
      counts[FOLDER_TYPE] ?? 0,
    );

    return c.json(
      {
        instance: {
          name: reads.name,
          build: build.version,
          ...(build.release !== undefined && { release: build.release }),
        },
        credential,
        ...(typeList.length > 0 && { types: typeList }),
        ...(edgeList.length > 0 && { edge_types: edgeList }),
        ...(tagList.length > 0 && { tags: tagList }),
        ...(viewList.length > 0 && { views: viewList }),
        ...(folderList.length > 0 && { folders: folderList }),
        ...(Object.keys(truncated).length > 0 && { truncated }),
      },
      200,
    );
  });

  return router;
}
