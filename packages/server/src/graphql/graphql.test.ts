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

/** Helper to send a GraphQL query/mutation via POST /graphql. */
async function gql(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{
  data?: Record<string, unknown>;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
}> {
  const res = await request(ctx.app, "POST", "/graphql", {
    key: ctx.adminKey,
    body: { query, variables },
  });
  return res.json() as Promise<{
    data?: Record<string, unknown>;
    errors?: { message: string; extensions?: Record<string, unknown> }[];
  }>;
}

/** Helper to send an unauthenticated GraphQL request. */
async function gqlNoAuth(query: string): Promise<{
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}> {
  const res = await request(ctx.app, "POST", "/graphql", {
    body: { query },
  });
  return res.json() as Promise<{
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  }>;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe("GraphQL queries", () => {
  let createdItemId: string;

  it("creates an item via mutation", async () => {
    const result = await gql(`
      mutation {
        createItem(input: {
          type: "core.note"
          properties: { body: "GraphQL test note", title: "GQL Test" }
          tags: ["graphql", "test"]
        }) {
          item { id type state properties version }
          metadata { tags about }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const payload = result.data?.createItem as {
      item: { id: string; type: string; state: string; version: number };
      metadata: { tags: string[] };
    };
    expect(payload.item.type).toBe("core.note");
    expect(payload.item.state).toBe("new");
    expect(payload.item.version).toBe(1);
    expect(payload.metadata.tags).toContain("graphql");
    createdItemId = payload.item.id;
  });

  it("fetches item by ID", async () => {
    const result = await gql(
      `
      query($id: ID!) {
        item(id: $id) {
          id type state properties
          metadata { tags about }
        }
      }
    `,
      { id: createdItemId },
    );

    expect(result.errors).toBeUndefined();
    const item = result.data?.item as {
      id: string;
      type: string;
      metadata: { tags: string[] };
    };
    expect(item.id).toBe(createdItemId);
    expect(item.type).toBe("core.note");
    expect(item.metadata.tags).toContain("graphql");
  });

  it("returns null for nonexistent item", async () => {
    const result = await gql(`
      query {
        item(id: "01961234-5678-7000-8000-000000000000") {
          id
        }
      }
    `);
    expect(result.errors).toBeUndefined();
    expect(result.data?.item).toBeNull();
  });

  it("lists items", async () => {
    const result = await gql(`
      query {
        items(limit: 10) {
          data { id type state }
          cursor
          has_more
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const conn = result.data?.items as { data: unknown[]; has_more: boolean };
    expect(conn.data.length).toBeGreaterThanOrEqual(1);
    expect(typeof conn.has_more).toBe("boolean");
  });

  it("lists items with filter argument", async () => {
    // Create a book item
    await gql(`
      mutation {
        createItem(input: {
          type: "core.work.book"
          properties: { title: "1984", author: "Orwell", body: "" }
        }) { item { id } }
      }
    `);

    const result = await gql(`
      query {
        items(filter: "properties.author eq \\"Orwell\\"") {
          data { id properties }
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const items = (
      result.data?.items as { data: { properties: Record<string, unknown> }[] }
    ).data;
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      expect(item.properties.author).toBe("Orwell");
    }
  });

  it("searches items", async () => {
    const result = await gql(`
      query {
        search(query: "GraphQL test note") {
          item { id type }
          metadata { tags }
          relevance_score
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const results = result.data?.search as { item: { type: string } }[];
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("fetches type schemas", async () => {
    const result = await gql(`
      query {
        types { id version states default_state }
      }
    `);

    expect(result.errors).toBeUndefined();
    const types = result.data?.types as { id: string }[];
    expect(types.length).toBeGreaterThan(0);
    expect(types.some((t) => t.id === "core.note")).toBe(true);
  });

  it("fetches single type schema", async () => {
    const result = await gql(`
      query {
        type(id: "core.note") { id version fields }
      }
    `);

    expect(result.errors).toBeUndefined();
    const schema = result.data?.type as {
      id: string;
      fields: Record<string, unknown>;
    };
    expect(schema.id).toBe("core.note");
    expect(schema.fields).toHaveProperty("body");
  });
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

describe("GraphQL mutations", () => {
  let itemId: string;

  it("creates and updates an item", async () => {
    const createResult = await gql(`
      mutation {
        createItem(input: {
          type: "core.note"
          properties: { body: "Original", title: "Update Test" }
        }) { item { id version } }
      }
    `);
    itemId = (createResult.data?.createItem as { item: { id: string } }).item
      .id;

    const updateResult = await gql(
      `
      mutation($id: ID!) {
        updateItem(id: $id, properties: { body: "Updated" }) {
          item { id version properties }
          metadata { tags }
        }
      }
    `,
      { id: itemId },
    );

    expect(updateResult.errors).toBeUndefined();
    const updated = (
      updateResult.data?.updateItem as {
        item: { version: number; properties: Record<string, unknown> };
      }
    ).item;
    expect(updated.version).toBe(2);
    expect(updated.properties.body).toBe("Updated");
  });

  it("deletes an item", async () => {
    const result = await gql(
      `
      mutation($id: ID!) {
        deleteItem(id: $id) { ok }
      }
    `,
      { id: itemId },
    );

    expect(result.errors).toBeUndefined();
    expect((result.data?.deleteItem as { ok: boolean }).ok).toBe(true);
  });

  it("adds and removes tags", async () => {
    const createResult = await gql(`
      mutation {
        createItem(input: {
          type: "core.note"
          properties: { body: "Tag test" }
        }) { item { id } }
      }
    `);
    const id = (createResult.data?.createItem as { item: { id: string } }).item
      .id;

    const addResult = await gql(
      `
      mutation($itemId: ID!) {
        addTags(itemId: $itemId, tags: ["new-tag", "another"]) {
          metadata { tags }
        }
      }
    `,
      { itemId: id },
    );

    expect(addResult.errors).toBeUndefined();
    const tags = (addResult.data?.addTags as { metadata: { tags: string[] } })
      .metadata.tags;
    expect(tags).toContain("new-tag");
    expect(tags).toContain("another");

    const removeResult = await gql(
      `
      mutation($itemId: ID!) {
        removeTag(itemId: $itemId, tag: "new-tag") {
          metadata { tags }
        }
      }
    `,
      { itemId: id },
    );

    expect(removeResult.errors).toBeUndefined();
    const remaining = (
      removeResult.data?.removeTag as { metadata: { tags: string[] } }
    ).metadata.tags;
    expect(remaining).not.toContain("new-tag");
    expect(remaining).toContain("another");
  });

  it("transitions item state", async () => {
    const createResult = await gql(`
      mutation {
        createItem(input: {
          type: "core.note"
          properties: { body: "Transition test" }
        }) { item { id state } }
      }
    `);
    const id = (createResult.data?.createItem as { item: { id: string } }).item
      .id;

    const result = await gql(
      `
      mutation($id: ID!) {
        transitionItem(id: $id, state: "active") {
          item { id state }
        }
      }
    `,
      { id },
    );

    expect(result.errors).toBeUndefined();
    expect(
      (result.data?.transitionItem as { item: { state: string } }).item.state,
    ).toBe("active");
  });

  it("sets metadata", async () => {
    const createResult = await gql(`
      mutation {
        createItem(input: {
          type: "core.note"
          properties: { body: "Metadata test" }
        }) { item { id } }
      }
    `);
    const id = (createResult.data?.createItem as { item: { id: string } }).item
      .id;

    const result = await gql(
      `
      mutation($itemId: ID!) {
        setMetadata(itemId: $itemId, tags: ["alpha", "beta"], about: ["related-id"]) {
          metadata { tags about }
        }
      }
    `,
      { itemId: id },
    );

    expect(result.errors).toBeUndefined();
    const meta = (
      result.data?.setMetadata as {
        metadata: { tags: string[]; about: string[] };
      }
    ).metadata;
    expect(meta.tags).toEqual(["alpha", "beta"]);
    expect(meta.about).toEqual(["related-id"]);
  });
});

// ---------------------------------------------------------------------------
// Auth enforcement
// ---------------------------------------------------------------------------

describe("GraphQL auth", () => {
  it("returns error without authentication", async () => {
    const result = await gqlNoAuth(`
      query { items(limit: 10) { data { id } } }
    `);
    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]?.message).toContain("Authentication required");
  });

  it("returns error for unauthenticated mutation", async () => {
    const result = await gqlNoAuth(`
      mutation {
        createItem(input: { type: "core.note", properties: { body: "No auth" } }) {
          item { id }
        }
      }
    `);
    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]?.message).toContain("Authentication required");
  });
});

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

describe("GraphQL threads", () => {
  it("creates and lists threads", async () => {
    // Create a thread via REST (no mutation for this yet)
    await request(ctx.app, "POST", "/threads", { key: ctx.adminKey });

    const result = await gql(`
      query {
        threads(limit: 10) {
          data { id created_at updated_at }
          has_more
        }
      }
    `);

    expect(result.errors).toBeUndefined();
    const threads = result.data?.threads as { data: { id: string }[] };
    expect(threads.data.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Pub/sub (unit test)
// ---------------------------------------------------------------------------

describe("GraphQL pub/sub", () => {
  it("publishes and receives events", async () => {
    const { publish, subscribe } = await import("./pubsub.js");

    const events: unknown[] = [];
    const iter = subscribe();

    // Set up a consumer
    const consumer = (async () => {
      for await (const event of iter) {
        events.push(event);
        if (events.length >= 2) break;
      }
    })();

    // Publish events
    publish({
      type: "created",
      item: {
        id: "1",
        type: "core.note",
        state: "new",
        properties: {},
        created_at: "",
        updated_at: "",
        timestamp: "",
        version: 1,
        parent_id: null,
        thread_id: null,
      },
    });
    publish({
      type: "updated",
      item: {
        id: "2",
        type: "core.note",
        state: "active",
        properties: {},
        created_at: "",
        updated_at: "",
        timestamp: "",
        version: 2,
        parent_id: null,
        thread_id: null,
      },
    });

    await consumer;
    expect(events).toHaveLength(2);
  });

  it("filters events by type", async () => {
    const { publish, subscribe } = await import("./pubsub.js");

    const events: unknown[] = [];
    const iter = subscribe("core.work.book");

    const consumer = (async () => {
      for await (const event of iter) {
        events.push(event);
        if (events.length >= 1) break;
      }
    })();

    // This should be filtered out
    publish({
      type: "created",
      item: {
        id: "3",
        type: "core.note",
        state: "new",
        properties: {},
        created_at: "",
        updated_at: "",
        timestamp: "",
        version: 1,
        parent_id: null,
        thread_id: null,
      },
    });
    // This should pass through
    publish({
      type: "created",
      item: {
        id: "4",
        type: "core.work.book",
        state: "new",
        properties: {},
        created_at: "",
        updated_at: "",
        timestamp: "",
        version: 1,
        parent_id: null,
        thread_id: null,
      },
    });

    await consumer;
    expect(events).toHaveLength(1);
  });
});
