import type { McpServer } from "@modelcontextprotocol/server";
import type { components } from "@withmarfa/client";
import * as z from "zod";
import { itemId } from "../args.js";
import type { ToolContext } from "../context.js";
import { fail, ok, refused } from "../results.js";

type ItemWithMetadata = components["schemas"]["ItemWithMetadata"];

const query = z
  .looseObject({
    types: z.array(z.string()).optional(),
    filter: z.string().optional(),
    state: z.array(z.enum(["active", "archived"])).optional(),
  })
  .describe(
    "Which items the view lists: types, a filter expression as marfa_find takes, state, tier or beneath (an item ID).",
  );

const sort = z
  .array(
    z.strictObject({
      by: z.string().min(1).describe("A field, such as `properties.due`."),
      direction: z.enum(["asc", "desc"]),
    }),
  )
  .describe("The keys the view sorts by, first key first.");

const group = z
  .looseObject({ by: z.string().min(1) })
  .nullable()
  .describe(
    'How the view groups items, such as {"by": "properties.status"}; null removes the grouping.',
  );

const outputSchema = z.object({
  id: z.string(),
  version: z.number(),
  title: z.string().optional(),
  query: z.looseObject({}).optional(),
  sort: z.array(z.looseObject({})).optional(),
  group: z.looseObject({}).nullable().optional(),
});

function viewOf(saved: ItemWithMetadata) {
  const properties = saved.item.properties;
  return {
    id: saved.item.id,
    version: saved.item.version,
    ...(typeof properties.title === "string" && { title: properties.title }),
    ...(properties.query !== undefined && {
      query: properties.query as Record<string, unknown>,
    }),
    ...(Array.isArray(properties.sort) && {
      sort: properties.sort as Record<string, unknown>[],
    }),
    ...(properties.group !== undefined && {
      group: properties.group as Record<string, unknown> | null,
    }),
  };
}

export function registerSaveView(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_save_view",
    {
      title: "Save a view",
      description:
        "Use to make a saved view: a named list of items with a query, sort and grouping, which marfa_find lists with view. With id, changes a view: each setting you send replaces the current one.",
      inputSchema: z.strictObject({
        id: itemId
          .optional()
          .describe("The view to change. Leave out to make one."),
        version: z
          .number()
          .int()
          .optional()
          .describe(
            "The version of the view you read. Required to change one.",
          ),
        title: z
          .string()
          .min(1)
          .optional()
          .describe("Required to make a view."),
        query: query.optional(),
        sort: sort.optional(),
        group: group.optional(),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, version, title, query, sort, group }) => {
      if (id === undefined) {
        if (title === undefined) {
          return fail({
            code: "missing_required_field",
            message: "A new view needs a title.",
          });
        }
        const answer = await ctx.api.answer(
          ctx.api.client.POST("/views", {
            body: {
              title,
              ...(query !== undefined && { query }),
              ...(sort !== undefined && { sort }),
              ...(group != null && { group }),
            },
          }),
        );
        if (!answer.ok) return refused(answer.refusal);
        return ok(viewOf(answer.data));
      }
      if (version === undefined) {
        return fail({
          code: "missing_required_field",
          message: "Send the version of the view you read.",
          hint: "Find the view with marfa_get to read its version.",
        });
      }
      const answer = await ctx.api.answer(
        ctx.api.client.PATCH("/views/{id}", {
          params: { path: { id } },
          body: {
            version,
            ...(title !== undefined && { title }),
            ...(query !== undefined && { query }),
            ...(sort !== undefined && { sort }),
            ...(group !== undefined && { group }),
          },
        }),
      );
      if (!answer.ok) return refused(answer.refusal);
      return ok(viewOf(answer.data));
    },
  );
}
