import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * `in-collection` ships in core but its target type does not: a collection is
 * a user-space concept, so a deployment registers `user.collection` itself and
 * the edge is waiting for it. These tests register it the way a user would and
 * then exercise the membership relation end to end.
 */

let ctx: TestContext;

const COLLECTION_TYPE = "user.collection";
const SMART_COLLECTION_TYPE = "user.collection.smart";

interface ItemResponse {
  item: { id: string };
}

interface ErrorResponse {
  error: { code: string; details?: { constraint?: string } };
}

async function registerType(body: Record<string, unknown>): Promise<void> {
  const res = await request(ctx.app, "POST", "/types", {
    key: ctx.adminKey,
    body,
  });
  // The type registry is a process-level singleton, so a sibling suite that
  // registered the same identifier first is not a failure here.
  if (res.status === 201) return;
  const data = (await res.clone().json()) as ErrorResponse;
  expect(
    data.error.code,
    `POST /types ${String(body.id)} -> ${String(res.status)}: ${await res.text()}`,
  ).toBe("type_already_exists");
}

async function createItem(type: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body:
      type === "core.note"
        ? { type, properties: { body: `note-${String(Math.random())}` } }
        : { type, properties: { name: `collection-${String(Math.random())}` } },
  });
  expect(
    res.status,
    `POST /items ${type} -> ${String(res.status)}: ${await res.clone().text()}`,
  ).toBe(201);
  const data = (await res.json()) as ItemResponse;
  return data.item.id;
}

async function joinCollection(
  memberId: string,
  collectionId: string,
  properties?: Record<string, unknown>,
): Promise<Response> {
  return await request(ctx.app, "POST", "/edges", {
    key: ctx.adminKey,
    body: {
      source_id: memberId,
      target_id: collectionId,
      edge_type: "in-collection",
      ...(properties ? { properties } : {}),
    },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  await registerType({
    id: COLLECTION_TYPE,
    name: "Collection",
    description: "A named set of items.",
    version: 1,
    fields: {
      name: { type: "string", required: true, description: "Display name." },
    },
  });
  await registerType({
    id: SMART_COLLECTION_TYPE,
    name: "Smart collection",
    description: "A collection whose membership is computed.",
    parent: COLLECTION_TYPE,
    version: 1,
    fields: {
      name: { type: "string", required: true, description: "Display name." },
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("in-collection membership", () => {
  it("puts an item in a collection", async () => {
    const member = await createItem("core.note");
    const collection = await createItem(COLLECTION_TYPE);
    const res = await joinCollection(member, collection, { position: 1 });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      edge: { edge_type: string; properties?: { position?: number } };
    };
    expect(data.edge.edge_type).toBe("in-collection");
    expect(data.edge.properties?.position).toBe(1);
  });

  it("lets one item belong to several collections", async () => {
    const member = await createItem("core.note");
    const first = await createItem(COLLECTION_TYPE);
    const second = await createItem(COLLECTION_TYPE);
    expect((await joinCollection(member, first)).status).toBe(201);
    expect((await joinCollection(member, second)).status).toBe(201);

    const edges = await request(ctx.app, "GET", `/items/${member}/edges`, {
      key: ctx.adminKey,
    });
    const data = (await edges.json()) as {
      data: { edge_type: string; target_id: string }[];
    };
    const targets = data.data
      .filter((e) => e.edge_type === "in-collection")
      .map((e) => e.target_id)
      .sort();
    expect(targets).toEqual([first, second].sort());
  });

  it("lets one collection hold several items", async () => {
    const collection = await createItem(COLLECTION_TYPE);
    const one = await createItem("core.note");
    const two = await createItem("core.note");
    expect((await joinCollection(one, collection)).status).toBe(201);
    expect((await joinCollection(two, collection)).status).toBe(201);

    const back = await request(
      ctx.app,
      "GET",
      `/items/${collection}/backrefs`,
      { key: ctx.adminKey },
    );
    const data = (await back.json()) as {
      data: { edge_type: string; source_id: string }[];
    };
    const sources = data.data
      .filter((e) => e.edge_type === "in-collection")
      .map((e) => e.source_id)
      .sort();
    expect(sources).toEqual([one, two].sort());
  });

  it("still refuses the same membership twice", async () => {
    const member = await createItem("core.note");
    const collection = await createItem(COLLECTION_TYPE);
    expect((await joinCollection(member, collection)).status).toBe(201);
    const again = await joinCollection(member, collection);
    expect(again.status).toBe(400);
    const data = (await again.json()) as ErrorResponse;
    expect(data.error.details?.constraint).toBe("duplicate");
  });
});

describe("in-collection refusals", () => {
  it("refuses a collection as a member of another collection", async () => {
    const inner = await createItem(COLLECTION_TYPE);
    const outer = await createItem(COLLECTION_TYPE);
    const res = await joinCollection(inner, outer);
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.code).toBe("edge_constraint_violation");
    expect(data.error.details?.constraint).toBe("nesting");
  });

  it("refuses a subtype of collection as a member too", async () => {
    const inner = await createItem(SMART_COLLECTION_TYPE);
    const outer = await createItem(COLLECTION_TYPE);
    const res = await joinCollection(inner, outer);
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.details?.constraint).toBe("nesting");
  });

  it("refuses a target that is not a collection", async () => {
    const member = await createItem("core.note");
    const notACollection = await createItem("core.note");
    const res = await joinCollection(member, notACollection);
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.code).toBe("edge_constraint_violation");
    // The declarative target constraint catches this one, not the nesting rule.
    expect(data.error.details?.constraint).toBeUndefined();
  });
});

describe("in-collection deletion", () => {
  it("leaves members alone when the collection is deleted", async () => {
    const member = await createItem("core.note");
    const collection = await createItem(COLLECTION_TYPE);
    expect((await joinCollection(member, collection)).status).toBe(201);

    const del = await request(ctx.app, "DELETE", `/items/${collection}`, {
      key: ctx.adminKey,
    });
    expect(del.status).toBe(200);

    const survivor = await request(ctx.app, "GET", `/items/${member}`, {
      key: ctx.adminKey,
    });
    expect(survivor.status).toBe(200);
  });
});
