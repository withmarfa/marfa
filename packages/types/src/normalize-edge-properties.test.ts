import { describe, expect, it } from "vitest";
import { normalizeEdgeProperties } from "./schema-validation.js";

describe("normalizeEdgeProperties", () => {
  it("stores a string with a type-naming format as that type", () => {
    const result = normalizeEdgeProperties({
      contact: { type: "string", format: "email", required: true },
      homepage: { type: "string", format: "url" },
      locale: { type: "string", format: "bcp47" },
      size: { type: "number" },
    });
    expect(result).toEqual({
      success: true,
      data: {
        contact: { type: "email", required: true },
        homepage: { type: "url" },
        locale: { type: "string", format: "bcp47" },
        size: { type: "number" },
      },
    });
  });

  it("refuses a format that does not suit the property, naming it", () => {
    const result = normalizeEdgeProperties({
      size: { type: "number", format: "email" },
      kind: { type: "string", format: "nonsense" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.map((e) => e.field).sort()).toEqual([
        "property_schema.kind.format",
        "property_schema.size.format",
      ]);
    }
  });
});
