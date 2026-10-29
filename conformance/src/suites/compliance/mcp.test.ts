import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackEdge,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import {
  ALL_TOOLS,
  callTool,
  connectMcp,
  READ_TOOLS,
  toolError,
  toolNames,
  toolResult,
  type McpConnection,
} from "../../utils/mcp.js";

/**
 * The MCP endpoint (`mcp/*`): who may call it, which tools a credential is
 * offered, and how the tools that change items guard what they change.
 */

let ctx: TestContext;
let client: MarfaClient;
let apiUrl: string;
let apiKey: string;
let mcp: McpConnection;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "mcp",
  ));
  mcp = await connectMcp(apiUrl, apiKey);
});

afterAll(async () => {
  await mcp?.close();
  await cleanup(ctx);
});

function post(headers: Record<string, string>): Promise<Response> {
  return fetch(new URL("/mcp", apiUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
}

/** A key of this file's own, with the type map given. */
async function keyWith(
  label: string,
  typePermissions: Record<string, "read" | "write">,
): Promise<string> {
  const minted = await client.createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    permissions: [],
    type_permissions: typePermissions,
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  return minted.data.key;
}

async function note(body: string): Promise<{ id: string; version: number }> {
  const made = await client.createItem({
    type: "core.note",
    properties: { body },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return { id: made.data.item.id, version: made.data.item.version };
}

async function stateOf(id: string): Promise<string | null> {
  const read = await client.getItem(id);
  return read.ok ? read.data.item.state : null;
}

/** A note that is `parent-of` `children` other notes. */
async function family(children: number): Promise<string> {
  const parent = await note("parent");
  for (let i = 0; i < children; i++) {
    await addChild(parent);
  }
  return parent.id;
}

async function addChild(parent: { id: string } | string): Promise<string> {
  const child = await note("child");
  const edge = await client.createEdge({
    source_id: typeof parent === "string" ? parent : parent.id,
    target_id: child.id,
    edge_type: "parent-of",
  });
  expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
  trackEdge(ctx, edge.data.edge.id);
  return child.id;
}

describe("who may call /mcp", () => {
  it("answers a request without a credential with 401 and a Bearer challenge naming the endpoint's resource metadata", async () => {
    const response = await post({});
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(
      /^Bearer resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp"$/,
    );
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("refuses a request from an origin the owner did not approve with 403, where the server's own origin is served", async () => {
    const foreign = await post({
      Authorization: `Bearer ${apiKey}`,
      Origin: "https://elsewhere.example",
    });
    expect(foreign.status).toBe(403);
    const body = (await foreign.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");

    const own = await post({
      Authorization: `Bearer ${apiKey}`,
      Origin: new URL(apiUrl).origin,
    });
    expect(own.status).toBe(200);
  });
});

describe("protocol revisions", () => {
  it("serves a client of revision 2026-07-28 without an initialize handshake", async () => {
    const modern = await connectMcp(apiUrl, apiKey, "2026-07-28");
    try {
      expect(await toolNames(modern)).toEqual(ALL_TOOLS);
      expect(modern.methods).not.toContain("initialize");
    } finally {
      await modern.close();
    }
  });

  it("serves a client of revision 2025-11-25 that opens with initialize the same tools", async () => {
    const legacy = await connectMcp(apiUrl, apiKey, "2025-11-25");
    try {
      expect(legacy.methods[0]).toBe("initialize");
      expect(await toolNames(legacy)).toEqual(ALL_TOOLS);
    } finally {
      await legacy.close();
    }
  });

  it("answers subscriptions/listen with method not found and opens no stream", async () => {
    const send = (method: string) =>
      fetch(new URL("/mcp", apiUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
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
                name: "conformance",
                version: "0.0.0",
              },
            },
          },
        }),
      });
    // The witness: the same request is served for a method the endpoint serves.
    const listed = await send("tools/list");
    expect(listed.status).toBe(200);
    await listed.body?.cancel();

    const listen = await send("subscriptions/listen");
    expect(listen.headers.get("content-type")).toMatch(/^application\/json/);
    const body = (await listen.json()) as {
      id: number;
      error: { code: number };
    };
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32601);
  });
});

describe("which tools a credential is offered", () => {
  it("lists the six tools to a credential that writes a type", async () => {
    const writer = await connectMcp(
      apiUrl,
      await keyWith("writer", { "core.note": "write" }),
    );
    try {
      expect(await toolNames(writer)).toEqual(ALL_TOOLS);
    } finally {
      await writer.close();
    }
  });

  it("marks marfa_create as reaching outside the instance and no other tool", async () => {
    const { tools } = await mcp.client.listTools();
    const hints = Object.fromEntries(
      tools.map((tool) => [tool.name, tool.annotations?.openWorldHint]),
    );
    expect(Object.keys(hints).sort()).toEqual(ALL_TOOLS);
    for (const name of ALL_TOOLS) {
      expect(hints[name], name).toBe(name === "marfa_create");
    }
  });

  it("lists only marfa_overview, marfa_find and marfa_get to a credential that only reads", async () => {
    const reader = await connectMcp(
      apiUrl,
      await keyWith("reader", { "core.note": "read" }),
    );
    try {
      expect(await toolNames(reader)).toEqual(READ_TOOLS);
    } finally {
      await reader.close();
    }
  });

  it("offers no tools to a credential whose type map reaches no type", async () => {
    const none = await connectMcp(apiUrl, await keyWith("none", {}));
    try {
      expect(none.client.getServerCapabilities()?.tools).toBeUndefined();
    } finally {
      await none.close();
    }
  });
});

describe("calling a tool", () => {
  it("refuses a tool call naming an argument the tool does not take", async () => {
    const misspelled = await callTool(mcp, "marfa_find", { typ: "core.note" });
    expect(misspelled.isError).toBe(true);
    expect(misspelled.text).toMatch(/typ/);
    // The witness: the argument spelled right is taken.
    toolResult(await callTool(mcp, "marfa_find", { type: "core.note" }));
  });
});

describe("marfa_update", () => {
  it("answers a stale version with version_conflict, the item as it is now and the fields changed since", async () => {
    const made = await note("one");
    const moved = await client.updateItem(made.id, {
      version: made.version,
      properties: { body: "two" },
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);

    const error = toolError(
      await callTool(mcp, "marfa_update", {
        id: made.id,
        version: made.version,
        properties: { title: "Renamed", body: "three" },
        add_tags: ["late"],
      }),
    );
    expect(error.code).toBe("version_conflict");
    expect(error.current).toMatchObject({
      id: made.id,
      version: moved.data.item.version,
    });
    expect(error.conflicting_fields).toEqual(["body"]);
  });

  it("leaves the item unchanged when called with a stale version", async () => {
    const made = await note("one");
    const target = await note("target");
    const moved = await client.updateItem(made.id, {
      version: made.version,
      properties: { body: "two" },
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);

    // A field change that collides with nothing made since is refused too.
    const change = {
      id: made.id,
      properties: { title: "Renamed" },
      add_tags: ["late"],
      add_edges: [{ edge_type: "references", target_id: target.id }],
      state: "archived",
    };
    const error = toolError(
      await callTool(mcp, "marfa_update", { ...change, version: made.version }),
    );
    expect(error.conflicting_fields).toEqual([]);
    const after = await client.getItem(made.id);
    expect(after.data.item.version).toBe(moved.data.item.version);
    expect(after.data.item.state).toBe("active");
    expect(after.data.item.properties).not.toHaveProperty("title");
    expect(after.data.metadata.tags).not.toContain("late");
    expect(after.data.item.edges?.references?.data ?? []).toEqual([]);
    // The witness: the same call at the current version makes every change.
    toolResult(
      await callTool(mcp, "marfa_update", {
        ...change,
        version: moved.data.item.version,
      }),
    );
    const changed = await client.getItem(made.id);
    expect(changed.data.item.state).toBe("archived");
    expect(changed.data.item.properties).toMatchObject({ title: "Renamed" });
    expect(changed.data.metadata.tags).toContain("late");
    expect(changed.data.item.edges?.references?.data).toHaveLength(1);
  });
});

describe("marfa_delete", () => {
  it("trashes nothing when called without a confirmation", async () => {
    const parent = await family(1);
    const preview = toolResult(
      await callTool(mcp, "marfa_delete", { ids: [parent] }),
    );
    expect(preview.total).toBe(2);
    expect(typeof preview.confirm).toBe("string");
    expect(await stateOf(parent)).toBe("active");
  });

  it("trashes the items with the confirmation the preview gave", async () => {
    const parent = await family(1);
    const preview = toolResult(
      await callTool(mcp, "marfa_delete", { ids: [parent] }),
    );
    const done = toolResult(
      await callTool(mcp, "marfa_delete", {
        ids: [parent],
        confirm: preview.confirm,
      }),
    );
    expect(done.trashed).toEqual([parent]);
    expect(await stateOf(parent)).toBeNull();
  });

  it("refuses a confirmation when what would be trashed changed since the preview", async () => {
    const parent = await family(1);
    const preview = toolResult(
      await callTool(mcp, "marfa_delete", { ids: [parent] }),
    );
    await addChild(parent);
    const error = toolError(
      await callTool(mcp, "marfa_delete", {
        ids: [parent],
        confirm: preview.confirm,
      }),
    );
    expect(error.code).toBe("confirmation_stale");
    expect(error.total).toBe(3);
    expect(await stateOf(parent)).toBe("active");
  });

  it("refuses a confirmation when an item past the preview's list changed", async () => {
    const parent = await note("parent");
    const children: string[] = [];
    for (let i = 0; i < 102; i++) children.push(await addChild(parent));
    const preview = toolResult(
      await callTool(mcp, "marfa_delete", { ids: [parent.id] }),
    );
    const listed = new Set(
      (
        preview.preview as { also_trashes: { id: string }[] }[]
      )[0]?.also_trashes.map((item) => item.id),
    );
    const unlisted = children.find((child) => !listed.has(child));
    if (unlisted === undefined) throw new Error("every child is listed");
    const read = await client.getItem(unlisted);
    const edited = await client.updateItem(unlisted, {
      version: read.data.item.version,
      properties: { body: "edited" },
    });
    expect(edited.ok, JSON.stringify(edited.error)).toBe(true);

    const error = toolError(
      await callTool(mcp, "marfa_delete", {
        ids: [parent.id],
        confirm: preview.confirm,
      }),
    );
    expect(error.code).toBe("confirmation_stale");
    expect(error.total).toBe(103);
    expect(await stateOf(parent.id)).toBe("active");
  });

  it("refuses a confirmation another credential got", async () => {
    const parent = await family(0);
    const preview = toolResult(
      await callTool(mcp, "marfa_delete", { ids: [parent] }),
    );
    const other = await connectMcp(
      apiUrl,
      await keyWith("other-deleter", { "*": "write" }),
    );
    try {
      const error = toolError(
        await callTool(other, "marfa_delete", {
          ids: [parent],
          confirm: preview.confirm,
        }),
      );
      expect(error.code).toBe("confirmation_stale");
    } finally {
      await other.close();
    }
    expect(await stateOf(parent)).toBe("active");
  });
});
