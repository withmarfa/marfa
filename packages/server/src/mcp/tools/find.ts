import type { McpServer } from "@modelcontextprotocol/server";
import { itemName, itemPreview, type DisplayHints } from "@withmarfa/shared";
import { itemId } from "../args.js";
import * as z from "zod";
import type { ToolContext } from "../context.js";
import { fail, ok, refused } from "../results.js";
import { displayHintsOf, itemNamesOf, type ItemNaming } from "./display.js";

export const FIND_DEFAULT_LIMIT = 20;
export const FIND_MAX_LIMIT = 50;
/** How much of an item's text a row shows beside its title. */
const SNIPPET_CHARS = 160;

const rowSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  snippet: z.string().optional(),
  state: z.string().optional(),
  updated_at: z.string(),
  occurred_at: z.string().optional(),
});

const outputSchema = z.object({
  items: z.array(rowSchema),
  next_cursor: z.string().nullable(),
  hint: z.string().optional(),
});

type Row = z.infer<typeof rowSchema>;

interface ListedItem {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  state?: string;
  updated_at: string;
  occurred_at?: string;
  created_at?: string;
}

const ESCAPED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};

function collapsed(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A search excerpt as text: its only markup is `<mark>` and five escapes. */
function excerptText(html: string): string {
  return collapsed(
    html
      .replace(/<\/?mark>/g, "")
      .replace(
        /&(amp|lt|gt|quot|#39);/g,
        (whole, name: string) => ESCAPED[name] ?? whole,
      ),
  );
}

function clip(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length > limit
    ? `${points.slice(0, limit - 1).join("")}…`
    : text;
}

/**
 * A short preview of an item that never repeats its title: the body without
 * its Markdown and without the line the title came from, as a device shows it,
 * or else the first other text field that is not the title.
 */
function preview(
  properties: Record<string, unknown>,
  naming: ItemNaming,
  hints: DisplayHints | undefined,
): string {
  const title = naming.name;
  const body = itemPreview(properties, hints, naming.fromHost);
  if (body !== undefined) return clip(body, SNIPPET_CHARS);
  for (const field of ["description", "notes", "summary"]) {
    const value = properties[field];
    if (typeof value !== "string") continue;
    const text = collapsed(value);
    if (text !== "" && text !== title) return clip(text, SNIPPET_CHARS);
  }
  return "";
}

function rowOf(
  item: ListedItem,
  hints: ReadonlyMap<string, DisplayHints | undefined>,
  naming: ItemNaming,
  snippetHtml?: string,
): Row {
  const typeHints = hints.get(item.type);
  const title = naming.name;
  const snippet =
    snippetHtml !== undefined
      ? clip(excerptText(snippetHtml), SNIPPET_CHARS)
      : preview(item.properties, naming, typeHints);
  return {
    id: item.id,
    type: item.type,
    title,
    ...(snippet !== "" && { snippet }),
    ...(item.state !== undefined &&
      item.state !== "active" && { state: item.state }),
    updated_at: item.updated_at,
    ...(item.occurred_at !== undefined &&
      item.occurred_at !== item.created_at && {
        occurred_at: item.occurred_at,
      }),
  };
}

async function rowsOf(
  ctx: ToolContext,
  entries: { item: ListedItem; snippetHtml?: string }[],
): Promise<Row[]> {
  const hints = await displayHintsOf(
    ctx,
    entries.map(({ item }) => item.type),
  );
  const names = await itemNamesOf(
    ctx,
    entries.map(({ item }) => item),
  );
  return entries.map(({ item, snippetHtml }) =>
    rowOf(
      item,
      hints,
      names.get(item.id) ?? {
        name: itemName(item.properties, hints.get(item.type)),
        fromHost: false,
      },
      snippetHtml,
    ),
  );
}

function page(rows: Row[], next: string | null | undefined) {
  const nextCursor = next ?? null;
  return ok({
    items: rows,
    next_cursor: nextCursor,
    ...(nextCursor !== null && {
      hint: "More items match. Narrow with words, type, tags or a date range, or pass next_cursor as cursor to see the next page.",
    }),
  });
}

export function registerFind(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_find",
    {
      title: "Find items",
      description:
        "Use to find notes, tasks, records, files and other items: search by words, list by type, tags, source or dates, or list a view's items. Returns short rows (id, type, title, snippet); read the full items with marfa_get.",
      inputSchema: z.strictObject({
        query: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Words to search for. Leave out to list items in order instead.",
          ),
        type: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Only items of this type or its subtypes, such as `core.note`; `core.*` matches every type under `core`.",
          ),
        tags: z
          .array(z.string().min(1))
          .optional()
          .describe("Only items that carry all of these tags."),
        source: z
          .string()
          .min(1)
          .optional()
          .describe("Only items saved by this source."),
        state: z
          .enum(["active", "archived", "trashed", "any"])
          .optional()
          .describe(
            "Which items by state; `active` when left out. A search never finds trashed items.",
          ),
        tier: z
          .enum(["library", "feed", "all"])
          .optional()
          .describe(
            "`library` for what the person kept, `feed` for what arrived from connectors; both when left out.",
          ),
        updated_after: z
          .string()
          .optional()
          .describe("Only items changed at or after this time (RFC 3339)."),
        updated_before: z
          .string()
          .optional()
          .describe("Only items changed before this time (RFC 3339)."),
        occurred_after: z
          .string()
          .optional()
          .describe(
            "Only items whose own time, such as a meeting's date, is at or after this time.",
          ),
        occurred_before: z
          .string()
          .optional()
          .describe("Only items whose own time is before this time."),
        sort: z
          .enum(["relevance", "updated_at", "created_at", "occurred_at"])
          .optional()
          .describe(
            "Order: `relevance` for a search (its default), otherwise `updated_at` by default.",
          ),
        direction: z.enum(["asc", "desc"]).optional(),
        view: itemId
          .optional()
          .describe(
            "A view's ID from marfa_overview, to list the items the view shows. Takes no other filter.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(FIND_MAX_LIMIT)
          .optional()
          .describe(
            `How many rows, ${String(FIND_DEFAULT_LIMIT)} when left out.`,
          ),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe("next_cursor from the previous answer, for the next page."),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const limit = args.limit ?? FIND_DEFAULT_LIMIT;
      if (args.view !== undefined) {
        const others = Object.entries(args).filter(
          ([key]) => !["view", "limit", "cursor"].includes(key),
        );
        if (others.length > 0) {
          return fail({
            code: "validation_error",
            message: `A view lists the items it defines; leave out ${others.map(([key]) => key).join(", ")}.`,
          });
        }
        const answer = await ctx.api.answer(
          ctx.api.client.GET("/views/{id}/items", {
            params: {
              path: { id: args.view },
              query: {
                limit,
                ...(args.cursor !== undefined && { cursor: args.cursor }),
              },
            },
          }),
        );
        if (!answer.ok) return refused(answer.refusal);
        return page(
          await rowsOf(
            ctx,
            answer.data.data.map((item) => ({ item })),
          ),
          answer.data.next_cursor,
        );
      }
      const filters = {
        type: args.type,
        tags: args.tags?.join(","),
        source: args.source,
        tier: args.tier,
        updated_after: args.updated_after,
        updated_before: args.updated_before,
        occurred_after: args.occurred_after,
        occurred_before: args.occurred_before,
        direction: args.direction,
        limit,
        cursor: args.cursor,
      };
      if (args.query !== undefined) {
        if (args.state === "trashed") {
          return fail({
            code: "validation_error",
            message:
              "A search never finds trashed items. Leave out query to list the trash.",
          });
        }
        const answer = await ctx.api.answer(
          ctx.api.client.GET("/search", {
            params: {
              query: {
                ...filters,
                q: args.query,
                state: args.state,
                sort: args.sort,
              },
            },
          }),
        );
        if (!answer.ok) return refused(answer.refusal);
        return page(
          await rowsOf(
            ctx,
            answer.data.data.map((hit) => ({
              item: hit.item,
              snippetHtml: hit.snippet_html,
            })),
          ),
          answer.data.next_cursor,
        );
      }
      if (args.sort === "relevance") {
        return fail({
          code: "validation_error",
          message: "Sorting by relevance needs query.",
        });
      }
      const answer = await ctx.api.answer(
        ctx.api.client.GET("/items", {
          params: {
            query: {
              ...filters,
              state: args.state,
              sort: args.sort ?? "updated_at",
              direction: args.direction ?? "desc",
            },
          },
        }),
      );
      if (!answer.ok) return refused(answer.refusal);
      return page(
        await rowsOf(
          ctx,
          answer.data.data.map((row) => ({ item: row as ListedItem })),
        ),
        answer.data.next_cursor,
      );
    },
  );
}
