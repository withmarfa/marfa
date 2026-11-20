import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { editLineFile, itemsArchive } from "../../utils/archive.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackEdgeType,
} from "../../utils/setup.js";

/**
 * A registration refuses an edge property with no `items_type`, an enum with
 * no `enum_values` and `enum_values` on a property that is not an enum, but an
 * edge type an earlier registration stored with one still reads, restores
 * from an archive and takes a change of its endpoint constraints. The only way
 * to hold one is an archive that says so.
 */
let client: MarfaClient;
let owner: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "restore-edge-property-shapes",
  ));
  owner = getOwnerClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

const FAULTS: Record<string, Record<string, unknown>> = {
  list: { type: "array" },
  pick: { type: "enum" },
  stray: { type: "string", enum_values: ["a"] },
};

const archiveOf = (id: string, properties: Record<string, unknown>) =>
  editLineFile(
    itemsArchive([]),
    "instance",
    () =>
      `${JSON.stringify({
        edge_type: {
          id,
          label: "Test edge type",
          cardinality: "many-to-many",
          from_type_constraints: ["core.note"],
          to_type_constraints: ["core.note"],
          property_schema: properties,
        },
      })}\n`,
  );

describe("an edge type whose properties break the shape rules", () => {
  it("restores from an archive and reads as the archive held it", async () => {
    // The witness: the same properties are refused when they are registered.
    const refused = await client.registerEdgeType({
      label: "Test edge type",
      id: `mock.shapes.direct.${ctx.runId}`,
      cardinality: "many-to-many",
      property_schema: FAULTS,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");

    const id = `mock.shapes.restored.${ctx.runId}`;
    trackEdgeType(ctx, id);
    const restored = await owner.restoreArchive(archiveOf(id, FAULTS));
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({ edge_types_registered: 1 });
    const read = (await client.listEdgeTypes()).data.data.find(
      (t) => t.id === id,
    );
    expect(read?.property_schema).toEqual(FAULTS);
  });

  it("takes a change of its endpoint constraints that leaves the properties as held, and judges a property the change alters", async () => {
    const id = `mock.shapes.evolved.${ctx.runId}`;
    trackEdgeType(ctx, id);
    const restored = await owner.restoreArchive(archiveOf(id, FAULTS));
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);

    const evolve = (properties: Record<string, unknown>) =>
      client.registerEdgeType({
        label: "Test edge type",
        id,
        cardinality: "many-to-many",
        from_type_constraints: ["core.note", "core.task"],
        to_type_constraints: ["core.note"],
        property_schema: properties,
        evolve_constraints: true,
      } as never);

    const changed = await evolve({
      ...FAULTS,
      list: { type: "array", description: "changed" },
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(400);
    expect(changed.error?.error.code).toBe("invalid_schema");
    expect(
      (changed.error?.error.details?.errors as { field: string }[]).map(
        (error) => error.field,
      ),
    ).toEqual(["property_schema.list.items_type"]);
    const mended = await evolve({
      ...FAULTS,
      list: { type: "array", items_type: "string" },
    });
    expect(mended.status, JSON.stringify(mended.error)).toBe(409);
    expect(mended.error?.error.code).toBe("conflict");

    const widened = await evolve(FAULTS);
    expect(widened.status, JSON.stringify(widened.error)).toBe(200);
    expect(widened.data.from_type_constraints).toEqual([
      "core.note",
      "core.task",
    ]);
    expect(widened.data.property_schema).toEqual(FAULTS);

    // A property the change adds is judged as a registration judges it.
    const added = await evolve({ ...FAULTS, fresh: { type: "array" } });
    expect(added.status).toBe(400);
    expect(added.error?.error.code).toBe("invalid_schema");
  });
});
