import { describe, expect, it } from "vitest";
import type { TypeSchema } from "@withmarfa/shared";
import { evolutionOf } from "./_type-evolution.js";

const stored: TypeSchema = {
  id: "acme.issue",
  version: 1,
  parent: "core.task",
  label: "Issue",
  fields: {
    issue_id: { type: "string", description: "Vendor id." },
    rank: { type: "integer" },
  },
  link_field: "issue_id",
  roles: ["container"],
  display_hints: { title_field: "issue_id" },
};

function next(change: Partial<TypeSchema>): TypeSchema {
  return { ...structuredClone(stored), ...change };
}

describe("evolutionOf", () => {
  it("names nothing for a resubmission", () => {
    expect(evolutionOf(stored, next({}))).toEqual({
      needsSchemaWrite: [],
      additions: [],
    });
  });

  it("frees presentation, and lists an optional field added", () => {
    expect(
      evolutionOf(
        stored,
        next({
          label: "Other",
          description: "Words.",
          version: 7,
          display_hints: { body_field: "rank" },
          fields: {
            issue_id: { type: "string", description: "Reworded." },
            rank: { type: "integer" },
            added: { type: "string" },
          },
        }),
      ),
    ).toEqual({ needsSchemaWrite: [], additions: ["added"] });
  });

  it("holds back a required field, a removed field and a kept field whose shape changed", () => {
    const changed = evolutionOf(
      stored,
      next({
        fields: {
          issue_id: { type: "string", searchable: false },
          required_new: { type: "string", required: true },
        },
      }),
    );
    expect([...changed.needsSchemaWrite].sort()).toEqual([
      "fields.issue_id",
      "fields.rank",
      "fields.required_new",
    ]);
    expect(changed.additions).toEqual([]);
  });

  it("treats a field named like an object's built-in member as a field of its own", () => {
    const fields = Object.fromEntries([
      ...Object.entries(structuredClone(stored.fields)),
      ["toString", { type: "string" }],
    ]) as TypeSchema["fields"];
    expect(evolutionOf(next({ fields }), next({ fields }))).toEqual({
      needsSchemaWrite: [],
      additions: [],
    });
    expect(evolutionOf(stored, next({ fields })).additions).toEqual([
      "toString",
    ]);
  });

  it("names a member held back by default, even one the validator learns later", () => {
    const later = {
      ...structuredClone(stored),
      retention: { days: 1 },
    } as unknown as TypeSchema;
    expect(evolutionOf(stored, later).needsSchemaWrite).toEqual(["retention"]);
    expect(evolutionOf(later, stored).needsSchemaWrite).toEqual(["retention"]);
  });

  it("names a member that was withdrawn as well as one that changed", () => {
    const withoutParent = next({});
    delete withoutParent.parent;
    expect(evolutionOf(stored, withoutParent).needsSchemaWrite).toEqual([
      "parent",
    ]);
    expect(
      evolutionOf(stored, next({ roles: undefined })).needsSchemaWrite,
    ).toEqual(["roles"]);
  });

  it("treats an absent member and one set to undefined as the same", () => {
    expect(
      evolutionOf(
        stored,
        next({ version_policy: undefined, merge_policy: undefined }),
      ).needsSchemaWrite,
    ).toEqual([]);
  });
});
