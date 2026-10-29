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
 * It keeps no stream open: `subscriptions/listen` is answered as a method
 * it does not serve, before the SDK would hold a stream for it.
 *
 * A tool call by a signed-in app that the API refused for a scope the app
 * lacks and could be granted, before anything was written, is answered with
 * an `insufficient_scope` challenge naming that scope, so the app can ask the
 * person for it and call again.
 *
 * A browser page may call it only from an origin the owner approved, since
 * a bearer in a page's script is that page's to use; any other `Origin` is
 * refused, as the transport asks of a server.
 */
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import {
  type AppEnv,
  authorityId,
  credentialHandle,
} from "../middleware/auth.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { McpApi } from "./api.js";
import { nowMs } from "../clock.js";
import { mcpInsufficientScope, mcpUnauthorized } from "../auth/mcp-resource.js";
import type { ToolContext } from "./context.js";
import { type ToolFetchOptions, toolFetchFor } from "./file-fetch.js";
import { asInProcessCaller } from "../middleware/in-process-caller.js";
import { createMarfaMcpServer } from "./server.js";
import { isToolCall, scopeTheCallLacked } from "./step-up.js";

export interface McpDoorOptions {
  /** Where the instance is served, as its own links name it. */
  baseUrl: string;
  /** The build the instance runs, as the server's version. */
  version: string;
  /** The key a delete's confirmation token is signed with. */
  confirmKey: Buffer;
  /** How a tool fetches a file from a web address. */
  fetch: ToolFetchOptions;
  /** Whether a browser page on `origin` may call the endpoint. */
  originAllowed: (origin: string) => Promise<boolean>;
  /** Sends a request into the app in process, with the outer request's bindings. */
  dispatch: (request: Request, env: unknown) => Promise<Response>;
  now?: () => number;
}

const TOOL_CONTEXT = "marfa.tools";

const LISTEN = "subscriptions/listen";

function isListen(message: unknown): message is { id?: unknown } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { method?: unknown }).method === LISTEN
  );
}

/** The body as JSON, or `undefined` for the SDK to read and refuse itself. */
async function parsedBodyOf(request: Request): Promise<unknown> {
  if (request.method !== "POST") return undefined;
  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}

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
    const clientIp = c.get("clientIp") ?? null;
    const handle = credentialHandle(c);
    const ctx: ToolContext = {
      api: new McpApi({
        baseUrl: options.baseUrl,
        credential,
        dispatch: (request) =>
          asInProcessCaller({ clientIp, via: "mcp" }, () =>
            options.dispatch(request, env),
          ),
      }),
      typePermissions: apiKey.type_permissions,
      credentialHandle: handle,
      confirmKey: options.confirmKey,
      fetchFile: toolFetchFor(options.fetch, {
        handle,
        keyId: authorityId(c),
        clientIp,
      }),
      now: options.now ?? nowMs,
    };
    const parsedBody = await parsedBodyOf(c.req.raw);
    const listen = isListen(parsedBody) ? parsedBody : undefined;
    if (listen !== undefined) {
      return c.json({
        jsonrpc: "2.0",
        id: listen.id ?? null,
        error: { code: -32601, message: "Method not found" },
      });
    }
    const grant = c.get("oauthGrant");
    const response = await handler.fetch(c.req.raw, {
      ...(parsedBody !== undefined && { parsedBody }),
      authInfo: {
        token: credential,
        clientId: grant?.clientId ?? apiKey.id,
        scopes: grant === undefined ? [] : [...grant.scopes],
        extra: { [TOOL_CONTEXT]: ctx },
      },
    });
    if (grant === undefined || !isToolCall(parsedBody)) return response;
    const body = await response.text();
    const lacked = ctx.api.wrote
      ? undefined
      : scopeTheCallLacked(
          parsedBody,
          body,
          response.headers.get("content-type"),
        );
    if (lacked !== undefined) {
      return mcpInsufficientScope(options.baseUrl, "/mcp", [lacked]);
    }
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  });

  return router;
}
