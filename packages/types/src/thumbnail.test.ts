import { describe, expect, it } from "vitest";
import {
  validateEdgeTypeSchema,
  validateTypeSchema,
} from "./schema-validation.js";
import type { TypeSchema } from "./schema-types.js";

const parent: TypeSchema = {
  id: "acme.photo",
  version: 1,
  fields: { thumbnail: { type: "thumbnail" } },
};
const validate = (data: unknown) =>
  validateTypeSchema(data, {
    resolveSchema: (id) => (id === parent.id ? parent : undefined),
  });

describe("a thumbnail field", () => {
  it("is declared by its type or by the format, and stored one way", () => {
    for (const declared of [
      { type: "thumbnail" },
      { type: "string", format: "thumbnail" },
    ]) {
      const result = validate({ id: "acme.a", fields: { cover: declared } });
      expect(result.success, JSON.stringify(result)).toBe(true);
      if (result.success) {
        expect(result.data.fields.cover).toEqual({ type: "thumbnail" });
      }
    }
  });

  it("is refused on a parent whose registered child already declares one", () => {
    const child: TypeSchema = {
      id: "acme.photo.raw",
      version: 1,
      parent: "acme.album",
      fields: { preview: { type: "thumbnail" } },
    };
    const withChildren = (data: unknown) =>
      validateTypeSchema(data, {
        resolveSchema: () => undefined,
        descendantsOf: (id) => (id === "acme.album" ? [child] : []),
      });
    // The witness: the parent without a thumbnail is taken.
    expect(
      withChildren({ id: "acme.album", fields: { label: { type: "string" } } })
        .success,
    ).toBe(true);
    const result = withChildren({
      id: "acme.album",
      fields: { cover: { type: "thumbnail" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]?.actual).toContain(
        '"preview" in "acme.photo.raw"',
      );
    }
  });

  it("is taken on a parent whose registered child declares it under the same name", () => {
    const child: TypeSchema = {
      id: "acme.photo.raw",
      version: 1,
      parent: "acme.album",
      fields: { thumbnail: { type: "thumbnail" } },
    };
    const result = validateTypeSchema(
      { id: "acme.album", fields: { thumbnail: { type: "thumbnail" } } },
      {
        resolveSchema: () => undefined,
        descendantsOf: (id) => (id === "acme.album" ? [child] : []),
      },
    );
    expect(
      result.success,
      "a child redeclaring the thumbnail its parent gains was counted as a second one",
    ).toBe(true);
  });

  it("is refused on a parent whose registered child declares the same name as something else", () => {
    const child: TypeSchema = {
      id: "acme.photo.raw",
      version: 1,
      parent: "acme.album",
      fields: { cover: { type: "string" }, count: { type: "string" } },
    };
    const withChild = (fields: Record<string, unknown>) =>
      validateTypeSchema(
        { id: "acme.album", fields },
        {
          resolveSchema: () => undefined,
          descendantsOf: (id) => (id === "acme.album" ? [child] : []),
        },
      );
    // The witness: the parent declaring the child's fields as the child
    // does is taken.
    expect(withChild({ cover: { type: "string" } }).success).toBe(true);
    for (const [name, declared] of [
      ["cover", { type: "thumbnail" }],
      ["count", { type: "integer" }],
    ] as const) {
      const result = withChild({ [name]: declared });
      expect(result.success, `${name} as ${declared.type}`).toBe(false);
      if (!result.success) {
        expect(result.errors[0]?.field).toBe(`fields.${name}.type`);
        expect(result.errors[0]?.code).toBe("inheritance_violation");
        expect(result.errors[0]?.actual).toContain('"acme.photo.raw"');
      }
    }
  });

  it("is never a title or a body, and never an edge's property", () => {
    for (const hint of ["title_field", "body_field"]) {
      const result = validate({
        id: "acme.hinted",
        fields: { cover: { type: "thumbnail" }, caption: { type: "string" } },
        display_hints: { [hint]: "cover" },
      });
      expect(result.success, hint).toBe(false);
    }
    // The witness: a hint naming the text field is taken.
    expect(
      validate({
        id: "acme.hinted",
        fields: { cover: { type: "thumbnail" }, caption: { type: "string" } },
        display_hints: { title_field: "caption" },
      }).success,
    ).toBe(true);
    const edge = validateEdgeTypeSchema({
      id: "depicts",
      cardinality: "many-to-many",
      property_schema: { preview: { type: "thumbnail" } },
    });
    expect(edge.success).toBe(false);
    expect(
      validateEdgeTypeSchema({
        id: "depicts",
        cardinality: "many-to-many",
        property_schema: { note: { type: "string" } },
      }).success,
    ).toBe(true);
  });

  it("is never named by a hint where the type inherits it", () => {
    // The witness: a hint naming the child's own text field is taken.
    expect(
      validate({
        id: "acme.photo.raw",
        parent: parent.id,
        fields: { caption: { type: "string" } },
        display_hints: { title_field: "caption" },
      }).success,
    ).toBe(true);
    for (const hint of ["title_field", "body_field"]) {
      const result = validate({
        id: "acme.photo.raw",
        parent: parent.id,
        fields: { caption: { type: "string" } },
        display_hints: { [hint]: "thumbnail" },
      });
      expect(result.success, hint).toBe(false);
      if (!result.success) {
        expect(result.errors[0]?.field).toBe(`display_hints.${hint}`);
      }
    }
  });

  it("is never an array's element type, on a type or an edge", () => {
    // The witness: an array of strings is taken on both.
    expect(
      validate({
        id: "acme.album",
        fields: { labels: { type: "array", items_type: "string" } },
      }).success,
    ).toBe(true);
    expect(
      validateEdgeTypeSchema({
        id: "depicts",
        cardinality: "many-to-many",
        property_schema: { labels: { type: "array", items_type: "string" } },
      }).success,
    ).toBe(true);
    for (const name of ["covers", "title"]) {
      const result = validate({
        id: "acme.album",
        fields: { [name]: { type: "array", items_type: "thumbnail" } },
      });
      expect(result.success, name).toBe(false);
      if (!result.success) {
        expect(result.errors[0]?.field).toBe(`fields.${name}.items_type`);
      }
    }
    expect(
      validateEdgeTypeSchema({
        id: "depicts",
        cardinality: "many-to-many",
        property_schema: {
          previews: { type: "array", items_type: "thumbnail" },
        },
      }).success,
    ).toBe(false);
  });

  it("is refused beside one the type inherits", () => {
    // The witness: the child alone, with no thumbnail of its own, registers.
    expect(
      validate({
        id: "acme.photo.raw",
        parent: parent.id,
        fields: { camera: { type: "string" } },
      }).success,
    ).toBe(true);
    const result = validate({
      id: "acme.photo.raw",
      parent: parent.id,
      fields: { preview: { type: "thumbnail" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]?.field).toBe("fields.preview");
      expect(result.errors[0]?.actual).toContain(
        '"thumbnail" from "acme.photo"',
      );
    }
  });
});
