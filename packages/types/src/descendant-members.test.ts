import { describe, expect, it } from "vitest";
import { validateTypeSchema } from "./schema-validation.js";
import type { TypeSchema } from "./schema-types.js";

const child: TypeSchema = {
  id: "acme.album.raw",
  version: 1,
  parent: "acme.album",
  fields: { size: { type: "integer" } },
  display_hints: { title_field: "flag" },
  merge_policy: { fields: { flag: "keep_both_copies" } },
};

function parentWith(fields: Record<string, unknown>, keepFlag = true) {
  return validateTypeSchema(
    {
      id: "acme.album",
      fields: keepFlag ? { flag: { type: "string" }, ...fields } : fields,
    },
    {
      resolveSchema: () => undefined,
      descendantsOf: (id) => (id === "acme.album" ? [child] : []),
    },
  );
}

describe("a change to a parent, judged against the subtypes it has", () => {
  it("takes a field named like an object's built-in member", () => {
    // The witness: a field the subtype does not declare is taken.
    expect(parentWith({ cover: { type: "string" } }).success).toBe(true);
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      const result = parentWith({ [name]: { type: "string" } });
      expect(result.success, name).toBe(true);
    }
  });

  it("still refuses a built-in name the subtype declares with another shape", () => {
    const withBuiltIn: TypeSchema = {
      ...child,
      fields: Object.fromEntries([
        ...Object.entries(child.fields),
        ["toString", { type: "integer" }],
      ]),
    };
    const result = validateTypeSchema(
      { id: "acme.album", fields: { toString: { type: "string" } } },
      {
        resolveSchema: () => undefined,
        descendantsOf: () => [withBuiltIn],
      },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]?.code).toBe("inheritance_violation");
    }
  });

  it("refuses to drop a field a subtype's display hint or merge policy names", () => {
    // The witness: the parent declaring the field is taken.
    expect(parentWith({ other: { type: "string" } }).success).toBe(true);
    const result = parentWith({ other: { type: "string" } }, false);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.errors.map((e) => `${e.field}: ${e.message}`);
      expect(result.errors.every((e) => e.field === "fields.flag")).toBe(true);
      expect(messages.join("\n")).toContain("acme.album.raw");
      expect(messages.join("\n")).toContain("display_hints.title_field");
      expect(messages.join("\n")).toContain("merge_policy.fields");
    }
  });

  it("does not ask the parent for a field the subtype declares itself", () => {
    const own: TypeSchema = {
      ...child,
      fields: { ...child.fields, flag: { type: "string" } },
    };
    const result = validateTypeSchema(
      { id: "acme.album", fields: { other: { type: "string" } } },
      {
        resolveSchema: () => undefined,
        descendantsOf: () => [own],
      },
    );
    // "flag" is declared by the subtype itself, so dropping nothing from the
    // parent leaves the hint valid.
    expect(result.success).toBe(true);
  });
});
