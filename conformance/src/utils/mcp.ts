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
  "marfa_read_rows",
  "marfa_update",
  "marfa_write_rows",
];

export const READ_TOOLS = [
  "marfa_find",
  "marfa_get",
  "marfa_overview",
  "marfa_read_rows",
];

/** The tools `/mcp/schema` adds for a credential that may use each. */
export const SCHEMA_TOOLS = [
  "marfa_bulk_save",
  "marfa_move_items",
  "marfa_name_source",
  "marfa_save_type",
  "marfa_save_view",
  "marfa_search_docs",
  "marfa_sources",
];

/** The tools `/mcp/schema` adds for every credential. */
export const EVERY_CREDENTIAL_SCHEMA_TOOLS = [
  "marfa_name_source",
  "marfa_search_docs",
  "marfa_sources",
];

const KEY_TOOLS = ["marfa_keys", "marfa_manage_key", "marfa_revoke_key"];

/** The tools `/mcp/admin` lists to a credential that holds each permission. */
export const ADMIN_TOOLS_BY_PERMISSION: Readonly<Record<string, string[]>> = {
  "audit.read": ["marfa_audit"],
  "backups.manage": [
    "marfa_adopt_backup_folder",
    "marfa_backups",
    "marfa_take_backup",
  ],
  "blobs.manage": ["marfa_files", "marfa_remove_file_copy"],
  "config.manage": ["marfa_change_settings", "marfa_settings"],
  "connectors.manage": [
    "marfa_connectors",
    "marfa_delete_connector",
    "marfa_health",
    "marfa_make_endpoint",
    "marfa_retire_endpoint",
  ],
  "grants.manage": ["marfa_apps", "marfa_narrow_app"],
  "instance.maintain": ["marfa_maintain"],
  "instance.read": ["marfa_health"],
  "items.purge": ["marfa_purge", "marfa_trash"],
  "keys.manage": KEY_TOOLS,
  "keys.mint": KEY_TOOLS,
  "sign_ins.manage": ["marfa_rename_sign_in", "marfa_sign_ins"],
  "webhooks.manage": ["marfa_manage_webhook", "marfa_webhooks"],
};

/** The tools `/mcp/admin` adds for a credential that holds every permission. */
export const ADMIN_TOOLS = [
  ...new Set(Object.values(ADMIN_TOOLS_BY_PERMISSION).flat()),
].sort();

/** The tools `/mcp/admin` adds for a credential that holds these permissions. */
export function adminToolsFor(permissions: readonly string[]): string[] {
  return [
    ...new Set(
      permissions.flatMap(
        (permission) => ADMIN_TOOLS_BY_PERMISSION[permission] ?? [],
      ),
    ),
  ].sort();
}
