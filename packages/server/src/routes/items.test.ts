import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
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
    const data = (await res.json()) as {
      item: Record<string, unknown>;
      metadata: unknown;
    };
    expect(data.item.type).toBe("core.note");
    expect(data.item.version).toBe(1);
    expect(data.item.state).toBe("active");
    expect(data.item).toHaveProperty("id");
    expect(data).toHaveProperty("metadata");
  });

  it("rejects missing required field", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { title: "No body" } },
    });
    expect(res.status).toBe(400);
  });

  it("accepts unknown type (community types)", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.nonexistent", properties: {} },
    });
    expect(res.status).toBe(201);
  });

  it("rejects request without auth", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      body: { type: "core.note", properties: { body: "Test" } },
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
    const data = (await res.json()) as {
      metadata: { tags: string[]; about: string[] };
    };
    expect(data.metadata.tags).toEqual(["reading", "important"]);
    expect(data.metadata.about).toEqual(["some-id"]);
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
      body: { type: "core.note", properties: { body: "Get test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });
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
      {
        key: ctx.adminKey,
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for trashed item", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "Will trash" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "DELETE", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });

    const res = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });
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
    const data = (await res.json()) as { data: { type: string }[] };
    for (const item of data.data) {
      expect(item.type).toBe("core.note");
    }
  });

  it("filters by tags", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Tag test" },
        tags: ["filter-test"],
      },
    });

    const res = await request(ctx.app, "GET", "/items?tags=filter-test", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: unknown[] };
    expect(data.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("PATCH /items/:id", () => {
  it("updates properties and returns wrapped { item, metadata }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Original", title: "Test" },
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "Updated" }, version: 1 },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { version: number; properties: Record<string, unknown> };
      metadata: unknown;
    };
    expect(data.item.version).toBe(2);
    expect(data.item.properties.title).toBe("Updated");
    expect(data.item.properties.body).toBe("Original");
    expect(data).toHaveProperty("metadata");
  });

  it("returns 409 on conflicting field update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Base", title: "Base title" },
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "Server update" }, version: 1 },
    });

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
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
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "Server title" }, version: 1 },
    });

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "Client body" }, version: 1 },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(data.item.properties.title).toBe("Server title");
    expect(data.item.properties.body).toBe("Client body");
  });

  it("returns 409 for version 0 (not 400)", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "V0 test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "From v0" }, version: 0 },
    });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /items/:id", () => {
  it("soft-deletes item and returns { ok: true }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "To delete" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "DELETE", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });
});

describe("POST /items/:id/restore", () => {
  it("restores trashed item and returns { item, metadata }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "To restore" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "DELETE", `/items/${created.item.id}`, {
      key: ctx.adminKey,
    });

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/restore`,
      {
        key: ctx.adminKey,
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { state: string };
      metadata: unknown;
    };
    expect(data.item.state).toBe("active");
    expect(data).toHaveProperty("metadata");
  });
});

describe("POST /items/:id/transition", () => {
  it("transitions item state and returns { item, metadata }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "State test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/transition`,
      {
        key: ctx.adminKey,
        body: { state: "archived" },
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { state: string };
      metadata: unknown;
    };
    expect(data.item.state).toBe("archived");
    expect(data).toHaveProperty("metadata");
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
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/transition`,
      {
        key: ctx.adminKey,
        body: { state: "new" as unknown as "active" },
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /items/:id/versions", () => {
  it("returns wrapped version history after update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "V1" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "V2" }, version: 1 },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items/${created.item.id}/versions`,
      {
        key: ctx.adminKey,
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { versions: { version: number }[] };
    expect(data.versions.length).toBe(1);
    expect(data.versions[0]).toHaveProperty("version", 1);
  });
});

// ---------------------------------------------------------------------------
// Filter query parameter (advanced query language)
// ---------------------------------------------------------------------------

describe("GET /items?filter=...", () => {
  it("filters by system field", async () => {
    // Create items with different states
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Active note" },
        state: "active",
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "New note" } },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('state eq "active"')}`,
      {
        key: ctx.adminKey,
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: { state: string }[] };
    for (const item of data.data) {
      expect(item.state).toBe("active");
    }
  });

  it("filters by property value", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.media.book",
        properties: { title: "1984", author: "Orwell", body: "" },
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.media.book",
        properties: { title: "Fahrenheit 451", author: "Bradbury", body: "" },
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('properties.author eq "Orwell"')}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    expect(data.data.length).toBeGreaterThanOrEqual(1);
    for (const item of data.data) {
      expect(item.properties.author).toBe("Orwell");
    }
  });

  it("filters with AND conditions", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('state eq "active" AND type eq "core.media.book"')}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { state: string; type: string }[];
    };
    for (const item of data.data) {
      expect(item.state).toBe("active");
      expect(item.type).toBe("core.media.book");
    }
  });

  it("filters with OR conditions", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('properties.author eq "Orwell" OR properties.author eq "Bradbury"')}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    for (const item of data.data) {
      expect(["Orwell", "Bradbury"]).toContain(item.properties.author);
    }
  });

  it("composes filter with existing type param", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.media.book&filter=${encodeURIComponent('properties.author eq "Orwell"')}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { type: string; properties: Record<string, unknown> }[];
    };
    for (const item of data.data) {
      expect(item.type).toBe("core.media.book");
      expect(item.properties.author).toBe("Orwell");
    }
  });

  it("returns 400 for invalid filter expression", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent("invalid_field eq test")}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(400);
  });

  it("filters by tags contains", async () => {
    // Create an item with tags
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Tagged note" },
        tags: ["fiction", "classic"],
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('tags contains "fiction"')}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: unknown[] };
    expect(data.data.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by property exists", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent("properties.author exists")}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    for (const item of data.data) {
      expect(item.properties).toHaveProperty("author");
    }
  });
});

describe("DELETE /items/:id/purge", () => {
  it("permanently deletes a trashed item", async () => {
    // Create and trash an item
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Purge me", title: "Temporary" },
      },
    });
    const { item } = (await createRes.json()) as {
      item: { id: string };
    };

    await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: ctx.adminKey,
    });

    // Purge the trashed item
    const purgeRes = await request(
      ctx.app,
      "DELETE",
      `/items/${item.id}/purge`,
      { key: ctx.adminKey },
    );
    expect(purgeRes.status).toBe(200);

    // Verify the item is gone
    const getRes = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.adminKey,
    });
    expect(getRes.status).toBe(404);
  });

  it("rejects purge on non-trashed item", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Active item", title: "Active" },
      },
    });
    const { item } = (await createRes.json()) as {
      item: { id: string };
    };

    const purgeRes = await request(
      ctx.app,
      "DELETE",
      `/items/${item.id}/purge`,
      { key: ctx.adminKey },
    );
    expect(purgeRes.status).toBe(400);
  });
});

describe("schema_version stamping", () => {
  it("stamps schema_version: 1 on a newly-created core.note", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "Schema-version test" } },
    });
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as {
      item: { id: string; schema_version: number };
    };
    expect(item.schema_version).toBe(1);
  });

  it("preserves schema_version through update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "Update test" } },
    });
    const created = (await createRes.json()) as {
      item: { id: string; schema_version: number };
    };
    expect(created.item.schema_version).toBe(1);

    const updateRes = await request(
      ctx.app,
      "PATCH",
      `/items/${created.item.id}`,
      {
        key: ctx.adminKey,
        body: { properties: { body: "Updated" } },
      },
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as {
      item: { schema_version: number };
    };
    expect(updated.item.schema_version).toBe(1);
  });
});

describe("state lifecycle enum at the route boundary", () => {
  it("rejects POST /items/:id/transition with an unknown state", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "Lifecycle test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/transition`,
      { key: ctx.adminKey, body: { state: "draft" } },
    );
    expect(res.status).toBe(400);
  });
});
