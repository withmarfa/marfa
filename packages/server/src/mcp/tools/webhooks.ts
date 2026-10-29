import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { itemId } from "../args.js";
import type { ToolContext } from "../context.js";
import { ANSWER_BUDGET_CHARS, fail, fitList, ok, refused } from "../results.js";

const EVENTS = [
  "item.created",
  "item.updated",
  "item.deleted",
  "item.restored",
  "item.purged",
  "item.state_changed",
  "metadata.changed",
  "edge.created",
  "edge.updated",
  "edge.deleted",
] as const;

const webhookShape = z.looseObject({ id: z.string(), url: z.string() });

export function registerWebhooks(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_webhooks",
    {
      title: "List webhooks",
      description:
        "Use to see the webhooks this credential made: where each sends events, which events, and whether it is active.",
      inputSchema: z.strictObject({}),
      outputSchema: z.object({
        webhooks: z.array(webhookShape),
        left_out: z.number().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const answer = await ctx.api.answer(ctx.api.client.GET("/webhooks"));
      if (!answer.ok) return refused(answer.refusal);
      const fitted = fitList(answer.data.data, ANSWER_BUDGET_CHARS - 200);
      return ok({
        webhooks: fitted.kept,
        ...(fitted.left_out > 0 && { left_out: fitted.left_out }),
      });
    },
  );
}

export function registerManageWebhook(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "marfa_manage_webhook",
    {
      title: "Make, change or delete a webhook",
      description:
        "Use to have Marfa post events, such as new items, to a web address, or to change or delete such a webhook. Making one returns the secret that signs each delivery, once.",
      inputSchema: z.strictObject({
        action: z.enum(["make", "change", "delete"]),
        id: itemId.optional().describe("The webhook to change or delete."),
        url: z
          .string()
          .min(1)
          .optional()
          .describe("A public http or https address. Required to make one."),
        events: z
          .array(z.enum(EVENTS))
          .min(1)
          .optional()
          .describe("The events to send. Required to make one."),
        type_filter: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "Send item events only for this type or pattern, such as `app.*`; null sends every type.",
          ),
        active: z
          .boolean()
          .optional()
          .describe("`false` pauses it. Only to change one."),
      }),
      outputSchema: z.object({
        webhook: webhookShape.optional(),
        deleted: z.string().optional(),
        next: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ action, id, url, events, type_filter, active }) => {
      if (action === "make") {
        if (url === undefined || events === undefined) {
          return fail({
            code: "missing_required_field",
            message: "A new webhook needs a url and events.",
          });
        }
        const answer = await ctx.api.answer(
          ctx.api.client.POST("/webhooks", {
            body: {
              url,
              events,
              ...(type_filter !== undefined && { type_filter }),
            },
          }),
        );
        if (!answer.ok) return refused(answer.refusal);
        return ok({
          webhook: answer.data,
          next: "Give the secret to whoever receives the deliveries now: Marfa never shows it again.",
        });
      }
      if (id === undefined) {
        return fail({
          code: "missing_required_field",
          message: "Name the webhook with id.",
        });
      }
      if (action === "delete") {
        const answer = await ctx.api.answer(
          ctx.api.client.DELETE("/webhooks/{id}", {
            params: { path: { id } },
          }),
        );
        if (!answer.ok) return refused(answer.refusal);
        return ok({ deleted: id });
      }
      const answer = await ctx.api.answer(
        ctx.api.client.PATCH("/webhooks/{id}", {
          params: { path: { id } },
          body: {
            ...(url !== undefined && { url }),
            ...(events !== undefined && { events }),
            ...(type_filter !== undefined && { type_filter }),
            ...(active !== undefined && { active }),
          },
        }),
      );
      if (!answer.ok) return refused(answer.refusal);
      return ok({ webhook: answer.data });
    },
  );
}
