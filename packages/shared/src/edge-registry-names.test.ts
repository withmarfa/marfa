import { afterEach, describe, expect, it } from "vitest";
import {
  edgeNameCollisions,
  registerEdgeTypeSchema,
  unregisterEdgeTypeSchema,
} from "./edge-registry.js";

const registered: string[] = [];

afterEach(() => {
  for (const id of registered.splice(0)) unregisterEdgeTypeSchema(id);
});

function register(id: string, reverse_name?: string): void {
  registerEdgeTypeSchema({
    id,
    cardinality: "many-to-many",
    source_type_constraints: ["*"],
    target_type_constraints: ["*"],
    cascade_on_delete: "orphan",
    property_schema: {},
    written_at: "source",
    ...(reverse_name !== undefined && { reverse_name }),
  });
  registered.push(id);
}

describe("edgeNameCollisions", () => {
  it("names nothing for the shipped set", () => {
    expect(edgeNameCollisions()).toEqual({});
  });

  it("names a registration whose id a shipped type holds as its reverse name", () => {
    // A registration made before `parent-of` took `child-of` loads at boot
    // past the rules a registration meets today.
    register("child-of");
    expect(edgeNameCollisions()).toEqual({
      "child-of": ["parent-of", "child-of"],
    });
  });

  it("names two registrations that claim one reverse name", () => {
    register("test.first", "test.shared");
    register("test.second", "test.shared");
    expect(edgeNameCollisions()).toEqual({
      "test.shared": ["test.first", "test.second"],
    });
  });
});
