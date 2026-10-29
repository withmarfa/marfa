/**
 * The MCP endpoint's groups. `/mcp` serves the tools for working with items;
 * `/mcp/schema` and `/mcp/admin` serve those and their own, so a client
 * that never adds a group never loads its tools.
 */
import type { McpResourcePath } from "../auth/mcp-resource.js";

export type McpGroup = "items" | "schema" | "admin";

/** Where each group is served. */
export const GROUP_PATHS: Record<McpGroup, McpResourcePath> = {
  items: "/mcp",
  schema: "/mcp/schema",
  admin: "/mcp/admin",
};

/**
 * The scopes a group's own tools need, which its protected resource metadata
 * offers beside the default grant, so an app adding the group can ask for
 * them.
 */
export const GROUP_SCOPES: Record<McpGroup, readonly string[]> = {
  items: [],
  schema: ["metadata.types:write", "schema.write", "system.view:write"],
  admin: [
    "instance.read",
    "connectors.manage",
    "audit.read",
    "keys.mint",
    "webhooks.manage",
  ],
};

/** The group served at `path`. */
export function groupAt(path: McpResourcePath): McpGroup {
  const found = (Object.keys(GROUP_PATHS) as McpGroup[]).find(
    (group) => GROUP_PATHS[group] === path,
  );
  if (found === undefined) throw new Error(`No MCP group is served at ${path}`);
  return found;
}
