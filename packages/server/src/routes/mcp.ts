/**
 * The remote agent surface: the Marfa MCP tools served over streamable HTTP
 * at `/mcp`, protected by the same bearers as the rest of the API.
 *
 * The tool surface comes from `@withmarfa/mcp/server` — the same factory the
 * stdio bin serves locally, so the two transports cannot drift. A handler is
 * constructed per request around a MarfaClient bound to the caller's own
 * bearer, and every tool call dispatches back into this app in process: the
 * API's scope, space and RLS enforcement does all authorization, and the MCP
 * layer never chooses a space — the token's binding does. `legacy:
 * 'stateless'` serves 2025-era handshake clients beside the modern
 * per-request-envelope era.
 *
 * The door refuses anonymous and unresolvable bearers with the challenge
 * shape the MCP authorization spec prescribes: a 401 whose
 * `WWW-Authenticate` names the Protected Resource Metadata document, which
 * is where a client's discovery starts. Space-less hosted-mode tokens never
 * reach here (the bearer middleware refuses them), so a resolved principal
 * is always safely bounded. Insufficient scope surfaces per tool call as a
 * structured tool error carrying the API's error code — the door cannot
 * know which scopes a not-yet-seen tool call needs, so it does not guess a
 * 403 challenge up front.
 *
 * No origin or host-header validation beyond the app-wide CORS middleware:
 * that guidance guards browser-adjacent local servers against DNS
 * rebinding, and this endpoint serves non-browser agents on a fixed public
 * origin with cookie-less bearer auth.
 */

import { Hono } from "hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServerForHost } from "@withmarfa/mcp/server";
import type { AppEnv } from "../middleware/auth.js";

export interface McpRouteDeps {
  /** Issuer base URL; also the base the in-process client addresses. */
  authBaseUrl: string;
  /** Whether an authorization server is mounted (hosted mode). Decides
   *  whether the 401 challenge can point at resource metadata. */
  hasAuthServer: boolean;
  /** Comma-list of toolsets to expose remotely. */
  toolsets?: string;
  /** Dispatches a request into the composed app, in process. Wired as a
   *  closure over the app after composition, called only at request time. */
  appFetch: (req: Request) => Response | Promise<Response>;
}

export function mcpRoutes(deps: McpRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const base = deps.authBaseUrl.replace(/\/+$/, "");
  const challenge = deps.hasAuthServer
    ? `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
    : "Bearer";

  const unauthorized = () =>
    new Response(
      JSON.stringify({
        error: {
          code: "unauthorized",
          message: "Authentication required",
        },
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "WWW-Authenticate": challenge,
        },
      },
    );

  router.on(["POST", "GET", "DELETE"], "/", async (c) => {
    // The app-wide bearer middleware has already run; an unresolved
    // principal is anonymous or carried an invalid token.
    if (!c.get("apiKey")) return unauthorized();

    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) return unauthorized();
    const bearer = authHeader.slice("Bearer ".length);

    // Per-request construction is deliberate: the server is bound to this
    // caller's bearer and nothing outlives the exchange, so no state can
    // leak between principals. The MCP package owns client construction —
    // depending on the SDK from here would close a workspace cycle — and
    // the dispatch override sends every tool call back through this app in
    // process: the same route handlers, middleware and enforcement an
    // external caller would hit, with zero network.
    const handler = createMcpHandler(
      () =>
        buildServerForHost({
          url: base,
          apiKey: bearer,
          toolsets: deps.toolsets,
          fetch: async (input, init) => deps.appFetch(new Request(input, init)),
        }),
      { legacy: "stateless" },
    );
    return handler.fetch(c.req.raw);
  });

  return router;
}
