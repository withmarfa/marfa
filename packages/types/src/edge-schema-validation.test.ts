import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { validateEdgeTypeSchema } from "./schema-validation.js";
import { ALL_EDGE_TYPES } from "../generated/edge-type-registry.js";

describe("validateEdgeTypeSchema", () => {
  it("accepts a minimal schema and applies the defaults", () => {
    const result = validateEdgeTypeSchema({
      id: "cites",
      cardinality: "many-to-many",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      id: "cites",
      cardinality: "many-to-many",
      source_type_constraints: ["*"],
      target_type_constraints: ["*"],
      cascade_on_delete: "orphan",
      property_schema: {},
    });
  });

  it("normalizes edge properties through the item-field model", () => {
    const result = validateEdgeTypeSchema({
      id: "linked-from",
      cardinality: "many-to-many",
      property_schema: {
        source_url: { type: "string", format: "url" },
        position: { type: "number", description: "Ordering." },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // format: "url" collapses to type: "url" exactly as on an item field.
    expect(result.data.property_schema.source_url).toEqual({ type: "url" });
    expect(result.data.property_schema.position).toEqual({
      type: "number",
      description: "Ordering.",
    });
  });

  it("rejects a non-object input", () => {
    const result = validateEdgeTypeSchema("in-thread");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]?.field).toBe("(root)");
  });

  it("rejects ids that are not kebab-case", () => {
    for (const id of ["In-Thread", "in_thread", "in.thread", "in/thread", ""]) {
      const result = validateEdgeTypeSchema({
        id,
        cardinality: "many-to-many",
      });
      expect(result.success, `id ${JSON.stringify(id)} should fail`).toBe(
        false,
      );
      if (result.success) continue;
      expect(result.errors[0]?.field).toBe("id");
    }
  });

  it("rejects a missing or unknown cardinality", () => {
    for (const cardinality of [undefined, "one-to-few", 4]) {
      const result = validateEdgeTypeSchema({ id: "cites", cardinality });
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.errors[0]?.field).toBe("cardinality");
    }
  });

  it("rejects an unknown cascade and empty or malformed constraints", () => {
    const cascade = validateEdgeTypeSchema({
      id: "cites",
      cardinality: "many-to-many",
      cascade_on_delete: "detach",
    });
    expect(cascade.success).toBe(false);

    for (const bad of [[], ["*", ""], "core.note", [42]]) {
      const result = validateEdgeTypeSchema({
        id: "cites",
        cardinality: "many-to-many",
        target_type_constraints: bad,
      });
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.errors[0]?.field).toBe("target_type_constraints");
    }
  });

  it("rejects a property with an unknown field type, naming the field", () => {
    const result = validateEdgeTypeSchema({
      id: "cites",
      cardinality: "many-to-many",
      property_schema: { weight: { type: "float" } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors[0]?.field).toBe("fields.weight.type");
  });

  it("collects every failure instead of stopping at the first", () => {
    const result = validateEdgeTypeSchema({
      id: "Not Kebab",
      cardinality: "sideways",
      cascade_on_delete: "explode",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("in-tree edge schemas round-trip through the validator", () => {
  // The registry the codegen emitted must be exactly what the validator
  // produces from the JSON on disk — the same guarantee the type set gets
  // from schema-round-trip.test.ts. A drift here means the generated file
  // is stale or the emitter and the validator disagree about normalization.
  const edgesDir = resolve(import.meta.dirname, "..", "core", "edges");
  const fromDisk = readdirSync(edgesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const raw = JSON.parse(
        readFileSync(join(edgesDir, file), "utf-8"),
      ) as Record<string, unknown>;
      const result = validateEdgeTypeSchema(raw);
      if (!result.success) {
        throw new Error(
          `${file} failed validation: ${result.errors
            .map((e) => e.message)
            .join("; ")}`,
        );
      }
      return result.data;
    });

  it("every edge JSON on disk validates and matches the emitted registry", () => {
    const registryById = new Map(ALL_EDGE_TYPES.map((e) => [e.id, e]));
    expect(fromDisk.length).toBe(ALL_EDGE_TYPES.length);
    for (const edge of fromDisk) {
      expect(registryById.get(edge.id)).toEqual(edge);
    }
  });
});
