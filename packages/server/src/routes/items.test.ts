import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(() => {
  ctx = createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

describe("POST /items", () => {
  it("creates an item with valid properties", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Hello world", title: "Test" },
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("item");
    expect(data).toHaveProperty("metadata");
    const item = data["item"] as Record<string, unknown>;
    expect(item["type"]).toBe("core.note");
    expect(item["version"]).toBe(1);
    expect(item["state"]).toBe("new");
    expect(item).toHaveProperty("id");
  });

  it("rejects missing required field", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { title: "No body" },
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown type", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.nonexistent",
        properties: {},
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects request without auth", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      body: {
        type: "core.note",
        properties: { body: "Test" },
      },
    });
    expect(res.status).toBe(401);
  });

  it("stores tags and about in metadata", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Tagged" },
        tags: ["reading", "important"],
        about: ["some-id"],
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    const meta = data["metadata"] as Record<string, unknown>;
    expect(meta["tags"]).toEqual(["reading", "important"]);
    expect(meta["about"]).toEqual(["some-id"]);
  });

  it("detects duplicate source", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "First" },
        source: "test",
        source_id: "dup-1",
      },
    });
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Second" },
        source: "test",
        source_id: "dup-1",
      },
    });
    expect(res.status).toBe(409);
  });
});

describe("GET /items/:id", () => {
  it("returns item with metadata", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Get test" },
      },
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    const item = created["item"] as Record<string, unknown>;

    const res = await request(
      ctx.app,
      "GET",
      `/items/${item["id"] as string}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("item");
    expect(data).toHaveProperty("metadata");
  });

  it("returns 404 for non-existent item", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items/019537a0-7b80-7000-8000-000000000000",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /items", () => {
  it("lists items with pagination", async () => {
    const res = await request(ctx.app, "GET", "/items?limit=2", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("data");
    expect(data).toHaveProperty("has_more");
    expect(data).toHaveProperty("cursor");
  });

  it("filters by type", async () => {
    const res = await request(ctx.app, "GET", "/items?type=core.note", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: Array<Record<string, unknown>> };
    for (const item of data.data) {
      expect(item["type"]).toBe("core.note");
    }
  });
});

describe("PATCH /items/:id", () => {
  it("updates properties and increments version", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Original", title: "Test" },
      },
    });
    const created = (await createRes.json()) as {
      item: Record<string, unknown>;
    };
    const id = created.item["id"] as string;

    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: {
        properties: { title: "Updated" },
        version: 1,
      },
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;
    expect(updated["version"]).toBe(2);
    expect(
      (updated["properties"] as Record<string, unknown>)["title"],
    ).toBe("Updated");
    // Body should be preserved
    expect(
      (updated["properties"] as Record<string, unknown>)["body"],
    ).toBe("Original");
  });

  it("returns 409 on conflicting field update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Base", title: "Base title" },
      },
    });
    const created = (await createRes.json()) as {
      item: Record<string, unknown>;
    };
    const id = created.item["id"] as string;

    // First update (version 1 -> 2)
    await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "Server update" }, version: 1 },
    });

    // Second update with stale version targeting same field
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "Client update" }, version: 1 },
    });
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as Record<string, unknown>;
    expect(conflict).toHaveProperty("conflicting_fields");
    expect(conflict).toHaveProperty("current");
    expect(conflict).toHaveProperty("ancestor");
  });

  it("auto-merges non-conflicting field updates", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Base body", title: "Base title" },
      },
    });
    const created = (await createRes.json()) as {
      item: Record<string, unknown>;
    };
    const id = created.item["id"] as string;

    // First update changes title (version 1 -> 2)
    await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "Server title" }, version: 1 },
    });

    // Second update with stale version changes body (different field)
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "Client body" }, version: 1 },
    });
    expect(res.status).toBe(200);
    const merged = (await res.json()) as Record<string, unknown>;
    const props = merged["properties"] as Record<string, unknown>;
    expect(props["title"]).toBe("Server title");
    expect(props["body"]).toBe("Client body");
  });
});

describe("DELETE /items/:id", () => {
  it("soft-deletes item (transitions to trashed)", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "To delete" },
      },
    });
    const created = (await createRes.json()) as {
      item: Record<string, unknown>;
    };
    const id = created.item["id"] as string;

    const res = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(204);

    // Item should still exist in storage but with trashed state
    const getRes = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
    });
    expect(getRes.status).toBe(200);
    const data = (await getRes.json()) as {
      item: Record<string, unknown>;
    };
    expect(data.item["state"]).toBe("trashed");
  });
});

describe("POST /items/:id/restore", () => {
  it("restores trashed item to active", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "To restore" },
      },
    });
    const created = (await createRes.json()) as {
      item: Record<string, unknown>;
    };
    const id = created.item["id"] as string;

    await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.adminKey,
    });

    const res = await request(ctx.app, "POST", `/items/${id}/restore`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const restored = (await res.json()) as Record<string, unknown>;
    expect(restored["state"]).toBe("active");
  });
});

describe("POST /items/:id/transition", () => {
  it("transitions item state", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "State test" },
      },
    });
    const created = (await createRes.json()) as {
      item: Record<string, unknown>;
    };
    const id = created.item["id"] as string;

    const res = await request(
      ctx.app,
      "POST",
      `/items/${id}/transition`,
      {
        key: ctx.adminKey,
        body: { state: "active" },
      },
    );
    expect(res.status).toBe(200);
    const item = (await res.json()) as Record<string, unknown>;
    expect(item["state"]).toBe("active");
  });

  it("rejects invalid transition", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Transition test" },
        state: "active",
      },
    });
    const created = (await createRes.json()) as {
      item: Record<string, unknown>;
    };
    const id = created.item["id"] as string;

    const res = await request(
      ctx.app,
      "POST",
      `/items/${id}/transition`,
      {
        key: ctx.adminKey,
        body: { state: "new" },
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /items/:id/versions", () => {
  it("returns version history after update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "V1" },
      },
    });
    const created = (await createRes.json()) as {
      item: Record<string, unknown>;
    };
    const id = created.item["id"] as string;

    await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "V2" }, version: 1 },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items/${id}/versions`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const versions = (await res.json()) as Array<Record<string, unknown>>;
    expect(versions.length).toBe(1);
    expect(versions[0]).toHaveProperty("version", 1);
  });
});
