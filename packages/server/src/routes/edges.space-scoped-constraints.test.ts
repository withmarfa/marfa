/**
 * Endpoint-type constraints must resolve within the caller's space.
 *
 * `satisfiesEdgeConstraint` takes an optional space and fails closed on a
 * type it cannot resolve, and the enforcer was not passing one. Core and
 * system types resolve regardless of space, so the omission was invisible
 * for as long as every core edge constrained its endpoints to `*` and every
 * test used a space-less credential. `in-collection` is the first core edge
 * naming a type a space registers itself, and on a hosted deployment — where
 * every credential is space-bound — it refused the exact membership it
 * exists to allow, reporting `user.collection` as not allowed by
 * `["user.collection"]`.
 *
 * These tests use a space-bound credential throughout, which is what the
 * suites for this area were missing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

let ctx: TestContext;
let spaceKey: string;
const space = `space-ec-${Math.random().toString(36).slice(2, 10)}`;
const suffix = Math.random().toString(36).slice(2, 8);
const COLLECTION_TYPE = "user.collection";
const CUSTOM_EDGE = `user.filed-under-${suffix}`;
const CUSTOM_TARGET = `user.cabinet_${suffix}`;

interface ErrorResponse {
  error: { code: string; details?: { constraint?: string } };
}

async function mintSpaceKey(): Promise<string> {
  const raw = `marfa_k1_ec_${Math.random().toString(36).slice(2, 14)}`;
  await ctx.storage.keys.create(
    {
      label: "edge-constraint-space-scope",
      source: `ec-${suffix}`,
      space_permissions: [...SPACE_PERMISSIONS],
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      // The fixture registers the types the constraints name, and
      // registration is gated on the metadata map rather than on the space
      // permissions.
      metadata_permissions: { "*": "write" },
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    space,
  );
  return raw;
}

async function registerType(body: Record<string, unknown>): Promise<void> {
  const res = await request(ctx.app, "POST", "/types", { key: spaceKey, body });
  if (res.status === 201) return;
  const data = (await res.clone().json()) as ErrorResponse;
  expect(
    data.error.code,
    `POST /types ${String(body.id)} -> ${String(res.status)}: ${await res.text()}`,
  ).toBe("type_already_exists");
}

async function createItem(
  type: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: spaceKey,
    body: { type, properties },
  });
  expect(
    res.status,
    `POST /items ${type} -> ${String(res.status)}: ${await res.clone().text()}`,
  ).toBe(201);
  const data = (await res.json()) as { item: { id: string } };
  return data.item.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  spaceKey = await mintSpaceKey();
  await registerType({
    id: COLLECTION_TYPE,
    label: "Collection",
    description: "A named set of items.",
    version: 1,
    roles: ["container"],
    fields: {
      name: { type: "string", required: true, description: "Display name." },
    },
  });
  await registerType({
    id: CUSTOM_TARGET,
    label: "Cabinet",
    description: "A space-registered target for a custom edge.",
    version: 1,
    fields: {
      name: { type: "string", required: true, description: "Display name." },
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("a core edge constrained to a space-registered type", () => {
  it("accepts membership for a space-bound caller", async () => {
    const collection = await createItem(COLLECTION_TYPE, { name: "Reading" });
    const note = await createItem("core.note", { body: "a member" });
    const res = await request(ctx.app, "POST", "/edges", {
      key: spaceKey,
      body: {
        source_id: note,
        target_id: collection,
        edge_type: "in-collection",
        properties: { position: 1 },
      },
    });
    expect(
      res.status,
      `POST /edges -> ${String(res.status)}: ${await res.clone().text()}`,
    ).toBe(201);
  });

  it("still refuses a nested collection for a space-bound caller", async () => {
    const outer = await createItem(COLLECTION_TYPE, { name: "Outer" });
    const inner = await createItem(COLLECTION_TYPE, { name: "Inner" });
    const res = await request(ctx.app, "POST", "/edges", {
      key: spaceKey,
      body: {
        source_id: inner,
        target_id: outer,
        edge_type: "in-collection",
      },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.details?.constraint).toBe("nesting");
  });

  it("still refuses a target that is not a collection", async () => {
    const note = await createItem("core.note", { body: "source" });
    const other = await createItem("core.note", { body: "not a collection" });
    const res = await request(ctx.app, "POST", "/edges", {
      key: spaceKey,
      body: {
        source_id: note,
        target_id: other,
        edge_type: "in-collection",
      },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.code).toBe("edge_constraint_violation");
    expect(data.error.details?.constraint).toBeUndefined();
  });
});

describe("a custom edge constrained to a space-registered type", () => {
  // The same gap, reachable without any core edge at all: a space's own
  // edge type naming its own item type has always been able to hit it.
  it("accepts an endpoint of the space's own type", async () => {
    const created = await request(ctx.app, "POST", "/edge-types", {
      key: spaceKey,
      body: {
        id: CUSTOM_EDGE,
        cardinality: "many-to-many",
        source_type_constraints: ["*"],
        target_type_constraints: [CUSTOM_TARGET],
        cascade_on_delete: "orphan",
      },
    });
    expect(
      created.status,
      `POST /edge-types -> ${String(created.status)}: ${await created.clone().text()}`,
    ).toBe(201);

    const cabinet = await createItem(CUSTOM_TARGET, { name: "Files" });
    const note = await createItem("core.note", { body: "filed" });
    const res = await request(ctx.app, "POST", "/edges", {
      key: spaceKey,
      body: {
        source_id: note,
        target_id: cabinet,
        edge_type: CUSTOM_EDGE,
      },
    });
    expect(
      res.status,
      `POST /edges -> ${String(res.status)}: ${await res.clone().text()}`,
    ).toBe(201);
  });
});
