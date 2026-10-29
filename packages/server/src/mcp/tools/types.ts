import type { McpServer } from "@modelcontextprotocol/server";
import type { components } from "@withmarfa/client";
import * as z from "zod";
import { pathSegment } from "../args.js";
import {
  checkConfirmation,
  confirmationToken,
  staleConfirmation,
} from "../confirm.js";
import type { ToolContext } from "../context.js";
import { ANSWER_BUDGET_CHARS, fail, fitList, ok, refused } from "../results.js";
import { compactType } from "./overview.js";

type TypeDefinitionInput = components["schemas"]["TypeDefinitionInput"];
type TypeDefinitionUpdate = components["schemas"]["TypeDefinitionUpdate"];
type BulkActionJob = components["schemas"]["BulkActionJob"];
type ListedType = components["schemas"]["ListedType"];

const field = z
  .looseObject({
    type: z
      .string()
      .min(1)
      .describe(
        "string, number, integer, boolean, url, email, datetime, date, enum, array, object or thumbnail.",
      ),
    description: z.string().optional(),
    required: z.boolean().optional(),
    enum_values: z.array(z.string()).optional(),
    items_type: z.string().optional(),
  })
  .describe("A field's definition.");

const typeOutput = z.object({
  type: z.looseObject({
    id: z.string(),
    fields: z.record(z.string(), z.looseObject({ type: z.string() })),
  }),
  next: z.string().optional(),
});

/**
 * The definition `id` stores, from the list of types, and each field name it
 * inherits with the nearest ancestor that defines it.
 */
function ownDefinition(
  types: readonly ListedType[],
  id: string,
):
  | { definition: Record<string, unknown>; inherited: Map<string, string> }
  | undefined {
  const byId = new Map(types.map((type) => [type.id, type]));
  const listed = byId.get(id);
  if (listed === undefined) return undefined;
  const inherited = new Map<string, string>();
  const seen = new Set([id]);
  let ancestor = listed.parent;
  while (ancestor !== undefined && !seen.has(ancestor)) {
    seen.add(ancestor);
    const type = byId.get(ancestor);
    if (type === undefined) break;
    for (const name of Object.keys(type.fields)) {
      if (!inherited.has(name)) inherited.set(name, ancestor);
    }
    ancestor = type.parent;
  }
  const definition = Object.fromEntries(
    Object.entries(listed).filter(
      ([name]) =>
        name !== "provenance" && name !== "roles" && name !== "own_roles",
    ),
  );
  return {
    definition: {
      ...definition,
      ...(listed.own_roles.length > 0 && { roles: listed.own_roles }),
    },
    inherited,
  };
}

export function registerSaveType(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_save_type",
    {
      title: "Register or change a type",
      description:
        "Use to add a type of item, or to change one's label, description or fields. Changing merges what you send into the type's own definition: a field set to null is removed, and items keep their values for it. A field the type inherits is changed or removed on the type it comes from.",
      inputSchema: z.strictObject({
        action: z.enum(["register", "change"]),
        id: pathSegment.describe(
          "The type's identifier, such as `user.recipe`. A new type goes under `user.*` or `app.*`.",
        ),
        label: z.string().min(1).optional(),
        description: z.string().optional(),
        fields: z
          .record(z.string(), field.nullable())
          .optional()
          .describe(
            "Fields by name. Required to register. To change, the fields to add or replace, and null for each to remove.",
          ),
        parent: z
          .string()
          .optional()
          .describe("A type to inherit fields from. Only to register."),
      }),
      outputSchema: typeOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action, id, label, description, fields, parent }) => {
      if (action === "register") {
        if (fields === undefined) {
          return fail({
            code: "validation_error",
            message: "A new type needs fields.",
          });
        }
        const given: Record<string, unknown> = {};
        for (const [name, definition] of Object.entries(fields)) {
          if (definition === null) {
            return fail({
              code: "validation_error",
              message: `A new type cannot remove a field (${name} is null).`,
            });
          }
          given[name] = definition;
        }
        const body = {
          id,
          fields: given,
          ...(label !== undefined && { label }),
          ...(description !== undefined && { description }),
          ...(parent !== undefined && { parent }),
        } as TypeDefinitionInput;
        const answer = await ctx.api.answer(
          ctx.api.client.POST("/types", { body }),
        );
        if (!answer.ok) return refused(answer.refusal);
        return ok({
          type: compactType(answer.data.type as Record<string, unknown>),
          next: "Registered. Save items of it with marfa_create.",
        });
      }

      if (parent !== undefined) {
        return fail({
          code: "validation_error",
          message: "A type's parent is set when it is registered.",
        });
      }
      // The type's own definition, as the list gives it, so a subtype goes
      // on inheriting what its ancestors define rather than keeping a copy.
      const listed = await ctx.api.answer(ctx.api.client.GET("/types"));
      if (!listed.ok) return refused(listed.refusal);
      const own = ownDefinition(listed.data.data, id);
      if (own === undefined) {
        return fail({
          code: "type_not_found",
          message: `Type "${id}" not found`,
          hint: "No type has this identifier. Call marfa_overview to see the types, or register it with action register.",
        });
      }
      const ownFields = own.definition.fields as Record<string, unknown>;
      for (const [name, value] of Object.entries(fields ?? {})) {
        const from = own.inherited.get(name);
        if (value === null && !(name in ownFields) && from !== undefined) {
          return fail({
            code: "validation_error",
            message: `${id} inherits ${name} from ${from}, so it cannot remove it. Removing ${name} from ${from} removes it from every type that inherits it.`,
          });
        }
      }
      const merged = Object.fromEntries(
        Object.entries({ ...ownFields, ...fields }).filter(
          ([, value]) => value !== null,
        ),
      );
      const definition = own.definition;
      const body = {
        ...definition,
        fields: merged,
        ...(label !== undefined && { label }),
        ...(description !== undefined && { description }),
      } as TypeDefinitionUpdate;
      const answer = await ctx.api.answer(
        ctx.api.client.PUT("/types/{id}", {
          params: { path: { id } },
          body,
        }),
      );
      if (!answer.ok) return refused(answer.refusal);
      return ok({
        type: compactType(answer.data.type as Record<string, unknown>),
      });
    },
  );
}

const MOVE_IDS_SHOWN = 50;

function jobSummary(job: BulkActionJob) {
  return {
    id: job.id,
    status: job.status,
    matched: job.matched,
    processed: job.processed,
    succeeded: job.succeeded,
    errored: job.errored,
    ...(job.error !== undefined && { error: job.error }),
    ...(job.result !== undefined && { result: job.result }),
  };
}

/** A job's answer, with its result's error list cut to the budget. */
function jobAnswer(job: BulkActionJob, next: string) {
  const summary: Record<string, unknown> = jobSummary(job);
  const result = summary.result as { errors?: unknown[] } | undefined;
  if (Array.isArray(result?.errors)) {
    const errors = fitList(result.errors, ANSWER_BUDGET_CHARS / 2);
    summary.result = {
      ...result,
      errors: errors.kept,
      ...(errors.left_out > 0 && { errors_left_out: errors.left_out }),
    };
  }
  return ok({ job: summary, next });
}

const moveOutput = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  matched: z.number().optional(),
  ids: z.array(z.string()).optional(),
  settings: z.array(z.looseObject({})).optional(),
  grants: z.array(z.looseObject({})).optional(),
  confirm: z.string().optional(),
  expires_at: z.string().optional(),
  job: z.looseObject({ id: z.string(), status: z.string() }).optional(),
  next: z.string().optional(),
});

export function registerMoveItems(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_move_items",
    {
      title: "Move items to another type",
      description:
        "Use to move every item of one type to another, such as after making a better type. The first call previews what would move; call again with the same arguments and confirm to start it. With job_id, returns how the move is going.",
      inputSchema: z.strictObject({
        from: pathSegment.optional().describe("The type to move items out of."),
        to: z.string().min(1).optional().describe("The type to move them to."),
        properties: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Properties to merge into every item as it moves, such as a field the new type requires. null removes one.",
          ),
        confirm: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The confirm token from the preview. Leave out to preview.",
          ),
        job_id: z
          .string()
          .min(1)
          .optional()
          .describe("A started move's job ID, to see how it is going."),
      }),
      outputSchema: moveOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ from, to, properties, confirm, job_id }) => {
      if (job_id !== undefined) {
        const answer = await ctx.api.answer(
          ctx.api.client.GET("/items/bulk-actions/jobs/{id}", {
            params: { path: { id: job_id } },
          }),
        );
        if (!answer.ok) return refused(answer.refusal);
        return jobAnswer(
          answer.data,
          "Call again with job_id until status is completed or failed.",
        );
      }
      if (from === undefined || to === undefined) {
        return fail({
          code: "validation_error",
          message: "Name from and to, or a job_id.",
        });
      }
      const move = (dryRun: boolean) =>
        ctx.api.client.POST("/types/{id}/move", {
          params: { path: { id: from } },
          body: {
            to,
            ...(properties !== undefined && { properties }),
            dry_run: dryRun,
          },
        });
      const preview = await ctx.api.answer(move(true));
      if (!preview.ok) return refused(preview.refusal);
      const plan = preview.data as components["schemas"]["TypeMoveDryRun"];
      const scope = {
        tool: "marfa_move_items",
        credential: ctx.credentialHandle,
      };
      const subject = {
        from,
        to,
        properties: properties ?? null,
        ids: [...plan.ids].sort(),
        settings: plan.settings,
      };

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
          from: plan.from,
          to: plan.to,
          matched: plan.matched,
          ids: plan.ids.slice(0, MOVE_IDS_SHOWN),
          settings: plan.settings,
          grants: plan.grants,
          confirm: token.token,
          expires_at: token.expires_at,
          next: `Nothing has moved. ${String(plan.matched)} items would move${plan.ids.length > MOVE_IDS_SHOWN ? `; the first ${String(MOVE_IDS_SHOWN)} are listed` : ""}. Show the person, and call again with the same arguments and confirm to move them.`,
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
        return previewAnswer(staleConfirmation(check, "Nothing has moved"));
      }
      const started = await ctx.api.answer(move(false));
      if (!started.ok) return refused(started.refusal);
      return jobAnswer(
        started.data as BulkActionJob,
        "The move has started. Call marfa_move_items with job_id to see how it is going.",
      );
    },
  );
}
