import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import { PERMISSIONS } from "@withmarfa/shared";
import { BulkActionWorker } from "../bulk-actions/index.js";
import { advanceClock, resetClockForTests } from "../clock.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";
import { WEBHOOK_EVENTS } from "../routes/webhooks.js";
import { CONFIRMATION_TTL_MS } from "./confirm.js";
import {
  callTool,
  connectMcp,
  errorOf,
  MCP_URL,
  payloadOf,
} from "./test-client.js";

let ctx: TestContext;
/** A key holding every permission and writing every type. */
let adminKey: string;
let schema: Client;
let admin: Client;

beforeAll(async () => {
  ctx = await createTestContext();
  adminKey = await mintWorkingKey(ctx, { permissions: [...PERMISSIONS] });
  schema = await connectMcp(ctx, adminKey, { path: "/mcp/schema" });
  admin = await connectMcp(ctx, adminKey, { path: "/mcp/admin" });
});

afterEach(() => {
  resetClockForTests();
});

afterAll(async () => {
  await schema.close();
  await admin.close();
  await ctx.cleanup();
});

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}

function post(path: string, headers: Record<string, string>, body: unknown) {
  return Promise.resolve(
    ctx.app.request(new URL(path, MCP_URL).toString(), {
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

async function keyIdOf(secret: string): Promise<string> {
  const response = await request(ctx.app, "GET", "/keys/current", {
    key: secret,
  });
  return ((await response.json()) as { id: string }).id;
}

describe("the MCP groups' endpoints", () => {
  it.each(["/mcp/schema", "/mcp/admin"])(
    "challenges a request to %s without a credential with that endpoint's metadata",
    async (path) => {
      const response = await post(
        path,
        {},
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        },
      );
      expect(response.status).toBe(401);
      const base = ctx.config.authBaseUrl.replace(/\/+$/, "");
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${path}"`,
      );
    },
  );

  it("lists an app with no admin scopes only the default tools it can use", async () => {
    const { token } = await seedOauthBearer(ctx, ["core.note:read"]);
    const reader = await connectMcp(ctx, token, { path: "/mcp/admin" });
    try {
      expect(await toolNames(reader)).toEqual([
        "marfa_find",
        "marfa_get",
        "marfa_overview",
      ]);
    } finally {
      await reader.close();
    }
    // The witness: the same grant with audit.read is listed the audit tool.
    const audited = await seedOauthBearer(ctx, [
      "core.note:read",
      "audit.read",
    ]);
    const auditor = await connectMcp(ctx, audited.token, {
      path: "/mcp/admin",
    });
    try {
      expect(await toolNames(auditor)).toContain("marfa_audit");
    } finally {
      await auditor.close();
    }
  });

  it("lists a key that only reads only the read tools and the docs at /mcp/schema", async () => {
    const key = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
      metadata_permissions: {},
      permissions: [],
    });
    const reader = await connectMcp(ctx, key, { path: "/mcp/schema" });
    try {
      expect(await toolNames(reader)).toEqual([
        "marfa_find",
        "marfa_get",
        "marfa_name_source",
        "marfa_overview",
        "marfa_search_docs",
        "marfa_sources",
      ]);
    } finally {
      await reader.close();
    }
  });

  it("asks an app at /mcp/admin for the scope a call needs, naming that endpoint", async () => {
    const { token } = await seedOauthBearer(ctx, [
      "core.note:read",
      "keys.mint",
    ]);
    const response = await post(
      "/mcp/admin",
      { Authorization: `Bearer ${token}` },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "marfa_manage_key",
          arguments: {
            action: "make",
            label: "Wider",
            source: "wider-than-the-app",
            permissions: ["audit.read"],
          },
        },
      },
    );
    expect(response.status).toBe(403);
    const base = ctx.config.authBaseUrl.replace(/\/+$/, "");
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer error="insufficient_scope"/);
    expect(challenge).toContain('scope="audit.read"');
    expect(challenge).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/admin"`,
    );
  });
});

describe("registering a new type through a signed-in app", () => {
  const register = (id: string) => ({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "marfa_save_type",
      arguments: {
        action: "register",
        id,
        label: "Recipe",
        fields: { title: { type: "string" } },
      },
    },
  });

  it("asks an app with metadata.types:write alone for the namespace wildcard that covers the new name", async () => {
    const { token } = await seedOauthBearer(ctx, [
      "metadata.types:write",
      "core.note:read",
    ]);
    const response = await post(
      "/mcp/schema",
      { Authorization: `Bearer ${token}` },
      register("user.fresh"),
    );
    expect(response.status).toBe(403);
    const base = ctx.config.authBaseUrl.replace(/\/+$/, "");
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer error="insufficient_scope"/);
    expect(challenge).toContain('scope="user.*:write"');
    expect(challenge).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/schema"`,
    );
  });

  it("registers the type for an app that also holds that namespace", async () => {
    const { token } = await seedOauthBearer(ctx, [
      "metadata.types:write",
      "user.*:write",
    ]);
    const response = await post(
      "/mcp/schema",
      { Authorization: `Bearer ${token}` },
      register("user.granted"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("user.granted");
  });

  it("answers a name the instance would grant no namespace for with the tool's error, not a challenge", async () => {
    const { token } = await seedOauthBearer(ctx, [
      "metadata.types:write",
      "core.note:read",
    ]);
    const response = await post(
      "/mcp/schema",
      { Authorization: `Bearer ${token}` },
      register("unheard.fresh"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.text()).toContain('"isError":true');
  });
});

describe("marfa_save_type", () => {
  it("registers a type, then merges a change into it", async () => {
    const registered = payloadOf(
      await callTool(schema, "marfa_save_type", {
        action: "register",
        id: "user.recipe",
        label: "Recipe",
        fields: { title: { type: "string" }, servings: { type: "integer" } },
      }),
    );
    expect(registered.type).toMatchObject({
      id: "user.recipe",
      fields: { title: { type: "string" }, servings: { type: "integer" } },
    });
    const changed = payloadOf(
      await callTool(schema, "marfa_save_type", {
        action: "change",
        id: "user.recipe",
        description: "A dish and how to make it.",
        fields: { servings: null, cuisine: { type: "string" } },
      }),
    );
    expect(changed.type).toMatchObject({
      label: "Recipe",
      description: "A dish and how to make it.",
      fields: { title: { type: "string" }, cuisine: { type: "string" } },
    });
    expect(
      (changed.type as { fields: Record<string, unknown> }).fields,
    ).not.toHaveProperty("servings");

    const again = errorOf(
      await callTool(schema, "marfa_save_type", {
        action: "register",
        id: "user.recipe",
        fields: { title: { type: "string" } },
      }),
    );
    expect(again.code).toBe("type_already_exists");
    expect(again.hint).toMatch(/action change/);
  });

  it("reports plainly a change the credential may not make, and changes nothing", async () => {
    payloadOf(
      await callTool(schema, "marfa_save_type", {
        action: "register",
        id: "user.dish",
        fields: { title: { type: "string" }, servings: { type: "integer" } },
      }),
    );
    const registersOnly = await mintWorkingKey(ctx, {
      permissions: [],
      metadata_permissions: { types: "write" },
    });
    const narrow = await connectMcp(ctx, registersOnly, {
      path: "/mcp/schema",
    });
    try {
      const refused = errorOf(
        await callTool(narrow, "marfa_save_type", {
          action: "change",
          id: "user.dish",
          fields: { servings: { type: "string" } },
        }),
      );
      expect(refused.code).toBe("forbidden");
      expect(refused.message).toMatch(/schema\.write/);
      expect(refused.details).toMatchObject({ changes: ["fields.servings"] });
      // The witness: a change it may make, a new optional field, lands.
      payloadOf(
        await callTool(narrow, "marfa_save_type", {
          action: "change",
          id: "user.dish",
          fields: { notes: { type: "string" } },
        }),
      );
    } finally {
      await narrow.close();
    }
    const stored = await request(ctx.app, "GET", "/types/user.dish", {
      key: adminKey,
    });
    expect(await stored.json()).toMatchObject({
      fields: { servings: { type: "integer" }, notes: { type: "string" } },
    });
  });

  it("changes a subtype's own definition, so it goes on inheriting from its parent", async () => {
    const parent = await request(ctx.app, "POST", "/types", {
      key: adminKey,
      body: {
        id: "user.shelf",
        roles: ["container"],
        fields: { title: { type: "string" }, rating: { type: "integer" } },
      },
    });
    expect(parent.status).toBe(201);
    payloadOf(
      await callTool(schema, "marfa_save_type", {
        action: "register",
        id: "user.bookshelf",
        parent: "user.shelf",
        fields: { room: { type: "string" } },
      }),
    );
    // A key that may only add optional fields: a change that copied the
    // parent's roles or fields into the subtype would need schema.write.
    const registersOnly = await mintWorkingKey(ctx, {
      permissions: [],
      metadata_permissions: { types: "write" },
    });
    const narrow = await connectMcp(ctx, registersOnly, {
      path: "/mcp/schema",
    });
    try {
      payloadOf(
        await callTool(narrow, "marfa_save_type", {
          action: "change",
          id: "user.bookshelf",
          fields: { shelves: { type: "integer" } },
        }),
      );
    } finally {
      await narrow.close();
    }
    const listed = await request(ctx.app, "GET", "/types", { key: adminKey });
    const own = (
      (await listed.json()) as {
        data: { id: string; fields: object; roles?: string[] }[];
      }
    ).data.find((type) => type.id === "user.bookshelf");
    expect(Object.keys(own?.fields ?? {}).sort()).toEqual(["room", "shelves"]);

    const inherited = errorOf(
      await callTool(schema, "marfa_save_type", {
        action: "change",
        id: "user.bookshelf",
        fields: { rating: null },
      }),
    );
    expect(inherited.code).toBe("validation_error");
    expect(inherited.message).toMatch(/rating/);
    expect(inherited.message).toMatch(/user\.shelf/);

    payloadOf(
      await callTool(schema, "marfa_save_type", {
        action: "change",
        id: "user.shelf",
        fields: { rating: null },
      }),
    );
    const child = await request(ctx.app, "GET", "/types/user.bookshelf", {
      key: adminKey,
    });
    const resolved = (await child.json()) as { fields: object };
    expect(Object.keys(resolved.fields).sort()).toEqual([
      "room",
      "shelves",
      "title",
    ]);
  });

  it("keeps a role a subtype declares that its parent also plays", async () => {
    const box = await request(ctx.app, "POST", "/types", {
      key: adminKey,
      body: {
        id: "user.box",
        roles: ["container"],
        fields: { title: { type: "string" } },
      },
    });
    expect(box.status).toBe(201);
    const crate = await request(ctx.app, "POST", "/types", {
      key: adminKey,
      body: {
        id: "user.crate",
        parent: "user.box",
        roles: ["container"],
        fields: { slats: { type: "integer" } },
      },
    });
    expect(crate.status).toBe(201);
    // A key that may change a label but not roles: a change that dropped
    // crate's own role would need schema.write.
    const registersOnly = await mintWorkingKey(ctx, {
      permissions: [],
      metadata_permissions: { types: "write" },
    });
    const narrow = await connectMcp(ctx, registersOnly, {
      path: "/mcp/schema",
    });
    try {
      const relabeled = payloadOf(
        await callTool(narrow, "marfa_save_type", {
          action: "change",
          id: "user.crate",
          label: "Crate",
        }),
      );
      expect(relabeled.type).toMatchObject({ label: "Crate" });
    } finally {
      await narrow.close();
    }
    const unrolled = await request(ctx.app, "PUT", "/types/user.box", {
      key: adminKey,
      body: { fields: { title: { type: "string" } } },
    });
    expect(unrolled.status).toBe(200);
    const read = await request(ctx.app, "GET", "/types/user.crate", {
      key: adminKey,
    });
    expect(await read.json()).toMatchObject({
      label: "Crate",
      roles: ["container"],
    });
    const listed = await request(ctx.app, "GET", "/types", { key: adminKey });
    const types = (
      (await listed.json()) as {
        data: { id: string; roles?: string[]; own_roles?: string[] }[];
      }
    ).data;
    expect(types.find((type) => type.id === "user.box")).toMatchObject({
      own_roles: [],
    });
    expect(types.find((type) => type.id === "user.box")).not.toHaveProperty(
      "roles",
    );
    expect(types.find((type) => type.id === "user.crate")).toMatchObject({
      roles: ["container"],
      own_roles: ["container"],
    });
  });
});

describe("marfa_save_view", () => {
  it("makes a view and changes it with the version read", async () => {
    const made = payloadOf(
      await callTool(schema, "marfa_save_view", {
        title: "Open tasks",
        query: { types: ["core.task"] },
        sort: [{ by: "updated_at", direction: "desc" }],
      }),
    );
    expect(made).toMatchObject({
      title: "Open tasks",
      query: { types: ["core.task"] },
    });
    const missing = errorOf(
      await callTool(schema, "marfa_save_view", {
        id: made.id,
        title: "Tasks",
      }),
    );
    expect(missing.code).toBe("missing_required_field");
    const changed = payloadOf(
      await callTool(schema, "marfa_save_view", {
        id: made.id,
        version: made.version,
        title: "Tasks",
      }),
    );
    expect(changed).toMatchObject({ id: made.id, title: "Tasks" });
  });
});

describe("marfa_move_items", () => {
  it("previews a move, then moves only on the confirmation of that preview", async () => {
    for (const id of ["user.lead", "user.contact"]) {
      payloadOf(
        await callTool(schema, "marfa_save_type", {
          action: "register",
          id,
          fields: { title: { type: "string" } },
        }),
      );
    }
    const first = await request(ctx.app, "POST", "/items", {
      key: adminKey,
      body: { type: "user.lead", properties: { title: "Ada" } },
    });
    const { item } = (await first.json()) as { item: { id: string } };
    const preview = payloadOf(
      await callTool(schema, "marfa_move_items", {
        from: "user.lead",
        to: "user.contact",
      }),
    );
    expect(preview).toMatchObject({ matched: 1, ids: [item.id] });
    expect(typeof preview.confirm).toBe("string");

    // Another item of the type changes what the move covers.
    await request(ctx.app, "POST", "/items", {
      key: adminKey,
      body: { type: "user.lead", properties: { title: "Grace" } },
    });
    const stale = errorOf(
      await callTool(schema, "marfa_move_items", {
        from: "user.lead",
        to: "user.contact",
        confirm: preview.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect(stale.matched).toBe(2);

    const started = payloadOf(
      await callTool(schema, "marfa_move_items", {
        from: "user.lead",
        to: "user.contact",
        confirm: stale.confirm,
      }),
    );
    const job = started.job as { id: string; status: string };
    expect(job.status).toBe("queued");
    const worker = new BulkActionWorker({
      storage: ctx.storage,
      chunkSize: 100,
      pollIntervalMs: 1,
    });
    while (await worker.runOnce()) {
      // Drains the queue.
    }
    const progress = payloadOf(
      await callTool(schema, "marfa_move_items", { job_id: job.id }),
    );
    expect(progress.job).toMatchObject({ status: "completed", succeeded: 2 });
    const moved = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: adminKey,
    });
    expect(await moved.json()).toMatchObject({
      item: { type: "user.contact" },
    });
  });

  it("refuses the confirmation once a setting names the type after the preview", async () => {
    for (const id of ["user.prospect", "user.client"]) {
      payloadOf(
        await callTool(schema, "marfa_save_type", {
          action: "register",
          id,
          fields: { title: { type: "string" } },
        }),
      );
    }
    await request(ctx.app, "POST", "/items", {
      key: adminKey,
      body: { type: "user.prospect", properties: { title: "Ada" } },
    });
    const preview = payloadOf(
      await callTool(schema, "marfa_move_items", {
        from: "user.prospect",
        to: "user.client",
      }),
    );
    expect(preview.settings).toEqual([]);
    const hook = await request(ctx.app, "POST", "/webhooks", {
      key: adminKey,
      body: {
        url: "https://example.com/prospects",
        events: ["item.created"],
        type_filter: "user.prospect",
      },
    });
    expect(hook.status).toBe(201);
    const stale = errorOf(
      await callTool(schema, "marfa_move_items", {
        from: "user.prospect",
        to: "user.client",
        confirm: preview.confirm,
      }),
    );
    expect(stale.code).toBe("confirmation_stale");
    expect(stale.settings).toHaveLength(1);
    expect(stale.matched).toBe(1);
    const { id } = (await hook.json()) as { id: string };
    await request(ctx.app, "DELETE", `/webhooks/${id}`, { key: adminKey });
  });
});

describe("marfa_bulk_save", () => {
  it("only creates by default, and updates with upsert", async () => {
    const items = [
      {
        type: "core.note",
        source_id: "import-1",
        properties: { title: "One" },
      },
      {
        type: "core.note",
        source_id: "import-2",
        properties: { title: "Two" },
      },
    ];
    const created = payloadOf(
      await callTool(schema, "marfa_bulk_save", { items }),
    );
    expect(created.counts).toMatchObject({ created: 2 });
    const again = payloadOf(
      await callTool(schema, "marfa_bulk_save", {
        items: [{ ...items[0], properties: { title: "One, again" } }],
      }),
    );
    expect(again.counts).toMatchObject({ skipped: 1 });
    expect(again.results).toMatchObject([
      { outcome: "skipped", reason: "duplicate_source" },
    ]);
    const updated = payloadOf(
      await callTool(schema, "marfa_bulk_save", {
        items: [{ ...items[0], properties: { title: "One, again" } }],
        mode: "upsert",
      }),
    );
    expect(updated.counts).toMatchObject({ updated: 1 });
  });

  it("refuses more entries than one call takes", async () => {
    const items = Array.from({ length: 201 }, (_, index) => ({
      type: "core.note",
      properties: { title: String(index) },
    }));
    const answer = await callTool(schema, "marfa_bulk_save", { items });
    expect(answer.isError).toBe(true);
  });
});

describe("marfa_search_docs", () => {
  it("says where to search the documentation", async () => {
    const answer = payloadOf(
      await callTool(schema, "marfa_search_docs", { query: "view filter" }),
    );
    expect(answer).toMatchObject({
      search_url: "https://docs.marfa.so/api/docs/search?q=view%20filter",
      docs_mcp: "https://docs.marfa.so/mcp",
    });
  });
});

describe("marfa_health and marfa_audit", () => {
  it("reads the instance's health, counts and connectors", async () => {
    const answer = payloadOf(await callTool(admin, "marfa_health", {}));
    expect(answer.health).toMatchObject({
      status: "ok",
      components: { database: { status: "ok" } },
    });
    expect(
      (answer.metrics as { items: { total: unknown } }).items.total,
    ).toBeTypeOf("number");
    expect(answer.connectors).toEqual([]);
  });

  it("keeps the health it read when the connectors cannot be read, and says so", async () => {
    // A failed database read takes the health down; /metrics may answer from
    // its cache or fail on the same read, and /connectors fails on its own.
    const count = vi
      .spyOn(ctx.storage.keys, "count")
      .mockRejectedValue(new Error("SQLITE_IOERR: disk I/O error"));
    const list = vi
      .spyOn(ctx.storage.connectors, "list")
      .mockRejectedValue(new Error("SQLITE_IOERR: disk I/O error"));
    try {
      const answer = payloadOf(await callTool(admin, "marfa_health", {}));
      expect(answer.health).toMatchObject({
        status: "down",
        components: { database: { status: "down" } },
      });
      const unread = answer.unread as { read: string; code: string }[];
      expect(unread).toContainEqual(
        expect.objectContaining({ read: "connectors", code: "internal_error" }),
      );
      expect(answer).not.toHaveProperty("connectors");
      expect(
        "metrics" in answer || unread.some((part) => part.read === "metrics"),
      ).toBe(true);
    } finally {
      count.mockRestore();
      list.mockRestore();
    }
  });

  it("reads the audit log, narrowed and paged", async () => {
    const answer = payloadOf(
      await callTool(admin, "marfa_audit", { action: "key.create", limit: 1 }),
    );
    expect(answer.entries).toHaveLength(1);
    expect(answer.entries).toMatchObject([{ action: "key.create" }]);
    expect(typeof answer.next_cursor).toBe("string");
    const next = payloadOf(
      await callTool(admin, "marfa_audit", {
        action: "key.create",
        limit: 1,
        cursor: answer.next_cursor,
      }),
    );
    expect((next.entries as { id: string }[])[0]?.id).not.toBe(
      (answer.entries as { id: string }[])[0]?.id,
    );
  });
});

describe("the key tools", () => {
  it("lists the keys, marking the caller's own", async () => {
    const answer = payloadOf(await callTool(admin, "marfa_keys", {}));
    const yours = (answer.keys as { id: string; yours?: boolean }[]).filter(
      (key) => key.yours === true,
    );
    expect(yours.map((key) => key.id)).toEqual([await keyIdOf(adminKey)]);
  });

  it("makes a key no wider than the maker, and narrows one only", async () => {
    const maker = await mintWorkingKey(ctx, {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "write" },
    });
    const client = await connectMcp(ctx, maker, { path: "/mcp/admin" });
    try {
      const wider = errorOf(
        await callTool(client, "marfa_manage_key", {
          action: "make",
          label: "Wider",
          source: "wider-key",
          permissions: ["audit.read"],
        }),
      );
      expect(wider.code).toBe("forbidden");
      const made = payloadOf(
        await callTool(client, "marfa_manage_key", {
          action: "make",
          label: "Notes reader",
          source: "notes-reader",
          type_permissions: { "core.note": "read" },
        }),
      );
      expect(made.secret).toMatch(/^marfa_/);
      const id = (made.key as { id: string }).id;
      const widened = errorOf(
        await callTool(client, "marfa_manage_key", {
          action: "narrow",
          id,
          type_permissions: { "core.note": "write" },
        }),
      );
      expect(widened.code).toBe("forbidden");
      const narrowed = payloadOf(
        await callTool(client, "marfa_manage_key", {
          action: "narrow",
          id,
          type_permissions: { "core.note": "none" },
        }),
      );
      expect(narrowed.key).toMatchObject({
        type_permissions: { "core.note": "none" },
      });
    } finally {
      await client.close();
    }
  });
});

describe("marfa_revoke_key", () => {
  async function makeKey(
    source: string,
  ): Promise<{ secret: string; id: string }> {
    const secret = await mintWorkingKey(ctx, { source, label: source });
    return { secret, id: await keyIdOf(secret) };
  }

  async function works(secret: string): Promise<boolean> {
    const response = await request(ctx.app, "GET", "/keys/current", {
      key: secret,
    });
    return response.status === 200;
  }

  it("previews, and revokes only on that preview's confirmation", async () => {
    const target = await makeKey("revoke-target");
    const preview = payloadOf(
      await callTool(admin, "marfa_revoke_key", { id: target.id }),
    );
    expect(preview.key).toMatchObject({
      id: target.id,
      label: "revoke-target",
    });
    expect(await works(target.secret)).toBe(true);
    const revoked = payloadOf(
      await callTool(admin, "marfa_revoke_key", {
        id: target.id,
        confirm: preview.confirm,
      }),
    );
    expect(revoked.revoked).toBe(target.id);
    expect(await works(target.secret)).toBe(false);
  });

  it("refuses a confirmation sent by another credential", async () => {
    const target = await makeKey("revoke-replayed");
    const preview = payloadOf(
      await callTool(admin, "marfa_revoke_key", { id: target.id }),
    );
    const other = await mintWorkingKey(ctx, { permissions: [...PERMISSIONS] });
    const client = await connectMcp(ctx, other, { path: "/mcp/admin" });
    try {
      const replayed = errorOf(
        await callTool(client, "marfa_revoke_key", {
          id: target.id,
          confirm: preview.confirm,
        }),
      );
      expect(replayed.code).toBe("confirmation_stale");
    } finally {
      await client.close();
    }
    expect(await works(target.secret)).toBe(true);
  });

  it("refuses a confirmation after it expires", async () => {
    const target = await makeKey("revoke-expired");
    const preview = payloadOf(
      await callTool(admin, "marfa_revoke_key", { id: target.id }),
    );
    advanceClock(CONFIRMATION_TTL_MS + 1_000);
    const expired = errorOf(
      await callTool(admin, "marfa_revoke_key", {
        id: target.id,
        confirm: preview.confirm,
      }),
    );
    expect(expired.code).toBe("confirmation_stale");
    expect(expired.message).toMatch(/expired/);
    expect(await works(target.secret)).toBe(true);
  });

  it("revokes the key the caller is using, saying the connection ends", async () => {
    const own = await mintWorkingKey(ctx, { permissions: [...PERMISSIONS] });
    const client = await connectMcp(ctx, own, { path: "/mcp/admin" });
    try {
      const id = await keyIdOf(own);
      const preview = payloadOf(
        await callTool(client, "marfa_revoke_key", { id }),
      );
      expect(preview.key).toMatchObject({ yours: true });
      expect(preview.next).toMatch(/key you are using/);
      const revoked = payloadOf(
        await callTool(client, "marfa_revoke_key", {
          id,
          confirm: preview.confirm,
        }),
      );
      expect(revoked.next).toMatch(/no longer works/);
      await expect(client.listTools()).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});

describe("the webhook tools", () => {
  async function webhookIds(): Promise<string[]> {
    const listed = payloadOf(await callTool(admin, "marfa_webhooks", {}));
    return (listed.webhooks as { id: string }[]).map((hook) => hook.id);
  }

  async function makeHook(url: string): Promise<{ id: string }> {
    const preview = payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        action: "make",
        url,
        events: ["item.created"],
      }),
    );
    const made = payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        action: "make",
        url,
        events: ["item.created"],
        confirm: preview.confirm,
      }),
    );
    return made.webhook as { id: string };
  }

  async function remove(id: string): Promise<void> {
    payloadOf(
      await callTool(admin, "marfa_manage_webhook", { action: "delete", id }),
    );
  }

  it("offers the events webhooks send", async () => {
    const { tools } = await admin.listTools();
    const manage = tools.find((tool) => tool.name === "marfa_manage_webhook");
    const events = manage?.inputSchema.properties?.events as
      { items: { enum: string[] } } | undefined;
    expect(events?.items.enum).toEqual([...WEBHOOK_EVENTS]);
  });

  it("makes a webhook only on the confirmation of its preview", async () => {
    const before = await webhookIds();
    const preview = payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        action: "make",
        url: "https://example.com/marfa-hook",
        events: ["item.created", "edge.created"],
        type_filter: "core.note",
      }),
    );
    expect(preview.preview).toMatchObject({
      url: "https://example.com/marfa-hook",
      host: "example.com",
      events: ["item.created", "edge.created"],
      type_filter: "core.note",
    });
    expect((preview.preview as { sends: string }).sends).toMatch(
      /example\.com/,
    );
    expect(typeof preview.confirm).toBe("string");
    expect(await webhookIds()).toEqual(before);

    const made = payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        action: "make",
        url: "https://example.com/marfa-hook",
        events: ["edge.created", "item.created"],
        type_filter: "core.note",
        confirm: preview.confirm,
      }),
    );
    const webhook = made.webhook as { id: string; secret: string };
    expect(webhook.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await webhookIds()).toEqual([...before, webhook.id]);
    await remove(webhook.id);
    expect(await webhookIds()).toEqual(before);
  });

  it("refuses a make confirmation for another url, another credential or after it expires", async () => {
    const before = await webhookIds();
    const args = {
      action: "make",
      url: "https://example.com/previewed",
      events: ["item.created"],
    };
    const preview = payloadOf(
      await callTool(admin, "marfa_manage_webhook", args),
    );
    const moved = errorOf(
      await callTool(admin, "marfa_manage_webhook", {
        ...args,
        url: "https://example.org/elsewhere",
        confirm: preview.confirm,
      }),
    );
    expect(moved.code).toBe("confirmation_stale");
    expect(moved.preview).toMatchObject({ host: "example.org" });

    const other = await mintWorkingKey(ctx, { permissions: [...PERMISSIONS] });
    const client = await connectMcp(ctx, other, { path: "/mcp/admin" });
    try {
      const replayed = errorOf(
        await callTool(client, "marfa_manage_webhook", {
          ...args,
          confirm: preview.confirm,
        }),
      );
      expect(replayed.code).toBe("confirmation_stale");
    } finally {
      await client.close();
    }

    advanceClock(CONFIRMATION_TTL_MS + 1_000);
    const expired = errorOf(
      await callTool(admin, "marfa_manage_webhook", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    expect(expired.code).toBe("confirmation_stale");
    expect(expired.message).toMatch(/expired/);
    expect(await webhookIds()).toEqual(before);
  });

  it("refuses a second confirmation of one make, so a retry makes nothing more", async () => {
    const before = await webhookIds();
    const args = {
      action: "make",
      url: "https://example.com/once",
      events: ["item.created"],
    };
    const preview = payloadOf(
      await callTool(admin, "marfa_manage_webhook", args),
    );
    const made = payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        ...args,
        confirm: preview.confirm,
      }),
    );
    const webhook = made.webhook as { id: string };
    try {
      const again = errorOf(
        await callTool(admin, "marfa_manage_webhook", {
          ...args,
          confirm: preview.confirm,
        }),
      );
      expect(again.code).toBe("confirmation_stale");
      expect(await webhookIds()).toEqual([...before, webhook.id]);
    } finally {
      await remove(webhook.id);
    }
  });

  it("shows and stores a type_filter trimmed, and refuses a blank one", async () => {
    const before = await webhookIds();
    const args = {
      action: "make",
      url: "https://example.com/trimmed",
      events: ["item.created"],
    };
    const blank = await callTool(admin, "marfa_manage_webhook", {
      ...args,
      type_filter: "   ",
    });
    expect(blank.isError).toBe(true);
    expect(blank.text).toMatch(/type_filter/);
    expect(await webhookIds()).toEqual(before);

    const preview = payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        ...args,
        type_filter: " core.note",
      }),
    );
    expect(preview.preview).toMatchObject({ type_filter: "core.note" });
    const made = payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        ...args,
        type_filter: " core.note",
        confirm: preview.confirm,
      }),
    );
    const webhook = made.webhook as { id: string };
    try {
      const stored = await request(ctx.app, "GET", `/webhooks/${webhook.id}`, {
        key: adminKey,
      });
      expect(await stored.json()).toMatchObject({ type_filter: "core.note" });
    } finally {
      await remove(webhook.id);
    }
  });

  it("refuses active or id on a make, and previews a new webhook as active", async () => {
    const before = await webhookIds();
    const args = {
      action: "make",
      url: "https://example.com/new",
      events: ["item.created"],
    };
    const someId = "01900000-0000-7000-8000-000000000000";
    for (const extra of [{ active: false }, { active: true }, { id: someId }]) {
      const refused = errorOf(
        await callTool(admin, "marfa_manage_webhook", { ...args, ...extra }),
      );
      expect(refused.code).toBe("validation_error");
      expect(refused.message).toBe(
        "A new webhook starts active and gets its own id; leave out active and id.",
      );
    }
    const preview = payloadOf(
      await callTool(admin, "marfa_manage_webhook", args),
    );
    expect(preview.preview).toMatchObject({ active: true });
    expect(await webhookIds()).toEqual(before);
  });

  it("changes a webhook's url or events only on the confirmation of its preview", async () => {
    const webhook = await makeHook("https://example.com/first");
    try {
      const preview = payloadOf(
        await callTool(admin, "marfa_manage_webhook", {
          action: "change",
          id: webhook.id,
          url: "https://example.org/second",
        }),
      );
      expect(preview.preview).toMatchObject({
        id: webhook.id,
        url: "https://example.org/second",
        host: "example.org",
        events: ["item.created"],
        type_filter: null,
      });
      const unchanged = await request(
        ctx.app,
        "GET",
        `/webhooks/${webhook.id}`,
        { key: adminKey },
      );
      expect(await unchanged.json()).toMatchObject({
        url: "https://example.com/first",
      });

      // The webhook changes after the preview, so the preview is stale.
      await request(ctx.app, "PATCH", `/webhooks/${webhook.id}`, {
        key: adminKey,
        body: { events: ["item.updated"] },
      });
      const stale = errorOf(
        await callTool(admin, "marfa_manage_webhook", {
          action: "change",
          id: webhook.id,
          url: "https://example.org/second",
          confirm: preview.confirm,
        }),
      );
      expect(stale.code).toBe("confirmation_stale");
      expect(stale.preview).toMatchObject({ events: ["item.updated"] });

      const changed = payloadOf(
        await callTool(admin, "marfa_manage_webhook", {
          action: "change",
          id: webhook.id,
          url: "https://example.org/second",
          confirm: stale.confirm,
        }),
      );
      expect(changed.webhook).toMatchObject({
        url: "https://example.org/second",
        events: ["item.updated"],
      });
    } finally {
      await remove(webhook.id);
    }
  });

  it("pauses and deletes a webhook in one step", async () => {
    const webhook = await makeHook("https://example.com/paused");
    const paused = payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        action: "change",
        id: webhook.id,
        active: false,
      }),
    );
    expect(paused.webhook).toMatchObject({ active: false });
    await remove(webhook.id);
    expect(await webhookIds()).not.toContain(webhook.id);
  });
});
