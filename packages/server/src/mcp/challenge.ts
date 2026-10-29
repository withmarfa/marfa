/**
 * The answer an MCP endpoint gives a request with no credential it accepts:
 * the challenge an MCP client starts its sign-in from (MCP authorization,
 * RFC 9728 §5.1).
 */
import { ErrorCode, MarfaError } from "@withmarfa/shared";

export type McpResourcePath = "/mcp";

const PROTECTED_RESOURCE_METADATA = "/.well-known/oauth-protected-resource";

function originOf(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
}

/** Where the protected resource metadata for `path` is served. */
export function protectedResourceMetadataPath(path?: McpResourcePath): string {
  return `${PROTECTED_RESOURCE_METADATA}${path ?? ""}`;
}

function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * `401` with a Bearer challenge naming where the endpoint's protected
 * resource metadata is.
 */
export function mcpUnauthorized(
  baseURL: string,
  path: McpResourcePath,
): Response {
  const metadata = `${originOf(baseURL)}${protectedResourceMetadataPath(path)}`;
  return new Response(
    JSON.stringify(
      new MarfaError(
        ErrorCode.UNAUTHORIZED,
        "Authentication required",
      ).toResponse(),
    ),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata=${quoted(metadata)}`,
      },
    },
  );
}
