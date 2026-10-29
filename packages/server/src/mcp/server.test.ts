import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "../openapi-finalize.js";
import { createTestContext, type TestContext } from "../test-utils.js";
import { connectMcp } from "./test-client.js";
import { SERVER_INSTRUCTIONS, TOOL_OPERATIONS } from "./server.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * Operations a tool calls that are not published yet, called through
 * `McpApi.raw`. When one is published this test fails: call it through the
 * typed client and take it off this list.
 */
const UNPUBLISHED_OPERATIONS = new Set(["listViewItems"]);

function publishedOperationIds(): Set<string> {
  const document = finalizeOpenAPISpec(
    ctx.app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: OPENAPI_DOCUMENT_INFO,
    }),
  );
  const ids = new Set<string>();
  for (const item of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(item as Record<string, unknown>)) {
      const id = (operation as { operationId?: unknown }).operationId;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/**
 * What a client puts in front of the model before it calls anything: the
 * instructions and the tool list. A client loads every tool's definition
 * into the model's context, so a list that grows past this costs every
 * conversation the person has.
 */
const TOOL_LIST_BUDGET_CHARS = 16_000;

describe("the MCP tools", () => {
  it("call only operations the API publishes", () => {
    const published = publishedOperationIds();
    const missing: string[] = [];
    const nowPublished: string[] = [];
    for (const operations of Object.values(TOOL_OPERATIONS)) {
      for (const operation of operations) {
        if (UNPUBLISHED_OPERATIONS.has(operation)) {
          if (published.has(operation)) nowPublished.push(operation);
        } else if (!published.has(operation)) {
          missing.push(operation);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(nowPublished).toEqual([]);
  });

  it("fit the client's context budget", async () => {
    const client = await connectMcp(ctx, ctx.workingKey);
    try {
      const { tools } = await client.listTools();
      expect(Object.keys(TOOL_OPERATIONS).sort()).toEqual(
        tools.map((tool) => tool.name).sort(),
      );
      const size = JSON.stringify(tools).length + SERVER_INSTRUCTIONS.length;
      expect(size).toBeLessThanOrEqual(TOOL_LIST_BUDGET_CHARS);
      // OpenAI asks for what matters in the first 512 characters.
      expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
      }
    } finally {
      await client.close();
    }
  });
});
