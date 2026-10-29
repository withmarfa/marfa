import type { McpServer } from "@modelcontextprotocol/server";
import type { components } from "@withmarfa/client";
import { itemName } from "@withmarfa/shared";
import { itemId } from "../args.js";
import * as z from "zod";
import type { ApiRefusal } from "../api.js";
import {
  checkConfirmation,
  confirmationToken,
  type PlannedDelete,
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

async function previewAll(
  ctx: ToolContext,
  ids: string[],
): Promise<
  | { ok: true; plan: PlannedDelete[]; previews: TrashPreview[] }
  | { ok: false; refusal: ApiRefusal; id: string }
> {
  const previews: TrashPreview[] = [];
  for (const id of ids) {
    const others = ids.filter((other) => other !== id);
    const answer = await ctx.api.answer(
      ctx.api.client.GET("/items/{id}/trash-preview", {
        params: {
          path: { id },
          query: others.length > 0 ? { check_ids: others.join(",") } : {},
        },
      }),
    );
    if (!answer.ok) return { ok: false, refusal: answer.refusal, id };
    previews.push(answer.data);
  }
  const plan = previews.map((preview) => ({
    id: preview.id,
    version: preview.version,
    count: preview.count,
    digest: preview.digest,
    takes: preview.taken_ids ?? [],
  }));
  return { ok: true, plan, previews };
}

/**
 * How many items the plan trashes. A named item that goes with another
 * named item is counted once, in the other's count.
 */
function totalOf(plan: readonly PlannedDelete[]): number {
  const carried = new Set(plan.flatMap((root) => root.takes));
  return plan
    .filter((root) => !carried.has(root.id))
    .reduce((sum, root) => sum + root.count, 0);
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
      const unique = [...new Set(ids)];
      const planned = await previewAll(ctx, unique);
      if (!planned.ok) return refused(planned.refusal, { id: planned.id });

      const previewAnswer = async (
        extra: { code: string; message: string } | null,
      ) => {
        const names = await titles(ctx, unique);
        const token = confirmationToken(
          ctx.confirmKey,
          ctx.credentialHandle,
          planned.plan,
          ctx.now(),
        );
        const preview = planned.previews.map((p) => {
          const title = names.get(p.id);
          return {
            id: p.id,
            type: p.type,
            ...(title !== undefined && { title }),
            version: p.version,
            also_trashes: p.items.map((item) => ({
              id: item.id,
              type: item.type,
            })),
            count: p.count,
            ...(p.truncated === true && { truncated: true }),
          };
        });
        const body = {
          preview,
          total: totalOf(planned.plan),
          confirm: token.token,
          expires_at: token.expires_at,
          next: "Nothing has been deleted. Show the person what would go to the trash and ask them; only if they agree, call marfa_delete again with the same ids and confirm.",
        };
        return extra === null ? ok(body) : fail({ ...extra, ...body });
      };

      if (confirm === undefined) return previewAnswer(null);

      const check = checkConfirmation(
        ctx.confirmKey,
        ctx.credentialHandle,
        planned.plan,
        confirm,
        ctx.now(),
      );
      if (check !== "valid") {
        return previewAnswer({
          code: "confirmation_stale",
          message:
            check === "expired"
              ? "The confirmation expired. Nothing was deleted; here is a new preview."
              : "What would be deleted changed since the preview, or the confirmation is not this preview's. Nothing was deleted; here is a new preview.",
        });
      }

      // An item another named item takes goes last, with that item: trashed
      // on its own first, it would change what the other takes, and each
      // trash goes ahead only on the digest its preview gave.
      const carried = new Set(planned.plan.flatMap((root) => root.takes));
      const order = [
        ...planned.plan.filter((root) => !carried.has(root.id)),
        ...planned.plan.filter((root) => carried.has(root.id)),
      ];
      const trashed: string[] = [];
      const gone = new Set<string>();
      for (const root of order) {
        // Trashed already, with another named item.
        if (gone.has(root.id)) {
          trashed.push(root.id);
          continue;
        }
        const answer = await ctx.api.answer(
          ctx.api.client.DELETE("/items/{id}", {
            params: {
              path: { id: root.id },
              query: { version: root.version, digest: root.digest },
            },
          }),
        );
        if (!answer.ok) {
          return refused(answer.refusal, {
            id: root.id,
            trashed,
            ...(trashed.length > 0 && {
              note: "The items in trashed went to the trash before this one failed.",
            }),
          });
        }
        trashed.push(root.id);
        for (const id of root.takes) gone.add(id);
      }
      return ok({
        trashed,
        total: totalOf(planned.plan),
        next: "Moved to the trash. Restore an item with marfa_update and state active.",
      });
    },
  );
}
