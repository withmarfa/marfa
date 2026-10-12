import { describe, expect, it } from "vitest";
import type { FieldDefinition } from "./type-registry.js";
import { validateDeclaredProperties } from "./type-registry.js";

const declared: Record<string, FieldDefinition> = {
  label: { type: "string", required: true },
  weight: { type: "number" },
  status: { type: "enum", enum_values: ["open", "done"] },
};

function fieldsRefused(properties: Record<string, unknown>): string[] {
  const judged = validateDeclaredProperties(declared, properties);
  return judged.success ? [] : judged.errors.map((e) => e.field).sort();
}

describe("validateDeclaredProperties", () => {
  it("passes properties that fit, and ones the schema does not declare", () => {
    const judged = validateDeclaredProperties(declared, {
      label: "a",
      weight: 1,
      status: "open",
      extra: { nested: true },
    });
    expect(judged.success).toBe(true);
  });

  it("names a property of the wrong type, outside its enum or missing", () => {
    expect(fieldsRefused({ label: "a", weight: "heavy" })).toEqual(["weight"]);
    expect(fieldsRefused({ label: "a", status: "stuck" })).toEqual(["status"]);
    expect(fieldsRefused({ weight: 1 })).toEqual(["label"]);
    expect(fieldsRefused({ label: null })).toEqual(["label"]);
  });

  it("names every property a value breaks", () => {
    expect(fieldsRefused({ weight: "x", status: "y" })).toEqual([
      "label",
      "status",
      "weight",
    ]);
  });

  it("treats null on an optional property as unset", () => {
    expect(fieldsRefused({ label: "a", weight: null })).toEqual([]);
  });

  it("reads a required property named like a built-in member as absent", () => {
    const builtIn = JSON.parse(
      '{"toString":{"type":"string","required":true}}',
    ) as Record<string, FieldDefinition>;
    expect(validateDeclaredProperties(builtIn, {}).success).toBe(false);
  });

  it("takes any properties from a schema that declares none", () => {
    expect(
      validateDeclaredProperties({}, { anything: [1], label: 2 }).success,
    ).toBe(true);
  });
});
