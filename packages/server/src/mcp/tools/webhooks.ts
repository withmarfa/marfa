import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { WEBHOOK_EVENTS } from "../../routes/webhooks.js";
import { itemId } from "../args.js";
import {
  checkConfirmation,
  confirmationToken,
  staleConfirmation,
} from "../confirm.js";
import type { ToolContext } from "../context.js";
import { ANSWER_BUDGET_CHARS, fail, fitList, ok, refused } from "../results.js";

const webhookShape = z.looseObject({ id: z.string(), url: z.string() });

/** Where a webhook would send what, as its preview shows and its token covers. */
interface WebhookPlan {
  action: "make" | "change";
  id: string | null;
  url: string;
  events: string[];
  type_filter: string | null;
  active: boolean | null;
}

const SENDS =
  "Each event it names, signed with the webhook's secret. An item event carries the whole item after the change, as this credential can read it; metadata.changed also carries the item's tags and the extensions this credential can read; an edge event carries the edge.";

function previewOf(plan: WebhookPlan, host: string) {
  return {
    ...(plan.id !== null && { id: plan.id }),
    url: plan.url,
    host,
    events: plan.events,
    type_filter: plan.type_filter,
    ...(plan.active !== null && { active: plan.active }),
    sends: `${SENDS} Everything is posted to ${host}, outside Marfa.`,
  };
}

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
        "Use to have Marfa post events, such as new items, to a web address, or to change or delete such a webhook. Making one, or changing where one posts or what it sends, first previews what would leave Marfa: show the person, and call again with the same arguments and confirm. Making one returns the secret that signs each delivery, once. Pausing or deleting one takes one call.",
      inputSchema: z.strictObject({
        action: z.enum(["make", "change", "delete"]),
        id: itemId.optional().describe("The webhook to change or delete."),
        url: z
          .string()
          .min(1)
          .optional()
          .describe("A public http or https address. Required to make one."),
        events: z
          .array(z.enum(WEBHOOK_EVENTS))
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
        confirm: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The confirm token from the preview. Leave out to preview.",
          ),
      }),
      outputSchema: z.object({
        preview: z.looseObject({ url: z.string() }).optional(),
        confirm: z.string().optional(),
        expires_at: z.string().optional(),
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
    async ({ action, id, url, events, type_filter, active, confirm }) => {
      const scope = {
        tool: "marfa_manage_webhook",
        credential: ctx.credentialHandle,
      };
      // A preview, or the write it previewed once the token is this
      // preview's: what leaves Marfa, and where to, is agreed to first.
      const confirmed = (plan: WebhookPlan) => {
        let host: string;
        try {
          host = new URL(plan.url).host;
        } catch {
          return fail({
            code: "validation_error",
            message: "url is not a web address.",
          });
        }
        const subject = { ...plan, events: [...plan.events].sort() };
        const previewAnswer = (
          extra: { code: string; message: string } | null,
        ) => {
          const token = confirmationToken(
            ctx.confirmKey,
            scope,
            subject,
            ctx.now(),
          );
          const body = {
            preview: previewOf(plan, host),
            confirm: token.token,
            expires_at: token.expires_at,
            next: `Nothing has ${plan.action === "make" ? "been made" : "changed"}. Show the person where this sends what, and call again with the same arguments and confirm once they agree.`,
          };
          return extra === null ? ok(body) : fail({ ...extra, ...body });
        };
        if (confirm === undefined) return previewAnswer(null);
        const check = checkConfirmation(
          ctx.confirmKey,
          scope,
          subject,
          confirm,
          ctx.now(),
        );
        if (check === "valid") return null;
        return previewAnswer(
          staleConfirmation(
            check,
            plan.action === "make" ? "Nothing was made" : "Nothing changed",
          ),
        );
      };

      if (action === "make") {
        if (url === undefined || events === undefined) {
          return fail({
            code: "missing_required_field",
            message: "A new webhook needs a url and events.",
          });
        }
        const held = confirmed({
          action,
          id: null,
          url,
          events,
          type_filter: type_filter ?? null,
          active: null,
        });
        if (held !== null) return held;
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
      if (
        url === undefined &&
        events === undefined &&
        type_filter === undefined
      ) {
        const answer = await ctx.api.answer(
          ctx.api.client.PATCH("/webhooks/{id}", {
            params: { path: { id } },
            body: { ...(active !== undefined && { active }) },
          }),
        );
        if (!answer.ok) return refused(answer.refusal);
        return ok({ webhook: answer.data });
      }
      const current = await ctx.api.answer(
        ctx.api.client.GET("/webhooks/{id}", { params: { path: { id } } }),
      );
      if (!current.ok) return refused(current.refusal);
      const plan: WebhookPlan = {
        action,
        id,
        url: url ?? current.data.url,
        events: events ?? current.data.events,
        type_filter:
          type_filter !== undefined
            ? type_filter
            : (current.data.type_filter ?? null),
        active: active ?? current.data.active,
      };
      const held = confirmed(plan);
      if (held !== null) return held;
      const answer = await ctx.api.answer(
        ctx.api.client.PATCH("/webhooks/{id}", {
          params: { path: { id } },
          body: {
            url: plan.url,
            events: plan.events as (typeof WEBHOOK_EVENTS)[number][],
            type_filter: plan.type_filter,
            active: plan.active ?? undefined,
          },
        }),
      );
      if (!answer.ok) return refused(answer.refusal);
      return ok({ webhook: answer.data });
    },
  );
}
