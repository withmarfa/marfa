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

  it("stores tags in metadata (entity references live on edges)", async () => {
    const target = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "target" } },
    });
    const targetData = (await target.json()) as { item: { id: string } };
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Tagged" },
        tags: ["reading", "important"],
        edges: { about: [targetData.item.id] },
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      item: {
        edges?: Record<string, { edges: { target_id: string }[] }>;
      };
      metadata: { tags: string[] };
    };
    expect(data.metadata.tags).toEqual(["reading", "important"]);
    expect(data.item.edges?.about?.edges.length).toBe(1);
    expect(data.item.edges?.about?.edges[0]?.target_id).toBe(
      targetData.item.id,
    );
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
    expect(conflict).toHaveProperty("merge_policy");
    const policy = conflict.merge_policy as {
      fields?: Record<string, string>;
      default?: string;
    };
    expect(policy.fields?.body).toBe("keep_both_copies");
    expect(policy.fields?.notes).toBe("keep_both_copies");
    expect(policy.default).toBe("last_writer_wins");
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

  it("flips library: false → true on PATCH", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "ambient" },
        library: false,
      },
    });
    const created = (await createRes.json()) as {
      item: { id: string; library: boolean };
    };
    expect(created.item.library).toBe(false);

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { library: true },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { library: boolean } };
    expect(data.item.library).toBe(true);
  });

  it("flips library: true → false on PATCH", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "library" },
        library: true,
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { library: false },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { library: boolean } };
    expect(data.item.library).toBe(false);
  });

  it("library-only PATCH (no properties) succeeds and bumps version", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "x" }, library: false },
    });
    const created = (await createRes.json()) as {
      item: { id: string; version: number };
    };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { library: true },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { library: boolean; version: number };
    };
    expect(data.item.library).toBe(true);
    expect(data.item.version).toBe(created.item.version + 1);
  });

  it("PATCH with library + properties applies both", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "before" },
        library: false,
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: { properties: { body: "after" }, library: true },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { library: boolean; properties: Record<string, unknown> };
    };
    expect(data.item.library).toBe(true);
    expect(data.item.properties.body).toBe("after");
  });

  it("PATCH with no body fields returns 400", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "x" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.adminKey,
      body: {},
    });
    expect(res.status).toBe(400);
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

describe("query language: library system field", () => {
  it("filters items by 'library eq true' via the filter query parameter", async () => {
    // Two items with explicit library values
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "library item" },
        library: true,
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "ambient item" },
        library: false,
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&filter=library%20eq%20true&limit=200",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { library: boolean }[];
    };
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item.library).toBe(true);
    }
  });
});

describe("library default and tri-value filter on GET /items", () => {
  let libraryId: string;
  let ambientId: string;

  beforeAll(async () => {
    const libRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "library marker for default test" },
        library: true,
      },
    });
    const libBody = (await libRes.json()) as { item: { id: string } };
    libraryId = libBody.item.id;

    const ambRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "ambient marker for default test" },
        library: false,
      },
    });
    const ambBody = (await ambRes.json()) as { item: { id: string } };
    ambientId = ambBody.item.id;
  });

  it("returns both library and ambient items when no library param is supplied", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&limit=200",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; library: boolean }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(true);
    expect(ids.has(ambientId)).toBe(true);
  });

  it("returns library items only when ?library=true", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&library=true&limit=200",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; library: boolean }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(true);
    expect(ids.has(ambientId)).toBe(false);
    for (const item of body.data) {
      expect(item.library).toBe(true);
    }
  });

  it("returns ambient items only when ?library=false", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&library=false&limit=200",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; library: boolean }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(false);
    expect(ids.has(ambientId)).toBe(true);
    for (const item of body.data) {
      expect(item.library).toBe(false);
    }
  });

  it("treats ?library=all as a synonym for unfiltered", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&library=all&limit=200",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; library: boolean }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(true);
    expect(ids.has(ambientId)).toBe(true);
  });
});

describe("metadata.changed pubsub event", () => {
  it("fires from POST /items/:id/tags and surfaces with the V0 wire name", async () => {
    const { subscribe } = await import("../pubsub.js");

    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "Tag-event target" },
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };

    // Subscribe before the mutation. The async generator yields on the
    // first event after subscribing — race the route call against a 500ms
    // timeout to fail fast if no event fires.
    const iter = subscribe();
    const nextEvent: Promise<{ type: string; item: { id: string } }> = iter
      .next()
      .then((r) => r.value as { type: string; item: { id: string } });

    const tagRes = await request(ctx.app, "POST", `/items/${item.id}/tags`, {
      key: ctx.adminKey,
      body: { tags: ["interesting"] },
    });
    expect(tagRes.status).toBe(200);

    const event = await Promise.race([
      nextEvent,
      new Promise<{ type: string; item: { id: string } }>((_, reject) => {
        setTimeout(() => {
          reject(new Error("no event in 500ms"));
        }, 500);
      }),
    ]);
    expect(event.type).toBe("metadata_changed");
    expect(event.item.id).toBe(item.id);
    await iter.return(undefined);
  });
});

describe("metadata.extensions are permission-filtered on every read path", () => {
  async function createMemberKey(
    extPerms: Record<string, "read" | "write">,
    label: string,
  ): Promise<string> {
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label,
        source: `${label}-src`,
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: extPerms,
      },
    });
    const { key } = (await res.json()) as { key: string };
    return key;
  }

  async function seedItemWithExtensions(): Promise<string> {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "ext-leak-fixture" },
        tags: ["ext-leak-fixture"],
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };
    // Admin writes three extension namespaces. Member key below only has
    // read on `visible-app.prefs`; the other two must be hidden.
    for (const ns of [
      "visible-app.prefs",
      "hidden-app.prefs",
      "other-app.prefs",
    ]) {
      await request(ctx.app, "PUT", `/items/${item.id}/extensions/${ns}`, {
        key: ctx.adminKey,
        body: { flag: ns },
      });
    }
    return item.id;
  }

  it("GET /items/:id only surfaces extension namespaces the caller can read", async () => {
    const id = await seedItemWithExtensions();
    const memberKey = await createMemberKey(
      { "visible-app.prefs": "read" },
      "ext-leak-single",
    );

    const res = await request(ctx.app, "GET", `/items/${id}`, {
      key: memberKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });

  it("GET /items?include=metadata filters extensions per item", async () => {
    const id = await seedItemWithExtensions();
    const memberKey = await createMemberKey(
      { "visible-app.prefs": "read" },
      "ext-leak-list",
    );

    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&include=metadata&limit=200`,
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        item: { id: string };
        metadata: { extensions: Record<string, unknown> };
      }[];
    };
    const row = body.data.find((r) => r.item.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row?.metadata.extensions ?? {}).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });

  it("GET /items/:id/metadata filters extensions", async () => {
    const id = await seedItemWithExtensions();
    const memberKey = await createMemberKey(
      { "visible-app.prefs": "read" },
      "ext-leak-meta",
    );

    const res = await request(ctx.app, "GET", `/items/${id}/metadata`, {
      key: memberKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });

  it("/search filters extensions on every result", async () => {
    await seedItemWithExtensions();
    const memberKey = await createMemberKey(
      { "visible-app.prefs": "read" },
      "ext-leak-search",
    );

    const res = await request(ctx.app, "GET", `/search?q=ext-leak-fixture`, {
      key: memberKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { metadata: { extensions: Record<string, unknown> } }[];
    };
    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results) {
      const namespaces = Object.keys(result.metadata.extensions);
      for (const ns of namespaces) {
        expect(ns).toBe("visible-app.prefs");
      }
    }
  });

  it("admin keys still see every extension namespace", async () => {
    const id = await seedItemWithExtensions();
    const res = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
    });
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "hidden-app.prefs",
      "other-app.prefs",
      "visible-app.prefs",
    ]);
  });

  it("implicit own-namespace rule still exposes a member's own namespace", async () => {
    const id = await seedItemWithExtensions();
    // Key with no explicit grants — the own-namespace rule should let it
    // see an extension namespace that matches its label.
    const ownerKey = await createMemberKey({}, "visible-app.prefs");
    const res = await request(ctx.app, "GET", `/items/${id}`, {
      key: ownerKey,
    });
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });
});

describe("GET /items?include=extensions", () => {
  async function createMemberKey(
    extPerms: Record<string, "read" | "write">,
    label: string,
  ): Promise<string> {
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label,
        source: `${label}-src`,
        role: "member",
        type_permissions: { "*": "write" },
        extension_permissions: extPerms,
      },
    });
    const { key } = (await res.json()) as { key: string };
    return key;
  }

  async function seedItem(marker: string): Promise<string> {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: `include-ext-${marker}` },
        tags: [`include-ext-${marker}`],
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };
    for (const ns of ["visible.prefs", "hidden.prefs", "other.prefs"]) {
      await request(ctx.app, "PUT", `/items/${item.id}/extensions/${ns}`, {
        key: ctx.adminKey,
        body: { flag: ns },
      });
    }
    return item.id;
  }

  it("omits extensions when include is not set (lists stay lean)", async () => {
    const id = await seedItem("lean");
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-lean`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; extensions?: unknown }[];
    };
    const row = body.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.extensions).toBeUndefined();
  });

  it("hydrates extensions inline when include=extensions is set", async () => {
    const id = await seedItem("admin");
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-admin&include=extensions`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; extensions?: Record<string, unknown> }[];
    };
    const row = body.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row?.extensions ?? {}).sort()).toEqual([
      "hidden.prefs",
      "other.prefs",
      "visible.prefs",
    ]);
  });

  it("filters extensions per caller permissions", async () => {
    const id = await seedItem("filtered");
    const memberKey = await createMemberKey(
      { "visible.prefs": "read" },
      "include-ext-filtered",
    );
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-filtered&include=extensions`,
      { key: memberKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; extensions?: Record<string, unknown> }[];
    };
    const row = body.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row?.extensions ?? {}).sort()).toEqual([
      "visible.prefs",
    ]);
  });

  it("composes with include=edges in a single request", async () => {
    const targetRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "combo target" } },
    });
    const { item: target } = (await targetRes.json()) as {
      item: { id: string };
    };
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "combo source" },
        tags: ["include-ext-combo"],
        edges: { about: [target.id] },
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };
    await request(ctx.app, "PUT", `/items/${item.id}/extensions/app.data`, {
      key: ctx.adminKey,
      body: { ok: true },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-combo&include=edges,extensions`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id: string;
        edges?: Record<string, { edges: unknown[] }>;
        extensions?: Record<string, unknown>;
      }[];
    };
    const row = body.data.find((r) => r.id === item.id);
    expect(row?.edges?.about?.edges.length).toBe(1);
    expect(row?.extensions).toHaveProperty("app.data");
  });
});
