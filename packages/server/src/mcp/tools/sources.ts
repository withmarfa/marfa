import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { SIGN_IN_NAME_MAX } from "../../auth/sign-in-names.js";
import { SOURCE_CODE_MAX } from "../../auth/source-codes.js";
import type { ToolContext } from "../context.js";
import { ANSWER_BUDGET_CHARS, fail, fitList, ok, refused } from "../results.js";

const sourceCode = z
  .string()
  .min(1)
  .max(SOURCE_CODE_MAX)
  .describe("A source code, such as `github`.");

const sourceShape = z.looseObject({ source: z.string(), name: z.string() });

export function registerSources(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_sources",
    {
      title: "List sources",
      description:
        "Use to name where items came from: each source code's name and mark (an icon ID). With source, reads one.",
      inputSchema: z.strictObject({ source: sourceCode.optional() }),
      outputSchema: z.object({
        sources: z.array(sourceShape),
        left_out: z.number().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ source }) => {
      if (source !== undefined) {
        const answer = await ctx.api.answer(
          ctx.api.client.GET("/source", { params: { query: { source } } }),
        );
        if (!answer.ok) return refused(answer.refusal);
        return ok({ sources: [answer.data] });
      }
      const answer = await ctx.api.answer(ctx.api.client.GET("/sources"));
      if (!answer.ok) return refused(answer.refusal);
      const fitted = fitList(answer.data.data, ANSWER_BUDGET_CHARS - 200);
      return ok({
        sources: fitted.kept,
        ...(fitted.left_out > 0 && { left_out: fitted.left_out }),
      });
    },
  );
}

export function registerNameSource(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_name_source",
    {
      title: "Name a source",
      description:
        "Use to set the name and mark a source is shown by: your own, one you claim, or any with keys.manage. null clears a field.",
      inputSchema: z.strictObject({
        source: sourceCode,
        name: z
          .string()
          .min(1)
          .max(SIGN_IN_NAME_MAX)
          .nullable()
          .optional()
          .describe("Such as `GitHub`."),
        mark: z
          .string()
          .nullable()
          .optional()
          .describe("An icon ID, such as `simple-icons:github`."),
      }),
      outputSchema: sourceShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ source, name, mark }) => {
      if (name === undefined && mark === undefined) {
        return fail({
          code: "missing_required_field",
          message: "Send a name, a mark or both.",
        });
      }
      const answer = await ctx.api.answer(
        ctx.api.client.PATCH("/source", {
          params: { query: { source } },
          body: {
            ...(name !== undefined && { name }),
            ...(mark !== undefined && { mark }),
          },
        }),
      );
      if (!answer.ok) return refused(answer.refusal);
      return ok(answer.data);
    },
  );
}
