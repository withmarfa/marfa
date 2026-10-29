/**
 * An MCP client connected to a test app's `/mcp` in process, for the
 * endpoint's tests.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { TestContext } from "../test-utils.js";

export type Negotiation = "legacy" | "auto";

export const MCP_URL = "http://localhost/mcp";

export async function connectMcp(
  ctx: Pick<TestContext, "app">,
  credential: string,
  options: {
    negotiation?: Negotiation;
    headers?: Record<string, string>;
    /** The address the connection comes from, as `request`'s `peer`. */
    peer?: string;
  } = {},
): Promise<Client> {
  const env =
    options.peer === undefined
      ? undefined
      : { incoming: { socket: { remoteAddress: options.peer } } };
  const client = new Client(
    { name: "marfa-test", version: "0.0.0" },
    { versionNegotiation: { mode: options.negotiation ?? "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) =>
      Promise.resolve(ctx.app.request(String(url), init, env)),
    requestInit: {
      headers: { Authorization: `Bearer ${credential}`, ...options.headers },
    },
  });
  await client.connect(transport);
  return client;
}

/** A tool's answer, read from its one text block. */
export interface ToolAnswer {
  isError: boolean;
  body: Record<string, unknown>;
  structured: Record<string, unknown> | undefined;
  text: string;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: args });
  const block = result.content[0];
  const text = block?.type === "text" ? block.text : "";
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A protocol-level refusal, such as invalid arguments, is plain text.
  }
  return {
    isError: result.isError === true,
    body,
    structured: result.structuredContent as Record<string, unknown> | undefined,
    text,
  };
}

/** The error a failed tool answer carries. */
export function errorOf(answer: ToolAnswer): Record<string, unknown> {
  if (!answer.isError) {
    throw new Error(`expected an error, got ${answer.text}`);
  }
  return answer.body.error as Record<string, unknown>;
}

/** The payload a successful tool answer carries. */
export function payloadOf(answer: ToolAnswer): Record<string, unknown> {
  if (answer.isError) throw new Error(`the tool failed: ${answer.text}`);
  return answer.body;
}
