import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";

/**
 * How a client picks the protocol revision: pinned to 2026-07-28, which
 * fails rather than falling back, or the 2025-11-25 `initialize` handshake.
 */
export type McpRevision = "2026-07-28" | "2025-11-25";

export interface McpConnection {
  client: Client;
  /** The JSON-RPC methods the client sent, in order. */
  methods: string[];
  close(): Promise<void>;
}

export async function connectMcp(
  apiUrl: string,
  credential: string,
  revision: McpRevision = "2026-07-28",
  /** The endpoint: `/mcp`, `/mcp/schema` or `/mcp/admin`. */
  path = "/mcp",
): Promise<McpConnection> {
  const methods: string[] = [];
  const client = new Client(
    { name: "marfa-conformance", version: "0.0.0" },
    {
      versionNegotiation: {
        mode: revision === "2025-11-25" ? "legacy" : { pin: revision },
      },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(path, apiUrl), {
    requestInit: { headers: { Authorization: `Bearer ${credential}` } },
    fetch: async (url, init) => {
      if (typeof init?.body === "string") {
        const sent = JSON.parse(init.body) as { method?: string };
        if (typeof sent.method === "string") methods.push(sent.method);
      }
      return fetch(url, init);
    },
  });
  await client.connect(transport);
  return { client, methods, close: () => client.close() };
}

export async function toolNames(connection: McpConnection): Promise<string[]> {
  const { tools } = await connection.client.listTools();
  return tools.map((tool) => tool.name).sort();
}

export interface ToolAnswer {
  isError: boolean;
  /** The JSON the text carries, or `{}` when it is plain text. */
  body: Record<string, unknown>;
  text: string;
}

/** Calls a tool and reads the JSON its one text block carries. */
export async function callTool(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const result = (await connection.client.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
  const block = result.content[0];
  const text = block?.type === "text" ? block.text : "";
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // An answer the protocol gives, such as refused arguments, is plain text.
  }
  return { isError: result.isError === true, body, text };
}

/** The error a tool answered with; fails when the tool succeeded. */
export function toolError(answer: ToolAnswer): Record<string, unknown> {
  if (!answer.isError) {
    throw new Error(`the tool succeeded: ${JSON.stringify(answer.body)}`);
  }
  return answer.body.error as Record<string, unknown>;
}

/** What a tool answered with; fails when the tool refused. */
export function toolResult(answer: ToolAnswer): Record<string, unknown> {
  if (answer.isError) {
    throw new Error(`the tool failed: ${JSON.stringify(answer.body)}`);
  }
  return answer.body;
}

export const ALL_TOOLS = [
  "marfa_create",
  "marfa_delete",
  "marfa_find",
  "marfa_get",
  "marfa_overview",
  "marfa_update",
];

export const READ_TOOLS = ["marfa_find", "marfa_get", "marfa_overview"];

/** The tools `/mcp/schema` adds for a credential that may use each. */
export const SCHEMA_TOOLS = [
  "marfa_bulk_save",
  "marfa_move_items",
  "marfa_save_type",
  "marfa_save_view",
  "marfa_search_docs",
];

/** The tools `/mcp/admin` adds for a credential that may use each. */
export const ADMIN_TOOLS = [
  "marfa_audit",
  "marfa_health",
  "marfa_keys",
  "marfa_manage_key",
  "marfa_manage_webhook",
  "marfa_revoke_key",
  "marfa_webhooks",
];
