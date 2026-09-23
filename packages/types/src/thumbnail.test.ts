import { describe, expect, it } from "vitest";
import { validateTypeSchema } from "./schema-validation.js";
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
