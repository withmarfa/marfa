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

describe("a field named like an object's built-in member, judged against subtypes", () => {
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
      ]) as TypeSchema["fields"],
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
});
