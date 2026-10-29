import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@withmarfa/shared";
import {
  finalizeOpenAPISpec,
  OPENAPI_DOCUMENT_INFO,
} from "../openapi-finalize.js";
import {
  createTestContext,
  mintWorkingKey,
  type TestContext,
} from "../test-utils.js";
import { GROUP_PATHS, type McpGroup } from "./groups.js";
import { connectMcp } from "./test-client.js";
import {
  SERVER_INSTRUCTIONS,
  TOOL_GROUPS,
  TOOL_OPERATIONS,
  type ToolName,
} from "./server.js";

let ctx: TestContext;
/** A key that holds every permission, so every tool of a group is listed. */
let everything: string;

beforeAll(async () => {
  ctx = await createTestContext();
  everything = await mintWorkingKey(ctx, { permissions: [...PERMISSIONS] });
});

afterAll(async () => {
  await ctx.cleanup();
});

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

/**
 * What a group's endpoint may add to that. A client adds a group only when
 * the person wants its tools, so it costs only those conversations.
 */
const GROUP_BUDGET_CHARS = 10_000;

/** Tools whose annotations say they reach outside Marfa. */
const OPEN_WORLD: readonly ToolName[] = [
  "marfa_create",
  "marfa_manage_webhook",
];

describe("the MCP tools", () => {
  it("call only operations the API publishes", () => {
    const published = publishedOperationIds();
    const missing = Object.values(TOOL_OPERATIONS)
      .flat()
      .filter((operation) => !published.has(operation));
    expect(missing).toEqual([]);
  });

  it.each(Object.keys(GROUP_PATHS) as McpGroup[])(
    "of the %s group fit the client's context budget",
    async (group) => {
      const client = await connectMcp(ctx, everything, {
        path: GROUP_PATHS[group],
      });
      try {
        const { tools } = await client.listTools();
        const expected = (Object.keys(TOOL_GROUPS) as ToolName[]).filter(
          (tool) =>
            TOOL_GROUPS[tool] === "items" || TOOL_GROUPS[tool] === group,
        );
        expect(tools.map((tool) => tool.name).sort()).toEqual(expected.sort());
        expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
        const instructions = SERVER_INSTRUCTIONS;
        const size = JSON.stringify(tools).length + instructions.length;
        expect(size).toBeLessThanOrEqual(
          TOOL_LIST_BUDGET_CHARS + (group === "items" ? 0 : GROUP_BUDGET_CHARS),
        );
        // OpenAI asks for what matters in the first 512 characters.
        expect(instructions.length).toBeLessThanOrEqual(512);
        for (const tool of tools) {
          expect(tool.annotations?.readOnlyHint).toBeDefined();
          expect(tool.annotations?.openWorldHint).toBe(
            OPEN_WORLD.includes(tool.name as ToolName),
          );
          expect(tool.outputSchema).toBeDefined();
        }
      } finally {
        await client.close();
      }
    },
  );
});
