import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { ToolContext } from "../context.js";
import { ok, refused } from "../results.js";

const named = z.looseObject({ id: z.string(), title: z.string() });

const outputSchema = z.looseObject({
  instance: z.looseObject({ name: z.string() }).optional(),
  credential: z.looseObject({ kind: z.string() }).optional(),
  types: z
    .array(
      z.looseObject({
        id: z.string(),
        description: z.string().optional(),
        count: z.number(),
      }),
    )
    .optional(),
  edge_types: z
    .array(
      z.looseObject({
        id: z.string(),
        description: z.string().optional(),
        access: z.string(),
      }),
    )
    .optional(),
  tags: z.array(z.looseObject({})).optional(),
  views: z.array(named).optional(),
  folders: z.array(named).optional(),
  truncated: z.record(z.string(), z.number()).optional(),
  type: z
    .looseObject({
      id: z.string(),
      fields: z.record(z.string(), z.looseObject({ type: z.string() })),
    })
    .optional(),
});

interface FieldDefinition {
  type: string;
  description?: string;
  required?: boolean;
  enum_values?: string[];
  items_type?: string;
  format?: string;
}

/** A type's definition with only what an agent writing an item needs. */
function compactType(type: Record<string, unknown>) {
  const fields: Record<string, Record<string, unknown>> = {};
  const given = (type.fields ?? {}) as Record<string, FieldDefinition>;
  for (const [name, field] of Object.entries(given)) {
    fields[name] = {
      type: field.type,
      ...(field.required === true && { required: true }),
      ...(field.description !== undefined && {
        description: field.description,
      }),
      ...(field.enum_values !== undefined && {
        enum_values: field.enum_values,
      }),
      ...(field.items_type !== undefined && { items_type: field.items_type }),
      ...(field.format !== undefined && { format: field.format }),
    };
  }
  const hints = type.display_hints as
    { title_field?: string; body_field?: string } | undefined;
  return {
    id: type.id as string,
    ...(typeof type.label === "string" && { label: type.label }),
    ...(typeof type.description === "string" && {
      description: type.description,
    }),
    ...(typeof type.parent === "string" && { parent: type.parent }),
    fields,
    ...(typeof type.link_field === "string" && {
      link_field: type.link_field,
    }),
    ...(hints?.title_field !== undefined && {
      title_field: hints.title_field,
    }),
    ...(hints?.body_field !== undefined && { body_field: hints.body_field }),
  };
}

export function registerOverview(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_overview",
    {
      title: "Overview of this Marfa",
      description:
        "Call first, before finding or saving anything. Without arguments, returns what this Marfa holds and what you may do: the types of items (notes, tasks, records, files and more) with counts, edge types, the most used tags, views and folders. With `type`, returns that type's fields, which you need to save or update an item of it.",
      inputSchema: z.object({
        type: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A type's identifier from the overview, such as `core.note`, to see its fields.",
          ),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ type }) => {
      if (type !== undefined) {
        const answer = await ctx.api.answer(
          ctx.api.client.GET("/types/{id}", {
            params: { path: { id: type } },
          }),
        );
        if (!answer.ok) return refused(answer.refusal);
        return ok({
          type: compactType(answer.data as unknown as Record<string, unknown>),
        });
      }
      // `GET /overview` is not in the generated client until it merges.
      const answer = await ctx.api.raw<Record<string, unknown>>(
        "GET",
        "/overview",
      );
      if (!answer.ok) return refused(answer.refusal);
      return ok(answer.data);
    },
  );
}
