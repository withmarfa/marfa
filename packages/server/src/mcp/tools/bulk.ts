import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { itemId } from "../args.js";
import type { ToolContext } from "../context.js";
import { ANSWER_BUDGET_CHARS, fitList, ok, refused } from "../results.js";

export const BULK_MAX_ITEMS = 200;

const entry = z.strictObject({
  type: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).optional(),
  source_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The item's ID in the place it came from, so saving it again finds the same item.",
    ),
  id: itemId.optional(),
  version: z
    .number()
    .int()
    .optional()
    .describe(
      "The version you read, to update an item only if it is unchanged.",
    ),
  tags: z.array(z.string().min(1)).optional(),
  tier: z.enum(["library", "feed"]).optional(),
  occurred_at: z.string().optional(),
});

const outputSchema = z.object({
  counts: z.record(z.string(), z.number()),
  results: z.array(z.looseObject({ index: z.number(), outcome: z.string() })),
  left_out: z.number().optional(),
  next: z.string().optional(),
});

export function registerBulkSave(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_bulk_save",
    {
      title: "Save many items at once",
      description: `Use to save many items in one call, at most ${String(BULK_MAX_ITEMS)}, such as an import. By default it only creates: an entry whose source_id or id is saved already is skipped. With mode upsert, it updates those items instead.`,
      inputSchema: z.strictObject({
        items: z.array(entry).min(1).max(BULK_MAX_ITEMS),
        mode: z
          .enum(["create_only", "upsert"])
          .default("create_only")
          .describe("`create_only` skips saved items; `upsert` updates them."),
        atomic: z
          .boolean()
          .default(true)
          .describe(
            "`true` saves nothing if any entry fails; `false` saves the rest.",
          ),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ items, mode, atomic }) => {
      const answer = await ctx.api.answer(
        ctx.api.client.POST("/items/bulk", {
          body: { items, mode, atomic },
        }),
      );
      if (!answer.ok) return refused(answer.refusal);
      const results = fitList(answer.data.results, ANSWER_BUDGET_CHARS - 500);
      return ok({
        counts: answer.data.counts,
        results: results.kept,
        ...(results.left_out > 0 && {
          left_out: results.left_out,
          next: "Some results are left out; counts covers every entry.",
        }),
      });
    },
  );
}
