import { randomBytes } from "node:crypto";
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

/** What an archive holds: shape faults, and a `string` with a `format` a type absorbs. */
const FAULTS: Record<string, Record<string, unknown>> = {
  list: { type: "array" },
  pick: { type: "enum" },
  stray: { type: "string", enum_values: ["a"] },
  loose: { type: "array", items_type: "somethingelse" },
  link: { type: "string", format: "url", enum_values: ["a"] },
};

/** What a registration would have stored for them. */
const STORED: Record<string, Record<string, unknown>> = {
  ...FAULTS,
  link: { type: "url", enum_values: ["a"] },
};

/** An id of its own for each attempt, so a retry after a commit registers anew. */
const attempt = (ctx: TestContext, name: string) =>
  `mock.shapes.${name}-${randomBytes(4).toString("hex")}.${ctx.runId}`;

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
  it("restores from an archive and reads as a registration would have stored it", async () => {
    const refused = await client.registerEdgeType({
      label: "Test edge type",
      id: attempt(ctx, "direct"),
      cardinality: "many-to-many",
      property_schema: FAULTS,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");

    const id = attempt(ctx, "restored");
    trackEdgeType(ctx, id);
    const restored = await owner.restoreArchive(archiveOf(id, FAULTS));
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({ edge_types_registered: 1 });
    const read = (await client.listEdgeTypes()).data.data.find(
      (t) => t.id === id,
    );
    expect(read?.property_schema).toEqual(STORED);
  });

  it("takes a change of its endpoint constraints that leaves the properties as held, and judges a property the change alters", async () => {
    const id = attempt(ctx, "evolved");
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
      ...STORED,
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
      ...STORED,
      list: { type: "array", items_type: "string" },
    });
    expect(mended.status, JSON.stringify(mended.error)).toBe(409);
    expect(mended.error?.error.code).toBe("conflict");

    const widened = await evolve(STORED);
    expect(widened.status, JSON.stringify(widened.error)).toBe(200);
    expect(widened.data.from_type_constraints).toEqual([
      "core.note",
      "core.task",
    ]);
    expect(widened.data.property_schema).toEqual(STORED);

    const added = await evolve({ ...STORED, fresh: { type: "array" } });
    expect(added.status).toBe(400);
    expect(added.error?.error.code).toBe("invalid_schema");
  });

  it("refuses an archive whose edge type holds a property of no field type, and registers nothing", async () => {
    const id = attempt(ctx, "notype");
    trackEdgeType(ctx, id);
    const refused = await owner.restoreArchive(
      archiveOf(id, { ...FAULTS, odd: { type: "mystery" } }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    expect(
      (refused.error?.error.details?.errors as { field: string }[]).map(
        (error) => error.field,
      ),
    ).toEqual(["property_schema.odd.type"]);
    const listed = await client.listEdgeTypes();
    expect(listed.data.data.map((t) => t.id)).not.toContain(id);

    // The witness: without that property the same archive restores.
    const restored = await owner.restoreArchive(archiveOf(id, FAULTS));
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
  });
});
