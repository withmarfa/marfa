import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackKey,
  trackType,
  trackWebhook,
} from "../../utils/setup.js";
import {
  ADMIN_TOOLS,
  ALL_TOOLS,
  callTool,
  connectMcp,
  READ_TOOLS,
  SCHEMA_TOOLS,
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

/** A key of this file's own, with the type map and permissions given. */
async function keyWith(
  label: string,
  typePermissions: Record<string, "read" | "write">,
  reach: {
    permissions?: string[];
    metadata_permissions?: Record<string, "read" | "write">;
  } = {},
): Promise<string> {
  const minted = await client.createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    permissions: reach.permissions ?? [],
    type_permissions: typePermissions,
    ...(reach.metadata_permissions !== undefined && {
      metadata_permissions: reach.metadata_permissions,
    }),
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

describe("marfa_get", () => {
  /** How long a tool answer's text may be. */
  const ANSWER_BUDGET = 40_000;

  async function readByParts(id: string, field: string, from: number) {
    let text = "";
    let offset: number | null = from;
    while (offset !== null) {
      const answer = await callTool(mcp, "marfa_get", {
        ids: [id],
        field,
        offset,
      });
      expect(answer.text.length).toBeLessThanOrEqual(ANSWER_BUDGET);
      const part = toolResult(answer);
      text += part.text as string;
      offset = part.next_offset as number | null;
    }
    return text;
  }

  it("cuts a long text field to fit the answer and reads the rest by offset", async () => {
    const long = 'a "quoted" line\n'.repeat(6_000);
    const { id } = await note(long);
    const answer = await callTool(mcp, "marfa_get", { ids: [id] });
    expect(answer.text.length).toBeLessThanOrEqual(ANSWER_BUDGET);
    const got = toolResult(answer);
    const [cut] = got.cut as { field: string; next_offset: number }[];
    expect(cut).toMatchObject({ id, field: "body" });
    const [item] = got.items as { properties: { body: string } }[];
    const rest = await readByParts(id, "body", cut?.next_offset ?? 0);
    expect((item?.properties.body ?? "") + rest).toBe(long);
  });

  it("leaves out a large list field, names it as cut and reads it back as JSON text", async () => {
    const steps = Array.from({ length: 4_000 }, (_, i) => ({
      step: i,
      done: false,
    }));
    const made = await client.createItem({
      type: "core.note",
      properties: { body: "plan", steps },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    const id = made.data.item.id;

    const answer = await callTool(mcp, "marfa_get", { ids: [id] });
    expect(answer.text.length).toBeLessThanOrEqual(ANSWER_BUDGET);
    const got = toolResult(answer);
    const [item] = got.items as { properties: Record<string, unknown> }[];
    expect(item?.properties.body).toBe("plan");
    expect(item?.properties).not.toHaveProperty("steps");
    const [cut] = got.cut as { field: string; next_offset: number }[];
    expect(cut).toMatchObject({ id, field: "steps", json: true });
    expect(
      JSON.parse(await readByParts(id, "steps", cut?.next_offset ?? 0)),
    ).toEqual(steps);
  });

  it("leaves out the items that do not fit and names them", async () => {
    const tags = Array.from(
      { length: 100 },
      (_, i) => `${String(i).padStart(3, "0")}-${"t".repeat(120)}`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const made = await client.createItem({
        type: "core.note",
        properties: { body: `tagged ${String(i)}` },
        tags,
      });
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      trackItem(ctx, made.data.item.id);
      ids.push(made.data.item.id);
    }
    const answer = await callTool(mcp, "marfa_get", { ids });
    expect(answer.text.length).toBeLessThanOrEqual(ANSWER_BUDGET);
    const got = toolResult(answer);
    const returned = (got.items as { id: string }[]).map((item) => item.id);
    const left = got.not_returned as string[];
    expect(returned.length).toBeGreaterThan(0);
    expect(left.length).toBeGreaterThan(0);
    expect([...returned, ...left]).toEqual(ids);
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

  it("trashes every named item and an item they share, counting it once", async () => {
    // `parent-of` gives a child one parent, so the shared item hangs from a
    // cascading edge type that allows several.
    const edgeType = `mock.shares.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id: edgeType,
      label: "Shares",
      cardinality: "many-to-many",
      cascade_on_delete: "cascade",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackEdgeType(ctx, edgeType);
    const a = await note("first parent");
    const b = await note("second parent");
    const shared = (await note("shared")).id;
    for (const parent of [a, b]) {
      const edge = await client.createEdge({
        source_id: parent.id,
        target_id: shared,
        edge_type: edgeType,
      });
      expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
      trackEdge(ctx, edge.data.edge.id);
    }
    const ids = [a.id, b.id];
    const preview = toolResult(await callTool(mcp, "marfa_delete", { ids }));
    expect(preview.total).toBe(3);
    const done = toolResult(
      await callTool(mcp, "marfa_delete", { ids, confirm: preview.confirm }),
    );
    expect(done).toMatchObject({ trashed: ids, total: 3 });
    for (const id of [...ids, shared]) expect(await stateOf(id)).toBeNull();
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

describe("the schema and admin endpoints", () => {
  /** A key that writes every type, registers types and changes the schema. */
  async function schemaKey(label: string): Promise<string> {
    return keyWith(
      label,
      { "*": "write" },
      { permissions: ["schema.write"], metadata_permissions: { "*": "write" } },
    );
  }

  it("lists the six tools and every schema tool at /mcp/schema to a credential that may use each", async () => {
    const schema = await connectMcp(
      apiUrl,
      await schemaKey("schema-lister"),
      "2026-07-28",
      "/mcp/schema",
    );
    try {
      expect(await toolNames(schema)).toEqual(
        [...ALL_TOOLS, ...SCHEMA_TOOLS].sort(),
      );
    } finally {
      await schema.close();
    }
  });

  it("lists only the read tools and marfa_search_docs at /mcp/schema to a credential that only reads", async () => {
    const reader = await connectMcp(
      apiUrl,
      await keyWith("schema-reader", { "core.note": "read" }),
      "2026-07-28",
      "/mcp/schema",
    );
    try {
      expect(await toolNames(reader)).toEqual(
        [...READ_TOOLS, "marfa_search_docs"].sort(),
      );
    } finally {
      await reader.close();
    }
  });

  it("lists each admin tool at /mcp/admin only to a credential that holds its permission", async () => {
    const admin = await connectMcp(
      apiUrl,
      await keyWith(
        "admin-lister",
        { "core.note": "write" },
        { permissions: ["audit.read", "keys.mint", "webhooks.manage"] },
      ),
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      expect(await toolNames(admin)).toEqual(
        [
          ...ALL_TOOLS,
          ...ADMIN_TOOLS.filter((t) => t !== "marfa_health"),
        ].sort(),
      );
    } finally {
      await admin.close();
    }
    const reader = await connectMcp(
      apiUrl,
      await keyWith("admin-reader", { "core.note": "read" }),
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      expect(await toolNames(reader)).toEqual(READ_TOOLS);
    } finally {
      await reader.close();
    }
  });

  it("lists every admin tool at /mcp/admin to a credential that holds every permission and reaches no type", async () => {
    const management = process.env.MARFA_MANAGEMENT_KEY;
    if (!management) throw new Error("MARFA_MANAGEMENT_KEY is required");
    const admin = await connectMcp(
      apiUrl,
      management,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      expect(await toolNames(admin)).toEqual(ADMIN_TOOLS);
      const health = toolResult(await callTool(admin, "marfa_health", {}));
      expect(health.health).toMatchObject({ status: expect.any(String) });
    } finally {
      await admin.close();
    }
  });

  it("marks marfa_create and marfa_manage_webhook as reaching outside the instance and no other tool", async () => {
    const admin = await connectMcp(
      apiUrl,
      await keyWith(
        "open-world",
        { "*": "write" },
        {
          permissions: [
            "schema.write",
            "audit.read",
            "keys.mint",
            "webhooks.manage",
          ],
          metadata_permissions: { "*": "write" },
        },
      ),
      "2026-07-28",
      "/mcp/admin",
    );
    const schema = await connectMcp(
      apiUrl,
      await schemaKey("open-world-schema"),
      "2026-07-28",
      "/mcp/schema",
    );
    try {
      for (const connection of [admin, schema]) {
        const { tools } = await connection.client.listTools();
        for (const tool of tools) {
          expect(tool.annotations?.openWorldHint, tool.name).toBe(
            tool.name === "marfa_create" ||
              tool.name === "marfa_manage_webhook",
          );
        }
      }
    } finally {
      await admin.close();
      await schema.close();
    }
  });
});

describe("marfa_revoke_key", () => {
  let admin: McpConnection;

  beforeAll(async () => {
    admin = await connectMcp(
      apiUrl,
      await keyWith("revoker", {}, { permissions: ["keys.mint"] }),
      "2026-07-28",
      "/mcp/admin",
    );
  });

  afterAll(async () => {
    await admin?.close();
  });

  /** A key the revoker made, so it is one the revoker may revoke. */
  async function target(label: string): Promise<{ id: string; key: string }> {
    const made = toolResult(
      await callTool(admin, "marfa_manage_key", {
        action: "make",
        label: `${ctx.source}-${label}`,
        source: `${ctx.source}-${label}`,
      }),
    );
    const id = (made.key as { id: string }).id;
    trackKey(ctx, id);
    return { id, key: made.secret as string };
  }

  async function works(key: string): Promise<boolean> {
    const response = await fetch(new URL("/keys/current", apiUrl), {
      headers: { Authorization: `Bearer ${key}` },
    });
    await response.body?.cancel();
    return response.status === 200;
  }

  it("revokes nothing when called without a confirmation", async () => {
    const { id, key } = await target("revoke-preview");
    const preview = toolResult(
      await callTool(admin, "marfa_revoke_key", { id }),
    );
    expect(preview.key).toMatchObject({ id });
    expect(typeof preview.confirm).toBe("string");
    expect(await works(key)).toBe(true);
  });

  it("revokes the key with the confirmation the preview gave", async () => {
    const { id, key } = await target("revoke-confirmed");
    const preview = toolResult(
      await callTool(admin, "marfa_revoke_key", { id }),
    );
    const done = toolResult(
      await callTool(admin, "marfa_revoke_key", {
        id,
        confirm: preview.confirm,
      }),
    );
    expect(done.revoked).toBe(id);
    expect(await works(key)).toBe(false);
  });

  it("refuses a revoke confirmation another credential got", async () => {
    const { id, key } = await target("revoke-replayed");
    const preview = toolResult(
      await callTool(admin, "marfa_revoke_key", { id }),
    );
    // The management key holds keys.manage, so it reaches the same key.
    const management = process.env.MARFA_MANAGEMENT_KEY;
    if (!management) throw new Error("MARFA_MANAGEMENT_KEY is required");
    const other = await connectMcp(
      apiUrl,
      management,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      const error = toolError(
        await callTool(other, "marfa_revoke_key", {
          id,
          confirm: preview.confirm,
        }),
      );
      expect(error.code).toBe("confirmation_stale");
      expect(error.key).toMatchObject({ id });
    } finally {
      await other.close();
    }
    expect(await works(key)).toBe(true);
  });
});

describe("marfa_manage_webhook", () => {
  let key: string;
  let owner: MarfaClient;
  let admin: McpConnection;

  beforeAll(async () => {
    key = await keyWith("hooks", {}, { permissions: ["webhooks.manage"] });
    owner = new MarfaClient({ baseUrl: apiUrl, apiKey: key });
    admin = await connectMcp(apiUrl, key, "2026-07-28", "/mcp/admin");
  });

  afterAll(async () => {
    await admin?.close();
  });

  /** A receiver address no test listens on; nothing here waits for a delivery. */
  function address(path: string): string {
    return `http://127.0.0.1:9/${ctx.runId}/${path}`;
  }

  async function hookIds(): Promise<string[]> {
    const listed = await owner.listWebhooks();
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    return listed.data.data.map((hook) => hook.id);
  }

  async function made(path: string): Promise<string> {
    const args = {
      action: "make",
      url: address(path),
      events: ["item.created"],
    };
    const preview = toolResult(
      await callTool(admin, "marfa_manage_webhook", args),
    );
    const done = toolResult(
      await callTool(admin, "marfa_manage_webhook", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    const id = (done.webhook as { id: string }).id;
    trackWebhook(ctx, id, owner);
    return id;
  }

  it("makes and changes no webhook when called without a confirmation", async () => {
    const id = await made("preview-change");
    const before = await hookIds();
    const make = toolResult(
      await callTool(admin, "marfa_manage_webhook", {
        action: "make",
        url: address("preview-make"),
        events: ["item.created", "edge.created"],
        type_filter: "core.note",
      }),
    );
    expect(make.preview).toMatchObject({
      url: address("preview-make"),
      host: "127.0.0.1:9",
      events: ["item.created", "edge.created"],
      type_filter: "core.note",
    });
    expect(typeof make.confirm).toBe("string");

    const change = toolResult(
      await callTool(admin, "marfa_manage_webhook", {
        action: "change",
        id,
        events: ["item.updated"],
      }),
    );
    expect(change.preview).toMatchObject({ id, events: ["item.updated"] });
    expect(await hookIds()).toEqual(before);
    const stored = await owner.getWebhook(id);
    expect(stored.data.events).toEqual(["item.created"]);
  });

  it("makes a webhook with the confirmation the preview gave", async () => {
    const before = await hookIds();
    const id = await made("confirmed");
    expect(await hookIds()).toEqual([...before, id]);
    const stored = await owner.getWebhook(id);
    expect(stored.data).toMatchObject({
      url: address("confirmed"),
      events: ["item.created"],
      active: true,
    });
  });

  it("makes one webhook for a confirmation, however often it is sent", async () => {
    const before = await hookIds();
    const args = {
      action: "make",
      url: address("once"),
      events: ["item.created"],
    };
    const preview = toolResult(
      await callTool(admin, "marfa_manage_webhook", args),
    );
    expect(preview.preview).toMatchObject({ active: true });
    const done = toolResult(
      await callTool(admin, "marfa_manage_webhook", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    const id = (done.webhook as { id: string }).id;
    trackWebhook(ctx, id, owner);
    const again = toolError(
      await callTool(admin, "marfa_manage_webhook", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(again.code).toBe("confirmation_stale");
    expect(await hookIds()).toEqual([...before, id]);
  });

  it("refuses a webhook confirmation once where it posts or what it sends changed", async () => {
    const before = await hookIds();
    const args = {
      action: "make",
      url: address("previewed"),
      events: ["item.created"],
    };
    const preview = toolResult(
      await callTool(admin, "marfa_manage_webhook", args),
    );
    const moved = toolError(
      await callTool(admin, "marfa_manage_webhook", {
        ...args,
        url: address("elsewhere"),
        confirm: preview.confirm,
      }),
    );
    expect(moved.code).toBe("confirmation_stale");
    expect(moved.preview).toMatchObject({ url: address("elsewhere") });
    expect(await hookIds()).toEqual(before);

    const id = await made("changed-under");
    const change = {
      action: "change",
      id,
      url: address("changed-to"),
    };
    const changePreview = toolResult(
      await callTool(admin, "marfa_manage_webhook", change),
    );
    const patched = await fetch(new URL(`/webhooks/${id}`, apiUrl), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: ["item.updated"] }),
    });
    expect(patched.status).toBe(200);
    await patched.body?.cancel();
    const stale = toolError(
      await callTool(admin, "marfa_manage_webhook", {
        ...change,
        confirm: changePreview.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect(stale.preview).toMatchObject({ events: ["item.updated"] });
    const stored = await owner.getWebhook(id);
    expect(stored.data.url).toBe(address("changed-under"));
  });

  it("refuses a webhook confirmation another credential got", async () => {
    const before = await hookIds();
    const args = {
      action: "make",
      url: address("replayed"),
      events: ["item.created"],
    };
    const preview = toolResult(
      await callTool(admin, "marfa_manage_webhook", args),
    );
    const management = process.env.MARFA_MANAGEMENT_KEY;
    if (!management) throw new Error("MARFA_MANAGEMENT_KEY is required");
    const other = await connectMcp(
      apiUrl,
      management,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      const error = toolError(
        await callTool(other, "marfa_manage_webhook", {
          ...args,
          confirm: preview.confirm,
        }),
      );
      expect(error.code).toBe("confirmation_stale");
    } finally {
      await other.close();
    }
    expect(await hookIds()).toEqual(before);
  });

  it("pauses and deletes a webhook in one call", async () => {
    const id = await made("one-step");
    const paused = toolResult(
      await callTool(admin, "marfa_manage_webhook", {
        action: "change",
        id,
        active: false,
      }),
    );
    expect(paused.webhook).toMatchObject({ id, active: false });
    const deleted = toolResult(
      await callTool(admin, "marfa_manage_webhook", { action: "delete", id }),
    );
    expect(deleted.deleted).toBe(id);
    expect(await hookIds()).not.toContain(id);
  });
});

describe("marfa_move_items", () => {
  let schema: McpConnection;
  let key: string;
  let from: string;
  let to: string;

  beforeAll(async () => {
    // webhooks.manage, so a webhook the mover makes is one its move may change.
    key = await keyWith(
      "mover",
      { "*": "write" },
      {
        permissions: ["schema.write", "webhooks.manage"],
        metadata_permissions: { "*": "write" },
      },
    );
    schema = await connectMcp(apiUrl, key, "2026-07-28", "/mcp/schema");
    const owner = new MarfaClient({ baseUrl: apiUrl, apiKey: key });
    from = `user.mcp-lead-${ctx.runId}`;
    to = `user.mcp-contact-${ctx.runId}`;
    for (const id of [to, from]) {
      toolResult(
        await callTool(schema, "marfa_save_type", {
          action: "register",
          id,
          fields: { title: { type: "string" } },
        }),
      );
      trackType(ctx, id, owner);
    }
  });

  afterAll(async () => {
    await schema?.close();
  });

  async function lead(title: string): Promise<string> {
    const made = await client.createItem({ type: from, properties: { title } });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    return made.data.item.id;
  }

  async function typeOf(id: string): Promise<string | undefined> {
    const read = await client.getItem(id);
    return read.ok ? read.data.item.type : undefined;
  }

  it("moves nothing when called without a confirmation, and refuses a confirmation when what would move changed", async () => {
    const first = await lead("Ada");
    const preview = toolResult(
      await callTool(schema, "marfa_move_items", { from, to }),
    );
    expect(preview).toMatchObject({ matched: 1, ids: [first] });
    expect(await typeOf(first)).toBe(from);

    const second = await lead("Grace");
    const error = toolError(
      await callTool(schema, "marfa_move_items", {
        from,
        to,
        confirm: preview.confirm,
      }),
    );
    expect(error.code).toBe("confirmation_stale");
    expect(error.matched).toBe(2);
    expect(await typeOf(first)).toBe(from);

    // The witness: the confirmation the new preview gave moves both.
    const started = toolResult(
      await callTool(schema, "marfa_move_items", {
        from,
        to,
        confirm: error.confirm,
      }),
    );
    const job = started.job as { id: string };
    const deadline = Date.now() + 30_000;
    let status = "queued";
    while (Date.now() < deadline) {
      const progress = toolResult(
        await callTool(schema, "marfa_move_items", { job_id: job.id }),
      );
      status = (progress.job as { status: string }).status;
      if (status === "completed" || status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(status).toBe("completed");
    expect(await typeOf(first)).toBe(to);
    expect(await typeOf(second)).toBe(to);
  });

  it("refuses a move confirmation once a setting names the type after the preview", async () => {
    const left = await lead("Hedy");
    const preview = toolResult(
      await callTool(schema, "marfa_move_items", { from, to }),
    );
    expect(preview.settings).toEqual([]);

    const made = await fetch(new URL("/webhooks", apiUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: `http://127.0.0.1:9/${ctx.runId}/move`,
        events: ["item.created"],
        type_filter: from,
      }),
    });
    expect(made.status).toBe(201);
    const hook = (await made.json()) as { id: string };
    trackWebhook(
      ctx,
      hook.id,
      new MarfaClient({ baseUrl: apiUrl, apiKey: key }),
    );

    const error = toolError(
      await callTool(schema, "marfa_move_items", {
        from,
        to,
        confirm: preview.confirm,
      }),
    );
    expect(error.code).toBe("confirmation_stale");
    expect(error.settings).not.toEqual([]);
    expect(await typeOf(left)).toBe(from);
  });
});
