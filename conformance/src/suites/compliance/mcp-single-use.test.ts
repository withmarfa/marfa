import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import {
  callTool,
  connectMcp,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";

/**
 * A `marfa_delete` confirmation works once (`mcp/delete-single-use`,
 * `mcp/delete-repeated`).
 */

let ctx: TestContext;
let client: MarfaClient;
let mcp: McpConnection;

beforeAll(async () => {
  let apiUrl: string;
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "mcp-single-use",
  ));
  const minted = await client.createKey({
    label: `${ctx.source}-deleter`,
    source: `${ctx.source}-deleter`,
    permissions: [],
    type_permissions: { "*": "write" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  mcp = await connectMcp(apiUrl, minted.data.key);
});

afterAll(async () => {
  await mcp?.close();
  await cleanup(ctx);
});

async function note(body: string): Promise<string> {
  const made = await client.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function stateOf(id: string): Promise<string | null> {
  const read = await client.getItem(id);
  return read.ok ? read.data.item.state : null;
}

/** Trashes a new note on its confirmation, then restores it. */
async function trashedAndRestored(): Promise<{ id: string; confirm: string }> {
  const id = await note("confirmed once");
  const preview = toolResult(await callTool(mcp, "marfa_delete", { ids: [id] }));
  const confirm = String(preview.confirm);
  toolResult(await callTool(mcp, "marfa_delete", { ids: [id], confirm }));
  expect(await stateOf(id)).toBeNull();
  const restored = await client.restoreItem(id);
  expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
  expect(await stateOf(id)).toBe("active");
  return { id, confirm };
}

describe("a delete confirmation", () => {
  it("moves nothing to the trash again on a confirmation an earlier call used", async () => {
    const { id, confirm } = await trashedAndRestored();
    const again = await callTool(mcp, "marfa_delete", { ids: [id], confirm });
    expect(again.isError, JSON.stringify(again.body)).toBe(false);
    expect(await stateOf(id)).toBe("active");
    // The witness: a confirmation from a new preview moves it.
    const preview = toolResult(await callTool(mcp, "marfa_delete", { ids: [id] }));
    toolResult(
      await callTool(mcp, "marfa_delete", {
        ids: [id],
        confirm: String(preview.confirm),
      }),
    );
    expect(await stateOf(id)).toBeNull();
  });

  it("says a repeated confirmation already moved the items to the trash", async () => {
    const { id, confirm } = await trashedAndRestored();
    const again = toolResult(
      await callTool(mcp, "marfa_delete", { ids: [id], confirm }),
    );
    expect(again.already_trashed).toBe(true);
    expect(again.total).toBe(1);
    const first = await note("first answer");
    const preview = toolResult(
      await callTool(mcp, "marfa_delete", { ids: [first] }),
    );
    const done = toolResult(
      await callTool(mcp, "marfa_delete", {
        ids: [first],
        confirm: String(preview.confirm),
      }),
    );
    expect(done.already_trashed).toBeUndefined();
  });
});
