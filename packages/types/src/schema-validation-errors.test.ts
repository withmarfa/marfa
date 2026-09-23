import { describe, expect, it } from "vitest";
import { validateTypeSchema } from "./schema-validation.js";
import type { SchemaValidationIssue } from "./schema-validation.js";
import { ALL_TYPES } from "../generated/type-registry.js";

// -----------------------------------------------------------------------------
// A rejection has to teach. "Invalid type schema" tells an author their work
// was refused and nothing more; they then guess, resubmit, and guess again.
// Every issue carries where it happened, what was required, what arrived, and
// what to do — and this file asserts all four are present on every error class
// the validator can raise, not just the ones someone remembered to fill in.
// -----------------------------------------------------------------------------

const registry = new Map(ALL_TYPES.map((s) => [s.id, s]));
const validate = (data: unknown) =>
  validateTypeSchema(data, { resolveSchema: (id) => registry.get(id) });

function errorsFor(data: unknown): SchemaValidationIssue[] {
  const result = validate(data);
  expect(result.success, "expected this schema to be rejected").toBe(false);
  return result.success ? [] : result.errors;
}

/** Every error class the validator raises, with a schema that provokes it. */
const CLASSES: { name: string; input: unknown; atField: string }[] = [
  {
    name: "not an object",
    input: "core.note",
    atField: "_root",
  },
  {
    name: "missing id",
    input: { fields: { title: { type: "string" } } },
    atField: "id",
  },
  {
    name: "unknown field type",
    input: { id: "acme.a", fields: { title: { type: "strong" } } },
    atField: "fields.title.type",
  },
  {
    name: "enum without values",
    input: { id: "acme.b", fields: { stage: { type: "enum" } } },
    atField: "fields.stage.enum_values",
  },
  {
    name: "array without items_type",
    input: { id: "acme.c", fields: { tags: { type: "array" } } },
    atField: "fields.tags.items_type",
  },
  {
    name: "unknown format",
    input: {
      id: "acme.d",
      fields: { code: { type: "string", format: "iso4217" } },
    },
    atField: "fields.code.format",
  },
  {
    name: "annotation format on a non-string field",
    input: {
      id: "acme.e",
      fields: { count: { type: "integer", format: "bcp47" } },
    },
    atField: "fields.count.format",
  },
  {
    name: "maxLength on a non-string field",
    input: {
      id: "acme.f",
      fields: { count: { type: "integer", maxLength: 10 } },
    },
    atField: "fields.count.maxLength",
  },
  {
    name: "maxItems on a non-array field",
    input: { id: "acme.g", fields: { title: { type: "string", maxItems: 3 } } },
    atField: "fields.title.maxItems",
  },
  {
    name: "non-positive cap",
    input: {
      id: "acme.h",
      fields: { title: { type: "string", maxLength: 0 } },
    },
    atField: "fields.title.maxLength",
  },
  {
    name: "non-boolean searchable",
    input: {
      id: "acme.i",
      fields: { title: { type: "string", searchable: "no" } },
    },
    atField: "fields.title.searchable",
  },
  {
    name: "property shadows a first-class Item field",
    input: { id: "acme.j", fields: { occurred_at: { type: "datetime" } } },
    atField: "fields.occurred_at",
  },
  {
    name: "per-type lifecycle declaration",
    input: {
      id: "acme.k",
      fields: { title: { type: "string" } },
      states: ["open", "closed"],
    },
    atField: "states",
  },
  {
    name: "display hint pointing at a missing field",
    input: {
      id: "acme.l",
      fields: { title: { type: "string" } },
      display_hints: { body_field: "body" },
    },
    atField: "display_hints.body_field",
  },
  {
    name: "unknown merge strategy",
    input: {
      id: "acme.m",
      fields: { body: { type: "string" } },
      merge_policy: { fields: { body: "shout_loudest" } },
    },
    atField: "merge_policy.fields.body",
  },
  {
    name: "merge policy naming a missing field",
    input: {
      id: "acme.n",
      fields: { body: { type: "string" } },
      merge_policy: { fields: { notes: "last_writer_wins" } },
    },
    atField: "merge_policy.fields.notes",
  },
  {
    name: "version policy with a non-integer",
    input: {
      id: "acme.o",
      fields: { title: { type: "string" } },
      version_policy: { max_versions: 1.5 },
    },
    atField: "version_policy.max_versions",
  },
  {
    name: "required naming a field that does not exist",
    input: {
      id: "acme.p",
      fields: { title: { type: "string" } },
      required: ["subtitle"],
    },
    atField: "required",
  },
  {
    name: "inheritance reshaping an ancestor field",
    input: {
      id: "acme.q",
      parent: "core.note",
      fields: { body: { type: "integer" } },
    },
    atField: "fields.body.type",
  },
  {
    name: "compatible_with target missing a required field",
    input: {
      id: "acme.r",
      compatible_with: ["core.note"],
      fields: { headline: { type: "string" } },
    },
    atField: "compatible_with.core.note.body",
  },
  {
    name: "compatible_with naming an unregistered target",
    input: {
      id: "acme.s",
      compatible_with: ["nope.nothing"],
      fields: { title: { type: "string" } },
    },
    atField: "compatible_with.nope.nothing",
  },
  {
    name: "thumbnail named for a field search always indexes",
    input: { id: "acme.t", fields: { title: { type: "thumbnail" } } },
    atField: "fields.title",
  },
  {
    name: "a second thumbnail",
    input: {
      id: "acme.u",
      fields: {
        thumbnail: { type: "thumbnail" },
        cover: { type: "string", format: "thumbnail" },
      },
    },
    atField: "fields.cover",
  },
];

describe("every validation error explains itself", () => {
  for (const c of CLASSES) {
    it(`${c.name} — reports field, expected, actual and hint`, () => {
      const errors = errorsFor(c.input);
      const match = errors.find((e) => e.field === c.atField);
      expect(
        match,
        `no error at "${c.atField}"; got ${errors.map((e) => e.field).join(", ")}`,
      ).toBeDefined();
      if (!match) return;

      expect(
        match.expected.length,
        "expected must say what was required",
      ).toBeGreaterThan(0);
      expect(
        match.actual.length,
        "actual must say what arrived",
      ).toBeGreaterThan(0);
      expect(
        match.hint.length,
        "hint must say what to do next",
      ).toBeGreaterThan(0);
      // The hint is an instruction, so it ends a sentence rather than trailing
      // off; this catches a placeholder slipping in.
      expect(match.hint.trim().endsWith(".")).toBe(true);
      // The flat message is the three composed, for surfaces that render one
      // string. Nothing may be lost on the way.
      expect(match.message).toContain(match.expected);
      expect(match.message).toContain(match.actual);
      expect(match.message).toContain(match.hint);
    });
  }

  it("covers every issue raised, not just the one under test", () => {
    for (const c of CLASSES) {
      for (const error of errorsFor(c.input)) {
        expect(
          error.field.length,
          `${c.name}: empty field path`,
        ).toBeGreaterThan(0);
        expect(
          error.expected.length,
          `${c.name}: empty expected`,
        ).toBeGreaterThan(0);
        expect(error.actual.length, `${c.name}: empty actual`).toBeGreaterThan(
          0,
        );
        expect(error.hint.length, `${c.name}: empty hint`).toBeGreaterThan(0);
      }
    }
  });
});

describe("error codes the API maps to dedicated statuses", () => {
  it("flags a shadowed first-class field", () => {
    const errors = errorsFor({
      id: "acme.shadow",
      fields: { source_id: { type: "string" } },
    });
    expect(errors.some((e) => e.code === "property_shadows_field")).toBe(true);
  });

  it("flags an inheritance violation", () => {
    const errors = errorsFor({
      id: "acme.reshape",
      parent: "core.note",
      fields: { body: { type: "integer" } },
    });
    expect(errors.some((e) => e.code === "inheritance_violation")).toBe(true);
  });

  it("flags a compatible_with violation", () => {
    const errors = errorsFor({
      id: "acme.claim",
      compatible_with: ["core.note"],
      fields: { headline: { type: "string" } },
    });
    expect(errors.some((e) => e.code === "compatible_with_violation")).toBe(
      true,
    );
  });
});
