import type { McpServer } from "@modelcontextprotocol/server";
import type { components } from "@withmarfa/client";
import { itemName } from "@withmarfa/shared";
import { itemId } from "../args.js";
import * as z from "zod";
import type { ApiRefusal } from "../api.js";
import {
  checkConfirmation,
  confirmationToken,
  staleConfirmation,
} from "../confirm.js";
import type { ToolContext } from "../context.js";
import { fail, ok, refused } from "../results.js";

export const DELETE_MAX_IDS = 20;

const previewItem = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string().optional(),
  version: z.number(),
  also_trashes: z.array(z.object({ id: z.string(), type: z.string() })),
  count: z
    .number()
    .describe(
      "How many items trashing it moves to the trash, itself included.",
    ),
  truncated: z.boolean().optional(),
});

const outputSchema = z.object({
  preview: z.array(previewItem).optional(),
  total: z.number().optional(),
  confirm: z.string().optional(),
  expires_at: z.string().optional(),
  next: z.string().optional(),
  trashed: z.array(z.string()).optional(),
});

type TrashPreview = components["schemas"]["TrashPreview"];

async function previewOf(
  ctx: ToolContext,
  ids: string[],
): Promise<
  { ok: true; preview: TrashPreview } | { ok: false; refusal: ApiRefusal }
> {
  const answer = await ctx.api.answer(
    ctx.api.client.POST("/items/trash-preview", { body: { ids } }),
  );
  return answer.ok
    ? { ok: true, preview: answer.data }
    : { ok: false, refusal: answer.refusal };
}

async function titles(
  ctx: ToolContext,
  ids: string[],
): Promise<Map<string, string>> {
  const answer = await ctx.api.answer(
    ctx.api.client.POST("/items/bulk-get", { body: { ids } }),
  );
  const found = new Map<string, string>();
  if (!answer.ok) return found;
  for (const item of answer.data.items) {
    found.set(item.id, itemName(item.properties));
  }
  return found;
}

export function registerDelete(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_delete",
    {
      title: "Move items to the trash",
      description:
        "Use to delete notes, tasks, records, files or other items, which moves them to the trash. The first call only previews what would go, including items that go with them. Show the person and ask; only if they agree, call again with the same ids and confirm. Restore with marfa_update.",
      inputSchema: z.strictObject({
        ids: z
          .array(itemId)
          .min(1)
          .max(DELETE_MAX_IDS)
          .describe(`The items' IDs, at most ${String(DELETE_MAX_IDS)}.`),
        confirm: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The confirm token from the preview. Leave out to preview.",
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
    async ({ ids, confirm }) => {
      const scope = { tool: "marfa_delete", credential: ctx.credentialHandle };
      const unique = [...new Set(ids)];
      const previewed = await previewOf(ctx, unique);
      if (!previewed.ok) return refused(previewed.refusal);
      const { preview } = previewed;
      // The named items and the preview's digest of everything their trash
      // takes, with versions, so an edit or a change in what goes with them
      // refuses the token.
      const subject = { ids: [...unique].sort(), digest: preview.digest };

      const previewAnswer = async (
        extra: { code: string; message: string } | null,
      ) => {
        const names = await titles(ctx, unique);
        const token = confirmationToken(
          ctx.confirmKey,
          scope,
          subject,
          ctx.now(),
        );
        const body = {
          preview: preview.items.map((p) => {
            const title = names.get(p.id);
            return {
              id: p.id,
              type: p.type,
              ...(title !== undefined && { title }),
              version: p.version,
              also_trashes: p.takes.map((item) => ({
                id: item.id,
                type: item.type,
              })),
              count: p.count,
              ...(p.truncated === true && { truncated: true }),
            };
          }),
          total: preview.count,
          confirm: token.token,
          expires_at: token.expires_at,
          next: "Nothing has been deleted. Show the person what would go to the trash and ask them; only if they agree, call marfa_delete again with the same ids and confirm.",
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
      if (check !== "valid") {
        return previewAnswer(staleConfirmation(check, "Nothing was deleted"));
      }

      // One trash of every named item, on the digest the check just passed,
      // so a change landing after the check trashes nothing.
      const answer = await ctx.api.answer(
        ctx.api.client.POST("/items/trash", {
          body: { ids: unique, digest: preview.digest },
        }),
      );
      if (!answer.ok) return refused(answer.refusal);
      return ok({
        trashed: unique,
        total: preview.count,
        next: "Moved to the trash. Restore an item with marfa_update and state active.",
      });
    },
  );
}
