/**
 * The MCP endpoints as OAuth protected resources (RFC 8707, RFC 9728).
 *
 * An MCP client names the canonical URI of the endpoint it will call as the
 * `resource` of its authorization and token requests, and finds the
 * endpoint's metadata by inserting the well-known segment between the origin
 * and the endpoint's path. Each path here is one such endpoint: the server
 * and its two narrower groups.
 */

import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { createInsufficientScopeError } from "better-auth/oauth2";
import { MarfaError, ErrorCode } from "@withmarfa/shared";

export const MCP_RESOURCE_PATHS = [
  "/mcp",
  "/mcp/schema",
  "/mcp/admin",
] as const;

export type McpResourcePath = (typeof MCP_RESOURCE_PATHS)[number];

const PROTECTED_RESOURCE_METADATA = "/.well-known/oauth-protected-resource";

function originOf(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
}

/** A URI split after its authority: `scheme://authority` and the rest. */
const AUTHORITY = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i;

/**
 * Whether a `resource` value names this server: its origin, with or without
 * a trailing slash, or one MCP endpoint exactly as {@link MCP_RESOURCE_PATHS}
 * spells it. The scheme and host compare without case (RFC 3986 §6.2.2.1);
 * the path compares exactly.
 */
export function isAcceptedResource(baseURL: string, value: string): boolean {
  const origin = originOf(baseURL);
  if (origin.length === 0) return false;
  const parts = AUTHORITY.exec(value);
  if (!parts || parts[1]?.toLowerCase() !== origin.toLowerCase()) return false;
  const rest = parts[2] ?? "";
  if (/^\/*$/.test(rest)) return true;
  return MCP_RESOURCE_PATHS.some((path) => rest === path);
}

/** The canonical URI a token for `path` names as its audience. */
export function mcpResourceUri(baseURL: string, path: McpResourcePath): string {
  return `${originOf(baseURL)}${path}`;
}

/** Where the protected resource metadata for `path` is served. */
export function protectedResourceMetadataPath(path?: McpResourcePath): string {
  return `${PROTECTED_RESOURCE_METADATA}${path ?? ""}`;
}

function challengeResponse(
  challenge: ReturnType<typeof createResourceServerChallenge>,
  error: MarfaError,
): Response {
  if (!challenge) throw new Error("This failure has no resource challenge");
  // The challenge builder sets its header as a plain record.
  const headers = new Headers(challenge.headers as Record<string, string>);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(error.toResponse()), {
    status: challenge.statusCode,
    headers,
  });
}

/**
 * The answer to a request at an MCP endpoint that carries no credential the
 * server accepts: `401` with a Bearer challenge naming where the endpoint's
 * protected resource metadata is (RFC 9728 §5.1).
 */
export function mcpUnauthorized(
  baseURL: string,
  path: McpResourcePath,
): Response {
  return challengeResponse(
    createResourceServerChallenge(
      new APIError("UNAUTHORIZED", { message: "Authentication required" }),
      mcpResourceUri(baseURL, path),
    ),
    new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required"),
  );
}

/**
 * The answer to a request at an MCP endpoint whose credential is valid but
 * lacks a scope the call needs: `403` with an `insufficient_scope` Bearer
 * challenge naming the scopes to ask for (RFC 6750 §3.1), so the client can
 * step up its authorization. Throws for a scope a header cannot carry.
 */
export function mcpInsufficientScope(
  baseURL: string,
  path: McpResourcePath,
  scopes: readonly string[],
): Response {
  return challengeResponse(
    createResourceServerChallenge(
      createInsufficientScopeError(scopes),
      mcpResourceUri(baseURL, path),
    ),
    new MarfaError(ErrorCode.FORBIDDEN, "Insufficient scope", {
      required_scope: scopes.join(" "),
    }),
  );
}
