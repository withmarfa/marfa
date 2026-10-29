import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  type TestContext,
} from "../test-utils.js";
import { connectMcp, MCP_URL } from "./test-client.js";
import { SERVER_INSTRUCTIONS } from "./server.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const LIST_TOOLS = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
};

function post(
  headers: Record<string, string>,
  body: unknown = LIST_TOOLS,
): Promise<Response> {
  return Promise.resolve(
    ctx.app.request(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("/mcp", () => {
  it("challenges a request without a credential with where to sign in", async () => {
    const response = await post({});
    expect(response.status).toBe(401);
    const base = ctx.config.authBaseUrl.replace(/\/+$/, "");
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("challenges a credential the instance does not know", async () => {
    const response = await post({ Authorization: "Bearer marfa_not_a_key" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(
      /^Bearer resource_metadata="/,
    );
  });

  it("refuses a browser page on an origin the owner did not approve", async () => {
    const response = await post({
      Authorization: `Bearer ${ctx.workingKey}`,
      Origin: "https://elsewhere.example",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "forbidden" },
    });
    // The witness: the same request from the instance's own origin is served.
    const own = await post({
      Authorization: `Bearer ${ctx.workingKey}`,
      Origin: new URL(ctx.config.authBaseUrl).origin,
    });
    expect(own.status).toBe(200);
  });

  it("serves a client of the 2026-07-28 revision", async () => {
    const client = await connectMcp(ctx, ctx.workingKey, {
      negotiation: "auto",
    });
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "marfa" });
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "marfa_create",
        "marfa_delete",
        "marfa_find",
        "marfa_get",
        "marfa_overview",
        "marfa_update",
      ]);
    } finally {
      await client.close();
    }
  });

  it("serves a client of an earlier revision that opens with initialize", async () => {
    const client = await connectMcp(ctx, ctx.workingKey, {
      negotiation: "legacy",
    });
    try {
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(6);
    } finally {
      await client.close();
    }
  });

  it("marks only marfa_create as reaching outside the instance", async () => {
    const client = await connectMcp(ctx, ctx.workingKey);
    try {
      const { tools } = await client.listTools();
      expect(
        Object.fromEntries(
          tools.map((tool) => [tool.name, tool.annotations?.openWorldHint]),
        ),
      ).toEqual({
        marfa_overview: false,
        marfa_find: false,
        marfa_get: false,
        marfa_create: true,
        marfa_update: false,
        marfa_delete: false,
      });
    } finally {
      await client.close();
    }
  });

  it("lists only the read tools to a credential that only reads", async () => {
    const key = await mintWorkingKey(ctx, {
      type_permissions: { "*": "read" },
    });
    const client = await connectMcp(ctx, key);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "marfa_find",
        "marfa_get",
        "marfa_overview",
      ]);
    } finally {
      await client.close();
    }
  });

  it("offers no tools to a credential that reaches no type", async () => {
    const client = await connectMcp(ctx, ctx.managementKey);
    try {
      expect(client.getServerCapabilities()?.tools).toBeUndefined();
    } finally {
      await client.close();
    }
    // The witness: a credential that reaches a type is offered tools.
    const reader = await connectMcp(ctx, ctx.workingKey);
    try {
      expect(reader.getServerCapabilities()?.tools).toBeDefined();
    } finally {
      await reader.close();
    }
  });

  it("refuses a write tool a read-only credential calls by name", async () => {
    const key = await mintWorkingKey(ctx, {
      type_permissions: { "*": "read" },
    });
    const client = await connectMcp(ctx, key);
    try {
      await expect(
        client.callTool({
          name: "marfa_create",
          arguments: { type: "core.note", properties: { title: "x" } },
        }),
      ).rejects.toThrow(/marfa_create/);
    } finally {
      await client.close();
    }
  });

  it("is not answered by GET without a credential", async () => {
    const response = await request(ctx.app, "GET", "/mcp");
    expect(response.status).toBe(401);
  });

  it("opens no stream and ends no session, since it keeps none", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const response = await request(ctx.app, method, "/mcp", {
        key: ctx.workingKey,
        headers: { Accept: "text/event-stream" },
      });
      expect(response.status, method).toBe(405);
    }
  });

  it("answers subscriptions/listen with method not found and opens no stream", async () => {
    const send = (method: string) =>
      Promise.resolve(
        ctx.app.request(MCP_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ctx.workingKey}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method,
            params: {
              ...(method === "subscriptions/listen"
                ? { notifications: { toolsListChanged: true } }
                : {}),
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {
                  name: "test",
                  version: "0.0.0",
                },
              },
            },
          }),
        }),
      );
    // The witness: the same envelope reaches the server for another method.
    const listed = await send("tools/list");
    expect(listed.status).toBe(200);
    await listed.body?.cancel();

    const response = await send("subscriptions/listen");
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("refuses a query key it does not take, once the credential is known", async () => {
    const response = await request(ctx.app, "POST", "/mcp?session=1", {
      key: ctx.workingKey,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { details: { unknown_parameters: string[] } };
    };
    expect(body.error.details.unknown_parameters).toEqual(["session"]);
    // The witness: without a credential the challenge comes first.
    expect((await request(ctx.app, "POST", "/mcp?session=1")).status).toBe(401);
  });
});
