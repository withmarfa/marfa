import { describe, expect, it } from "vitest";
import type { TypeSchema } from "@withmarfa/types";
import { diffTypeSchemas, isValidVersionBump } from "./diff-type-schemas.js";

function schema(overrides: Partial<TypeSchema> = {}): TypeSchema {
  return {
    id: "acme.thing",
    version: 1,
    fields: { title: { type: "string", required: true } },
    ...overrides,
  };
}

describe("diffTypeSchemas", () => {
  it("reports no-op for an identical resubmission", () => {
    expect(diffTypeSchemas(schema(), schema())).toBe("noop");
  });

  it("reports major when a required field is added", () => {
    const next = schema({
      version: 2,
      fields: {
        title: { type: "string", required: true },
        body: { type: "string", required: true },
      },
    });
    expect(diffTypeSchemas(schema(), next)).toBe("major");
    expect(isValidVersionBump("major", 1, 2)).toBe(true);
    expect(isValidVersionBump("major", 1, 1)).toBe(false);
  });

  it("reports minor when an optional field is added", () => {
    const next = schema({
      version: 2,
      fields: {
        title: { type: "string", required: true },
        body: { type: "string" },
      },
    });
    expect(diffTypeSchemas(schema(), next)).toBe("minor");
  });
});

describe("diffTypeSchemas — compatible_with shapes", () => {
  it("treats a gained claim as widening and a withdrawn one as breaking", () => {
    const bare = schema();
    const claiming = schema({ version: 2, compatible_with: ["core.note"] });
    expect(diffTypeSchemas(bare, claiming)).toBe("minor");
    expect(diffTypeSchemas(claiming, bare)).toBe("major");
  });

  it("does not invent a breaking change from the single-target shorthand", () => {
    // The validator accepts a bare string and normalizes it, but custom types
    // registered before it did are stored unnormalized. Iterating one as a Set
    // yields its characters, which made an untouched claim read as withdrawn:
    // a descriptive edit would then be refused for want of a version bump.
    const stored = {
      ...schema({ label: "Thing" }),
      compatible_with: "core.note",
    } as unknown as TypeSchema;
    const resubmitted = schema({
      label: "Thing",
      compatible_with: ["core.note"],
    });
    expect(diffTypeSchemas(stored, resubmitted)).toBe("noop");
  });

  it("still sees a real withdrawal made against a shorthand claim", () => {
    const stored = {
      ...schema(),
      compatible_with: "core.note",
    } as unknown as TypeSchema;
    const withdrawn = schema({ version: 2 });
    expect(diffTypeSchemas(stored, withdrawn)).toBe("major");
  });
});
