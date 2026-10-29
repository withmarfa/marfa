import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
        "marfa_overview",
        "marfa_search_docs",
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
  it("makes, lists, changes and deletes a webhook", async () => {
    const made = payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        action: "make",
        url: "https://example.com/marfa-hook",
        events: ["item.created"],
      }),
    );
    const webhook = made.webhook as { id: string; secret: string };
    expect(webhook.secret).toMatch(/^[0-9a-f]{64}$/);
    const listed = payloadOf(await callTool(admin, "marfa_webhooks", {}));
    expect(listed.webhooks).toMatchObject([
      { id: webhook.id, url: "https://example.com/marfa-hook" },
    ]);
    const paused = payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        action: "change",
        id: webhook.id,
        active: false,
      }),
    );
    expect(paused.webhook).toMatchObject({ active: false });
    payloadOf(
      await callTool(admin, "marfa_manage_webhook", {
        action: "delete",
        id: webhook.id,
      }),
    );
    const gone = payloadOf(await callTool(admin, "marfa_webhooks", {}));
    expect(gone.webhooks).toEqual([]);
  });
});
