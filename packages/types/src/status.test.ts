import { describe, expect, it } from "vitest";
import { validateTypeSchema } from "./schema-validation.js";
import type {
  SchemaValidationContext,
  SchemaValidationIssue,
} from "./schema-validation.js";
import type { TypeSchema } from "./schema-types.js";
import { mergeFieldChain, statusGroupOf } from "./status.js";
import { ALL_TYPES } from "../generated/type-registry.js";

/** A fixture's definition, as the registry would hold it. */
const schema = (data: unknown): TypeSchema => data as TypeSchema;

const WORDS = [
  { value: "todo", group: "not_started" },
  { value: "doing", group: "in_progress" },
  { value: "done", group: "completed" },
  { value: "dropped", group: "canceled" },
];

function registryWith(...types: TypeSchema[]): SchemaValidationContext {
  const byId = new Map<string, TypeSchema>(ALL_TYPES.map((s) => [s.id, s]));
  for (const type of types) byId.set(type.id, type);
  return {
    resolveSchema: (id) => byId.get(id),
    descendantsOf: (id) =>
      [...byId.values()].filter((type) => {
        const seen = new Set<string>();
        let parent = type.parent;
        while (parent !== undefined && !seen.has(parent)) {
          if (parent === id) return true;
          seen.add(parent);
          parent = byId.get(parent)?.parent;
        }
        return false;
      }),
  };
}

function accept(data: unknown, ctx = registryWith()): TypeSchema {
  const result = validateTypeSchema(data, ctx);
  expect(result.success ? [] : result.errors).toEqual([]);
  if (!result.success) throw new Error("rejected");
  return result.data;
}

function refuse(data: unknown, ctx = registryWith()): SchemaValidationIssue[] {
  const result = validateTypeSchema(data, ctx);
  expect(result.success, "expected this schema to be refused").toBe(false);
  return result.success ? [] : result.errors;
}

const workItem = schema({
  id: "acme.work",
  fields: {
    title: { type: "string" },
    stage: { type: "status", status_values: WORDS },
  },
});

describe("a status field's definition", () => {
  it("accepts words in the four groups and keeps their order", () => {
    const type = accept(workItem);
    expect(type.fields.stage).toEqual({ type: "status", status_values: WORDS });
  });

  it.each([
    ["no words", {}, "fields.stage.status_values"],
    ["an empty list", { status_values: [] }, "fields.stage.status_values"],
    [
      "a group outside the four",
      { status_values: [{ value: "todo", group: "waiting" }] },
      "fields.stage.status_values.0.group",
    ],
    [
      "a word outside the grammar",
      { status_values: [{ value: "In Review", group: "in_progress" }] },
      "fields.stage.status_values.0.value",
    ],
    [
      "a repeated word",
      {
        status_values: [
          { value: "todo", group: "not_started" },
          { value: "todo", group: "in_progress" },
        ],
      },
      "fields.stage.status_values.1.value",
    ],
    [
      "an entry with another key",
      {
        status_values: [
          { value: "todo", group: "not_started", label: "To do" },
        ],
      },
      "fields.stage.status_values.0",
    ],
    [
      "enum_values in place of words",
      { status_values: WORDS, enum_values: ["todo"] },
      "fields.stage.enum_values",
    ],
  ])("refuses %s, naming the member", (_, extra, path) => {
    const errors = refuse({
      id: "acme.bad",
      fields: { stage: { type: "status", ...extra } },
    });
    expect(errors.map((e) => e.field)).toContain(path);
  });

  it("refuses status_values on a field of another kind", () => {
    const errors = refuse({
      id: "acme.bad",
      fields: { stage: { type: "string", status_values: WORDS } },
    });
    expect(errors.map((e) => e.field)).toContain("fields.stage.status_values");
  });

  it("refuses an array of status words", () => {
    const errors = refuse({
      id: "acme.bad",
      fields: { stages: { type: "array", items_type: "status" } },
    });
    expect(errors.map((e) => e.field)).toContain("fields.stages.items_type");
  });

  it("refuses a second status field in one type", () => {
    const errors = refuse({
      id: "acme.bad",
      fields: {
        stage: { type: "status", status_values: WORDS },
        phase: { type: "status", status_values: WORDS },
      },
    });
    expect(errors.map((e) => e.field)).toContain("fields.phase.type");
  });
});

describe("a status field down a chain", () => {
  const ctx = registryWith(workItem);

  it("joins a subtype's new words after the inherited ones", () => {
    const bug = accept(
      {
        id: "acme.bug",
        parent: "acme.work",
        fields: {
          stage: {
            type: "status",
            status_values: [{ value: "blocked", group: "in_progress" }],
          },
        },
      },
      ctx,
    );
    const resolved = mergeFieldChain([workItem.fields, bug.fields]);
    expect(resolved.stage?.status_values?.map((e) => e.value)).toEqual([
      "todo",
      "doing",
      "done",
      "dropped",
      "blocked",
    ]);
    expect(statusGroupOf(resolved.stage!, "blocked")).toBe("in_progress");
    expect(statusGroupOf(resolved.stage!, "done")).toBe("completed");
  });

  it("lets a subtype redeclare the field without words to require it", () => {
    accept(
      {
        id: "acme.bug",
        parent: "acme.work",
        fields: { stage: { type: "status", required: true } },
      },
      ctx,
    );
  });

  it("refuses an inherited word declared again, in any group", () => {
    const errors = refuse(
      {
        id: "acme.bug",
        parent: "acme.work",
        fields: {
          stage: {
            type: "status",
            status_values: [{ value: "done", group: "canceled" }],
          },
        },
      },
      ctx,
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: "fields.stage.status_values",
        code: "inheritance_violation",
      }),
    );
  });

  it("refuses a second status field under another name", () => {
    const errors = refuse(
      {
        id: "acme.bug",
        parent: "acme.work",
        fields: { phase: { type: "status", status_values: WORDS } },
      },
      ctx,
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: "fields.phase",
        code: "inheritance_violation",
      }),
    );
  });

  it("refuses the inherited status field redeclared as another kind", () => {
    const errors = refuse(
      {
        id: "acme.bug",
        parent: "acme.work",
        fields: { stage: { type: "string" } },
      },
      ctx,
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ code: "inheritance_violation" }),
    );
  });

  it("refuses a parent change that adds a word a subtype declares", () => {
    const bug = schema({
      id: "acme.bug",
      parent: "acme.work",
      fields: {
        stage: {
          type: "status",
          status_values: [{ value: "blocked", group: "in_progress" }],
        },
      },
    });
    const errors = refuse(
      {
        ...workItem,
        fields: {
          ...workItem.fields,
          stage: {
            type: "status",
            status_values: [...WORDS, { value: "blocked", group: "canceled" }],
          },
        },
      },
      registryWith(workItem, bug),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: "fields.stage.status_values",
        code: "inheritance_violation",
      }),
    );
  });

  it("refuses a parent change that leaves a subtype's status field without words", () => {
    const bug = schema({
      id: "acme.bug",
      parent: "acme.work",
      required: ["stage"],
      fields: { stage: { type: "status", required: true } },
    });
    const small = schema({
      id: "acme.bug.small",
      parent: "acme.bug",
      fields: {},
    });
    const ctx = registryWith(workItem, bug, small);
    for (const stage of [undefined, { type: "string" }]) {
      const fields: Record<string, unknown> = { title: { type: "string" } };
      if (stage) fields.stage = stage;
      const errors = refuse({ ...workItem, fields }, ctx);
      expect(errors, JSON.stringify(stage)).toContainEqual(
        expect.objectContaining({
          field: "fields.stage",
          code: "inheritance_violation",
        }),
      );
      expect(
        errors.filter((e) => e.field === "fields.stage").length,
        "one refusal for the subtype that declares the field",
      ).toBe(1);
    }

    // The witnesses: the parent keeps its words, or the subtype holds its own.
    accept(
      {
        ...workItem,
        fields: {
          ...workItem.fields,
          stage: {
            type: "status",
            status_values: WORDS,
            description: "Where it stands",
          },
        },
      },
      ctx,
    );
    const worded = schema({
      id: "acme.bug",
      parent: "acme.work",
      fields: { stage: { type: "status", status_values: WORDS } },
    });
    accept(
      { ...workItem, fields: { title: { type: "string" } } },
      registryWith(workItem, worded, small),
    );
  });

  it("refuses a parent status field beside a subtype's own under another name", () => {
    const plain = schema({
      id: "acme.plain",
      fields: { title: { type: "string" } },
    });
    const child = schema({
      id: "acme.plain.child",
      parent: "acme.plain",
      fields: { phase: { type: "status", status_values: WORDS } },
    });
    const errors = refuse(
      {
        ...plain,
        fields: {
          ...plain.fields,
          stage: { type: "status", status_values: WORDS },
        },
      },
      registryWith(plain, child),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        field: "fields.stage",
        code: "inheritance_violation",
      }),
    );
  });
});

describe("compatible_with and a status field", () => {
  it("reads a status field as a string", () => {
    const target = schema({
      id: "acme.text",
      fields: { stage: { type: "string" } },
    });
    accept(
      { ...workItem, id: "acme.work2", compatible_with: ["acme.text"] },
      registryWith(target),
    );
  });

  it("reads a status field as a target status field with the same groups", () => {
    const target = schema({
      id: "acme.wide",
      fields: {
        stage: {
          type: "status",
          status_values: [...WORDS, { value: "blocked", group: "in_progress" }],
        },
      },
    });
    accept(
      { ...workItem, id: "acme.work2", compatible_with: ["acme.wide"] },
      registryWith(target),
    );
  });

  it.each([
    ["a word the target lacks", [WORDS[0], WORDS[1], WORDS[2]]],
    [
      "a word the target puts in another group",
      [...WORDS.slice(0, 3), { value: "dropped", group: "completed" }],
    ],
  ])("refuses a status target with %s", (_, targetWords) => {
    const target = schema({
      id: "acme.narrow",
      fields: { stage: { type: "status", status_values: targetWords } },
    });
    const errors = refuse(
      { ...workItem, id: "acme.work2", compatible_with: ["acme.narrow"] },
      registryWith(target),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ code: "compatible_with_violation" }),
    );
  });

  it("refuses a status target for a string field", () => {
    const target = schema({
      id: "acme.wide",
      fields: { stage: { type: "status", status_values: WORDS } },
    });
    const errors = refuse(
      {
        id: "acme.loose",
        fields: { stage: { type: "string" } },
        compatible_with: ["acme.wide"],
      },
      registryWith(target),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ code: "compatible_with_violation" }),
    );
  });
});

describe("core.task", () => {
  it("declares its status in the four groups, without pending", () => {
    const task = ALL_TYPES.find((type) => type.id === "core.task");
    expect(task?.fields.status).toEqual({
      type: "status",
      description: "Where the task stands",
      status_values: [
        { value: "not_started", group: "not_started" },
        { value: "in_progress", group: "in_progress" },
        { value: "completed", group: "completed" },
        { value: "canceled", group: "canceled" },
      ],
    });
  });
});
