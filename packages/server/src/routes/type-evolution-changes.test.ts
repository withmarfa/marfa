import { describe, expect, it } from "vitest";
import type { TypeSchema } from "@withmarfa/shared";
import { changesNeedingSchemaWrite } from "./_type-evolution.js";

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

describe("changesNeedingSchemaWrite", () => {
  it("names nothing for a resubmission", () => {
    expect(changesNeedingSchemaWrite(stored, next({}))).toEqual([]);
  });

  it("names nothing for fields added or removed, and for presentation", () => {
    expect(
      changesNeedingSchemaWrite(
        stored,
        next({
          label: "Other",
          description: "Words.",
          version: 7,
          display_hints: { body_field: "rank" },
          fields: {
            issue_id: { type: "string", description: "Reworded." },
            added: { type: "string", required: true },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("names a kept field whose shape changed, apart from its description", () => {
    expect(
      changesNeedingSchemaWrite(
        stored,
        next({
          fields: {
            issue_id: { type: "string" },
            rank: { type: "integer", maxLength: 3 },
          },
        }),
      ),
    ).toEqual(["fields.rank"]);
  });

  it("names a member held back by default, even one the validator learns later", () => {
    const later = {
      ...structuredClone(stored),
      retention: { days: 1 },
    } as unknown as TypeSchema;
    expect(changesNeedingSchemaWrite(stored, later)).toEqual(["retention"]);
    expect(changesNeedingSchemaWrite(later, stored)).toEqual(["retention"]);
  });

  it("names a member that was withdrawn as well as one that changed", () => {
    const withoutParent = next({});
    delete withoutParent.parent;
    expect(changesNeedingSchemaWrite(stored, withoutParent)).toEqual([
      "parent",
    ]);
    expect(
      changesNeedingSchemaWrite(stored, next({ roles: undefined })),
    ).toEqual(["roles"]);
  });

  it("treats an absent member and one set to undefined as the same", () => {
    expect(
      changesNeedingSchemaWrite(
        stored,
        next({ version_policy: undefined, merge_policy: undefined }),
      ),
    ).toEqual([]);
  });
});
