/**
 * The MCP endpoint, `/mcp`: Marfa's tools over Streamable HTTP, for an
 * agent holding an API key or a signed-in app's token.
 *
 * Every tool calls the public API in process with the caller's own bearer,
 * so the API's checks decide what a tool may do and the endpoint decides
 * nothing of its own beyond who may call it. The 2026-07-28 revision is
 * served statelessly, and a client of an earlier revision that opens with
 * `initialize` is served by the SDK's stateless fallback from the same
 * tools.
 *
 * A browser page may call it only from an origin the owner approved, since
 * a bearer in a page's script is that page's to use; any other `Origin` is
 * refused, as the transport asks of a server.
 */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { PublicFetcher } from "../net/public-fetch.js";
import { type AppEnv, credentialHandle } from "../middleware/auth.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { McpApi } from "./api.js";
import { nowMs } from "../clock.js";
import { mcpUnauthorized } from "./challenge.js";
import type { ToolContext } from "./context.js";
import { createMarfaMcpServer } from "./server.js";

export interface McpDoorOptions {
  /** Where the instance is served, as its own links name it. */
  baseUrl: string;
  /** The build the instance runs, as the server's version. */
  version: string;
  /** The key a delete's confirmation token is signed with. */
  confirmKey: Buffer;
  fetchFile: PublicFetcher;
  /** Whether a browser page on `origin` may call the endpoint. */
  originAllowed: (origin: string) => Promise<boolean>;
  /** Sends a request into the app in process, with the outer request's bindings. */
  dispatch: (request: Request, env: unknown) => Promise<Response>;
  now?: () => number;
}

const TOOL_CONTEXT = "marfa.tools";

export function mcpRoutes(options: McpDoorOptions): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const ctx = authInfo?.extra?.[TOOL_CONTEXT] as ToolContext | undefined;
      if (ctx === undefined) {
        throw new Error("An MCP request reached the server without a caller.");
      }
      return createMarfaMcpServer(ctx, options.version);
    },
    { legacy: "stateless" },
  );

  router.on(["POST", "GET", "DELETE"], "/", async (c) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !(await options.originAllowed(origin))) {
      return c.json(
        new MarfaError(
          ErrorCode.FORBIDDEN,
          "This origin may not call the MCP endpoint.",
        ).toResponse(),
        403,
      );
    }
    const apiKey = c.get("apiKey");
    const header = c.req.header("authorization");
    if (
      apiKey === undefined ||
      c.get("authType") === undefined ||
      header?.startsWith("Bearer ") !== true
    ) {
      return mcpUnauthorized(options.baseUrl, "/mcp");
    }
    refuseUndeclaredKeysOf(c.req.url, []);
    const credential = header.slice("Bearer ".length);
    const env: unknown = c.env;
    const ctx: ToolContext = {
      api: new McpApi({
        baseUrl: options.baseUrl,
        credential,
        dispatch: (request) => options.dispatch(request, env),
      }),
      typePermissions: apiKey.type_permissions,
      credentialHandle: credentialHandle(c),
      confirmKey: options.confirmKey,
      fetchFile: options.fetchFile,
      now: options.now ?? nowMs,
    };
    const grant = c.get("oauthGrant");
    return handler.fetch(c.req.raw, {
      authInfo: {
        token: credential,
        clientId: grant?.clientId ?? apiKey.id,
        scopes: grant === undefined ? [] : [...grant.scopes],
        extra: { [TOOL_CONTEXT]: ctx },
      },
    });
  });

  return router;
}
