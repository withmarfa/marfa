import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

// A built-in edge type lives only in code, so an upgrade carries a new one,
// and new wording on an old one, to an instance with no step and no stored
// definition to rewrite. An owner who had registered the identifier before it
// shipped keeps a stored row, which the shipped definition outranks.
const ADDED = "excerpt-of";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function note(): Promise<string> {
  const created = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: "note" },
  });
  return created.id;
}

interface Listed {
  id: string;
  shipped: boolean;
  cardinality: string;
  description: string | null;
}

async function listed(): Promise<Listed[]> {
  const res = await request(ctx.app, "GET", "/edge-types", {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Listed[] }).data;
}

describe("a shipped edge type an upgrade adds", () => {
  it("is listed as the code defines it, with the reworded references beside it", async () => {
    const types = await listed();
    const added = types.find((t) => t.id === ADDED);
    expect(added?.shipped).toBe(true);
    expect(added?.cardinality).toBe("many-to-one");
    expect(added?.description).toContain("highlight");

    const references = types.find((t) => t.id === "references");
    expect(references?.description).toContain("mention");
    expect(references?.description).not.toContain("highlight-on-a-book");
  });

  it("outranks a stored registration of the same identifier", async () => {
    // The witness: a registration under another identifier is listed from
    // its own stored row.
    await ctx.storage.edgeTypes.create({
      id: "mock.before-upgrade",
      label: "Before upgrade",
      reverse_label: "After upgrade",
      cardinality: "many-to-many",
      source_type_constraints: ["*"],
      target_type_constraints: ["*"],
      cascade_on_delete: "orphan",
      written_at: "source",
      property_schema: {},
    });
    await ctx.storage.edgeTypes.create({
      id: ADDED,
      label: "Stored",
      reverse_label: "Stored reverse",
      cardinality: "many-to-many",
      source_type_constraints: ["*"],
      target_type_constraints: ["*"],
      cascade_on_delete: "orphan",
      written_at: "source",
      property_schema: {},
    });

    const types = await listed();
    expect(types.find((t) => t.id === "mock.before-upgrade")?.shipped).toBe(
      false,
    );
    expect(types.filter((t) => t.id === ADDED)).toHaveLength(1);
    expect(types.find((t) => t.id === ADDED)?.shipped).toBe(true);

    const source = await note();
    const body = (target: string) => ({
      source_id: source,
      target_id: target,
      edge_type: ADDED,
    });
    const first = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: body(await note()),
    });
    expect(first.status).toBe(201);
    const second = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: body(await note()),
    });
    expect(second.status).toBe(400);
  });
});
