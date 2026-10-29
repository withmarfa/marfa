import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { callTool, connectMcp, payloadOf } from "./test-client.js";

/** The proxy in front of the instance, and the client it speaks for. */
const PROXY = "127.0.0.1";
const CLIENT = "203.0.113.7";

let ctx: TestContext;
let client: Client;

beforeAll(async () => {
  ctx = await createTestContext({ trustedProxyHeader: "x-real-ip" });
  client = await connectMcp(ctx, ctx.workingKey, {
    peer: PROXY,
    headers: { "X-Real-IP": CLIENT },
  });
});

afterAll(async () => {
  await client.close();
  await ctx.cleanup();
});

async function createdEntry(id: string) {
  const page = await ctx.storage.audit.list({
    action: "item.create",
    resource_id: id,
  });
  expect(page.data).toHaveLength(1);
  return page.data[0];
}

describe("an MCP tool call's writes in the audit log", () => {
  it("records the API's own write with the client's address and no MCP mark", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      peer: PROXY,
      headers: { "X-Real-IP": CLIENT },
      body: { type: "core.note", properties: { body: "direct" } },
    });
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { id: string } };
    const entry = await createdEntry(item.id);
    expect(entry?.client_ip).toBe(CLIENT);
    expect(entry?.details).not.toHaveProperty("via");
  });

  it("records the address the MCP request came from and marks the write as made through MCP", async () => {
    const created = payloadOf(
      await callTool(client, "marfa_create", {
        type: "core.note",
        properties: { body: "through MCP" },
      }),
    );
    const entry = await createdEntry(created.id as string);
    expect(entry?.client_ip).toBe(CLIENT);
    expect(entry?.details).toMatchObject({ via: "mcp" });
  });
});
