import type { TypePermission } from "@withmarfa/shared";
import type { ToolFetch } from "./file-fetch.js";
import type { McpApi } from "./api.js";

/** What every tool of one MCP request works with. */
export interface ToolContext {
  api: McpApi;
  /** The caller's type map, which decides which tools are listed. */
  typePermissions: Record<string, TypePermission>;
  /** The caller as the confirmation token names it; stable across refreshes. */
  credentialHandle: string;
  /** The key a delete's confirmation token is signed with. */
  confirmKey: Buffer;
  /** Fetches a file from a public web address for this caller. */
  fetchFile: ToolFetch;
  now: () => number;
}

/** Whether the grant reads some type, so the read tools are any use. */
export function readsSomething(
  permissions: Record<string, TypePermission>,
): boolean {
  return Object.values(permissions).some(
    (level) => level === "read" || level === "write",
  );
}

/** Whether the grant writes some type, so the write tools are any use. */
export function writesSomething(
  permissions: Record<string, TypePermission>,
): boolean {
  return Object.values(permissions).some((level) => level === "write");
}
