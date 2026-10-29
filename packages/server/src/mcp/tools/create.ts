import type { McpServer } from "@modelcontextprotocol/server";
import { itemName } from "@withmarfa/shared";
import * as z from "zod";
import type { ToolContext } from "../context.js";
import { fail, ok, refused } from "../results.js";

/**
 * The file a ChatGPT user attached, as ChatGPT hands it to a tool that
 * names the argument in `_meta["openai/fileParams"]`.
 */
const chatFile = z
  .object({
    download_url: z
      .string()
      .min(1)
      .describe("Where to download the file; it works for a short time."),
    file_id: z.string().min(1).describe("The file's ID in the chat."),
    mime_type: z.string().optional().describe("The file's MIME type."),
    file_name: z.string().optional().describe("The file's name."),
  })
  .strict();

const outputSchema = z.object({
  id: z.string(),
  type: z.string(),
  version: z.number(),
  title: z.string(),
  tags: z.array(z.string()),
  created: z
    .boolean()
    .describe(
      "`false` when this id was saved before, so nothing was written and the item is as stored.",
    ),
  file: z
    .object({
      hash: z.string(),
      mime_type: z.string(),
      size_bytes: z.number(),
    })
    .optional(),
  attached_to: z.string().optional(),
});

/** The file type a MIME type names, as `marfa items attach` chooses it. */
export function fileTypeFor(mimeType: string): string {
  const essence = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (essence === "text/html" || essence === "application/xhtml+xml") {
    return "core.file.webpage";
  }
  switch (essence.split("/")[0]) {
    case "image":
      return "core.file.image";
    case "audio":
      return "core.file.audio";
    case "video":
      return "core.file.video";
    default:
      return "core.file";
  }
}

/** The last path segment of a URL, as a file name, or null. */
function nameFromUrl(raw: string): string | null {
  try {
    const segment = new URL(raw).pathname.split("/").pop() ?? "";
    const name = decodeURIComponent(segment).trim();
    return name === "" ? null : name;
  } catch {
    return null;
  }
}

interface CreatedItem {
  item: {
    id: string;
    type: string;
    version: number;
    properties: Record<string, unknown>;
  };
  metadata: { tags: string[] };
  acknowledged?: boolean;
}

export function registerCreate(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "marfa_create",
    {
      title: "Save a new item",
      description:
        "Use to save something new: a note, task, record or other item, or a file from a web address or the chat. Check the type's fields with marfa_overview first. To change an existing item, use marfa_update instead.",
      inputSchema: z.strictObject({
        type: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The item's type, such as `core.note`. Required unless saving a file, whose type follows its MIME type.",
          ),
        properties: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The item's fields, as the type defines them."),
        tags: z.array(z.string().min(1)).optional().describe("Tags to add."),
        edges: z
          .record(z.string(), z.array(z.string().min(1)))
          .optional()
          .describe(
            'Edges from the new item, as edge type to target item IDs, such as {"in-collection": ["<id>"]}.',
          ),
        tier: z
          .enum(["library", "feed"])
          .optional()
          .describe(
            "`library` for something the person keeps; the credential's default when left out.",
          ),
        occurred_at: z
          .string()
          .optional()
          .describe(
            "The item's own time, such as a meeting's date (RFC 3339).",
          ),
        id: z
          .string()
          .min(1)
          .optional()
          .describe(
            "An ID you choose (a UUIDv7), so that calling again after a lost answer saves nothing twice.",
          ),
        url: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A public http or https address of a file to save. Marfa downloads it; redirects are not followed.",
          ),
        file: chatFile
          .optional()
          .describe("A file the person attached in the chat, to save."),
        attach_to: z
          .string()
          .min(1)
          .optional()
          .describe(
            "With url or file: the ID of an item to attach the saved file to.",
          ),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { "openai/fileParams": ["file"] },
    },
    async (args) => {
      const bytesFrom = args.url ?? args.file?.download_url;
      if (args.url !== undefined && args.file !== undefined) {
        return fail({
          code: "validation_error",
          message: "Send url or file, not both.",
        });
      }
      if (bytesFrom === undefined && args.attach_to !== undefined) {
        return fail({
          code: "validation_error",
          message: "attach_to needs url or file.",
        });
      }
      if (bytesFrom === undefined && args.type === undefined) {
        return fail({
          code: "validation_error",
          message: "type is required unless saving a file.",
        });
      }

      let type = args.type;
      let properties = args.properties ?? {};
      let file: z.infer<typeof outputSchema>["file"];
      if (bytesFrom !== undefined) {
        const fetched = await ctx.fetchFile(bytesFrom);
        if (fetched.kind === "failed") {
          return fail({
            code: "file_not_fetched",
            message: fetched.message,
            reason: fetched.reason,
            ...(fetched.status !== undefined && { status: fetched.status }),
            ...(args.file !== undefined &&
              fetched.reason === "status" && {
                hint: "The chat's link to the file may have expired. Ask the person to attach the file again.",
              }),
          });
        }
        const mimeType =
          fetched.mimeType ??
          args.file?.mime_type?.toLowerCase() ??
          "application/octet-stream";
        const upload = await ctx.api.answer(
          ctx.api.client.POST("/blobs", {
            body: fetched.bytes,
            headers: { "Content-Type": mimeType },
          }),
        );
        if (!upload.ok) return refused(upload.refusal);
        file = upload.data;
        type ??= fileTypeFor(upload.data.mime_type);
        const title =
          args.file?.file_name ??
          fetched.fileName ??
          (args.url !== undefined ? nameFromUrl(args.url) : null) ??
          "file";
        properties = {
          title,
          ...properties,
          blob_ref: upload.data.hash,
          mime_type: upload.data.mime_type,
          ...(args.url !== undefined && { source_url: args.url }),
        };
      }
      if (type === undefined) {
        return fail({ code: "validation_error", message: "type is required." });
      }

      const created = await ctx.api.answer(
        ctx.api.client.POST("/items", {
          body: {
            type,
            properties,
            ...(args.id !== undefined && { id: args.id }),
            ...(args.tags !== undefined && { tags: args.tags }),
            ...(args.edges !== undefined && { edges: args.edges }),
            ...(args.tier !== undefined && { tier: args.tier }),
            ...(args.occurred_at !== undefined && {
              occurred_at: args.occurred_at,
            }),
          },
        }),
      );
      if (!created.ok) return refused(created.refusal);
      const { item, metadata, acknowledged } =
        created.data as unknown as CreatedItem;

      let attachedTo: string | undefined;
      if (args.attach_to !== undefined) {
        const edge = await ctx.api.answer(
          ctx.api.client.POST("/edges", {
            body: {
              source_id: item.id,
              target_id: args.attach_to,
              edge_type: "attached-to",
            },
          }),
        );
        if (!edge.ok) {
          return refused(edge.refusal, {
            saved: { id: item.id, type: item.type, version: item.version },
            hint: "The file was saved, but attaching it failed. Attach it with marfa_update on the saved item, adding an attached-to edge.",
          });
        }
        attachedTo = args.attach_to;
      }

      return ok({
        id: item.id,
        type: item.type,
        version: item.version,
        title: itemName(item.properties),
        tags: metadata.tags,
        created: acknowledged !== true,
        ...(file !== undefined && { file }),
        ...(attachedTo !== undefined && { attached_to: attachedTo }),
      });
    },
  );
}
