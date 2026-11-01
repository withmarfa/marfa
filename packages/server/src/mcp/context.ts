import type { Permission, TypePermission } from "@withmarfa/shared";
import type { ToolFetch } from "./file-fetch.js";
import type { McpApi } from "./api.js";
import type { McpGroup } from "./groups.js";
import type { ItemNaming } from "../storage/part-names.js";

/** What every tool of one MCP request works with. */
export interface ToolContext {
  api: McpApi;
  /** The group the request was sent to, which decides which tools are served. */
  group: McpGroup;
  /** The caller's type map, which decides which tools are listed. */
  typePermissions: Record<string, TypePermission>;
  /** The permissions the caller holds, which decide which group tools are listed. */
  permissions: ReadonlySet<Permission>;
  /** Whether the caller may register types (`metadata.types:write`). */
  registersTypes: boolean;
  /** The stored key the caller is, or `null` for a signed-in app. */
  callerKeyId: string | null;
  /** The caller as the confirmation token names it; stable across refreshes. */
  credentialHandle: string;
  /** The key a confirmation token is signed with. */
  confirmKey: Buffer;
  /** Names each of `items` as the server names it for this caller
   *  (`namingOf`), a part after the oldest host it may read. */
  nameItems: (
    items: readonly {
      id: string;
      type: string;
      properties: Record<string, unknown>;
    }[],
  ) => Promise<Map<string, ItemNaming>>;
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

/** Whether the caller holds any of `permissions`. */
export function holdsAny(
  ctx: Pick<ToolContext, "permissions">,
  ...permissions: Permission[]
): boolean {
  return permissions.some((permission) => ctx.permissions.has(permission));
}
