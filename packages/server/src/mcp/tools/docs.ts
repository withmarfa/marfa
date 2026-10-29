import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { ok } from "../results.js";

/** Where Marfa's documentation is published. The instance holds no copy. */
export const DOCS_SITE = "https://docs.marfa.so";

const outputSchema = z.object({
  query: z.string(),
  search_url: z.string(),
  docs_mcp: z.string(),
  llms_txt: z.string(),
  next: z.string(),
});

export function registerSearchDocs(server: McpServer): void {
  server.registerTool(
    "marfa_search_docs",
    {
      title: "Find Marfa's documentation",
      description:
        "Use to learn how Marfa works, such as the field types a type can have or a view's filter expressions. Returns where to search the documentation for your query.",
      inputSchema: z.strictObject({
        query: z.string().min(1).max(200).describe("What to look up."),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query }) =>
      ok({
        query,
        search_url: `${DOCS_SITE}/api/docs/search?q=${encodeURIComponent(query)}`,
        docs_mcp: `${DOCS_SITE}/mcp`,
        llms_txt: `${DOCS_SITE}/llms.txt`,
        next: "This instance holds no copy of the documentation. Fetch search_url if you can reach the web, or add docs_mcp as an MCP server to search it there.",
      }),
  );
}
