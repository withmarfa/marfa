/**
 * Items by title, many names to a call.
 *
 *   POST /items/titles: names in, the items outside the bin titled by each.
 *
 * A device resolving the links of a folder asks here instead of listing the
 * whole instance once per name: the answer to a name is one lookup of the
 * folded title in an index, so it costs the same on a million items as on a
 * hundred.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { resolveEnforcement } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import { getTypeFilter, readsSomeType } from "../middleware/auth.js";
import { snapshotReadRoute } from "../middleware/read-snapshot.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { ItemFilters, Storage } from "../storage/interface.js";
import {
  foldName,
  MAX_NAME_UNITS,
  trimName,
} from "../storage/sqlite/title-keys.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

/** The names one call takes. */
const MAX_NAMES = 200;

/** The items one name answers with. */
const ITEMS_PER_NAME = 20;

const TitlesRequestSchema = z.strictObject({
  names: z
    .array(z.string().max(MAX_NAME_UNITS))
    .max(MAX_NAMES)
    .describe(
      `The titles to look for, at most ${String(MAX_NAMES)}, each at most ${String(MAX_NAME_UNITS)} UTF-16 code units. Case, Unicode form and surrounding white space do not matter.`,
    ),
});

const TitledItemSchema = z
  .object({
    id: z.string().describe("The item's ID."),
    type: z.string().describe("The item's type."),
    title: z
      .string()
      .describe(
        "The item's title as it is stored, which the caller can compare itself.",
      ),
    has_blob: z
      .boolean()
      .describe(
        "`true` if the item's `blob_ref` property holds a blob digest.",
      ),
  })
  .describe("An item whose title matches a name.")
  .openapi("TitledItem");

const TitlesResponseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string().describe("The name, as the request sent it."),
        items: z
          .array(TitledItemSchema)
          .describe(
            `The active and archived items you can read whose title matches the name, by ID, at most ${String(ITEMS_PER_NAME)}.`,
          ),
        more: z
          .boolean()
          .describe(
            `\`true\` if more than ${String(ITEMS_PER_NAME)} items match and \`items\` holds the first ${String(ITEMS_PER_NAME)}.`,
          ),
      }),
    )
    .describe("One result for each name, in the order the request named them."),
});

const titlesRoute = createRoute({
  method: "post",
  path: "/titles",
  operationId: "findItemsByTitle",
  tags: ["Items"],
  summary: "Find items by title",
  description:
    "Finds the active and archived items titled by each of up to 200 names, matched without regard to case, Unicode form or the white space around a name. `system.*` items and items you can't read are left out.",
  security: [{ bearerAuth: [] }],
  middleware: readsSomeType,
  request: {
    body: {
      content: { "application/json": { schema: TitlesRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: TitlesResponseSchema } },
      description:
        "Returns one result for each name. A name matching nothing, or empty after trimming, has no items.",
    },
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema([
            "missing_required_field",
            "validation_error",
          ]),
        },
      },
      description:
        "- `missing_required_field`: `names` is missing.\n- `validation_error`: `names` is not a list of strings, has more than 200 names, has a name longer than 1,000 UTF-16 code units, or the body has a field this endpoint doesn't take.",
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
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description:
        "- `type_not_permitted`: your credential reaches no type. If it reaches some types, items of the others are left out instead.",
    },
  },
});

export function itemsTitlesRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();

  router.openapi(snapshotReadRoute(storage, titlesRoute), async (c) => {
    const { names } = c.req.valid("json");
    // The scope of a listing that names no filter: the types the key reads,
    // and the source filter the instance holds for it.
    const typeFilter = getTypeFilter(c);
    const enforcement = resolveEnforcement(
      await readInstanceConfig(storage.settings),
      c.get("apiKey"),
    );
    const filters: ItemFilters = {
      states: ["active", "archived"],
      exclude_system_types: true,
      source_filter: enforcement.source_filter,
      readable_sources: typeFilter,
      allowed_types: typeFilter.allowed,
      excluded_types: typeFilter.excluded,
    };
    const keys = names.map((name) =>
      trimName(name) === "" ? undefined : foldName(name),
    );
    const found = await storage.items.titled(
      keys.filter((key): key is string => key !== undefined),
      filters,
      ITEMS_PER_NAME,
    );
    return c.json(
      {
        results: names.map((name, at) => {
          const key = keys[at];
          const answer = key === undefined ? undefined : found.get(key);
          return {
            name,
            items: answer?.items ?? [],
            more: answer?.more ?? false,
          };
        }),
      },
      200,
    );
  });

  return router;
}
