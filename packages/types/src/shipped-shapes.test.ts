import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ALL_CONNECTOR_TYPES,
  ALL_EDGE_TYPES,
  ALL_SYSTEM_TYPES,
  ALL_TYPES,
  SHIPPED_EDGE_TYPE_SHAPES,
  SHIPPED_TYPE_SHAPES,
} from "./index.js";

/**
 * A definition as the shapes carry it: prose and the id left out of each
 * definition, and every name under `fields` and `property_schema` kept, since
 * a field may be called `description` or `label`.
 */
function withoutProse(value: unknown, named = false): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutProse(v));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => named || !["label", "description", "id"].includes(key))
      .map(([key, v]) => [
        key,
        withoutProse(v, !named && ["fields", "property_schema"].includes(key)),
      ]),
  );
}

describe("the shipped shapes", () => {
  it("carry every shipped type as its registry entry reads, less the prose", () => {
    const shipped = [...ALL_TYPES, ...ALL_CONNECTOR_TYPES, ...ALL_SYSTEM_TYPES];
    expect(Object.keys(SHIPPED_TYPE_SHAPES).sort()).toEqual(
      shipped.map((t) => t.id).sort(),
    );
    for (const schema of shipped) {
      expect(
        SHIPPED_TYPE_SHAPES[schema.id as keyof typeof SHIPPED_TYPE_SHAPES],
        schema.id,
      ).toEqual(withoutProse(schema));
    }
  });

  it("keep a field named for prose, which only its definition's prose leaves", () => {
    // Witnesses: the registry has these fields, so a filter that dropped
    // them by name would pass the comparisons above by agreeing with itself.
    expect(
      ALL_TYPES.find((t) => t.id === "core.task")?.fields.description,
    ).toBeDefined();
    expect(SHIPPED_TYPE_SHAPES["core.task"].fields.description).toEqual({
      type: "string",
    });
    expect(
      ALL_SYSTEM_TYPES.find((t) => t.id === "system.credential")?.fields.label,
    ).toBeDefined();
    expect(SHIPPED_TYPE_SHAPES["system.credential"].fields.label).toBeDefined();
  });

  it("carry every shipped edge type the same way", () => {
    expect(Object.keys(SHIPPED_EDGE_TYPE_SHAPES).sort()).toEqual(
      ALL_EDGE_TYPES.map((e) => e.id).sort(),
    );
    for (const edge of ALL_EDGE_TYPES) {
      expect(
        SHIPPED_EDGE_TYPE_SHAPES[
          edge.id as keyof typeof SHIPPED_EDGE_TYPE_SHAPES
        ],
        edge.id,
      ).toEqual(withoutProse(edge));
    }
  });

  it("keep their values as literal types, which is what the surface lock hashes", () => {
    // Checked by the compiler when the package typechecks: a widened emit
    // makes these `string`, and the assertions stop compiling.
    expectTypeOf(
      SHIPPED_TYPE_SHAPES["core.task"].fields.priority.enum_values,
    ).toEqualTypeOf<readonly ["low", "medium", "high", "urgent"]>();
    expectTypeOf(
      SHIPPED_EDGE_TYPE_SHAPES["parent-of"].cardinality,
    ).toEqualTypeOf<"one-to-many">();
    expectTypeOf(
      SHIPPED_TYPE_SHAPES["core.task"].fields.description.type,
    ).toEqualTypeOf<"string">();
  });
});
