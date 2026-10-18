import { afterEach, describe, expect, it } from "vitest";
import {
  registerTypeSchema,
  unregisterTypeSchema,
  validateDeclaredProperties,
  validateProperties,
} from "./type-registry.js";
import type { FieldDefinition } from "@withmarfa/types";

const TYPE = "test.items.parent";
const CHILD = "test.items.child";

afterEach(() => {
  unregisterTypeSchema(CHILD);
  unregisterTypeSchema(TYPE);
});

function register(fields: Record<string, FieldDefinition>): void {
  registerTypeSchema({ id: TYPE, version: 1, fields });
}

function judge(properties: Record<string, unknown>) {
  return validateProperties(TYPE, properties);
}

describe("an array field holds its elements to items_type", () => {
  it("takes elements of the declared type and refuses the others, naming the element", () => {
    register({
      names: { type: "array", items_type: "string" },
      links: { type: "array", items_type: "url" },
      mails: { type: "array", items_type: "email" },
      times: { type: "array", items_type: "datetime" },
      days: { type: "array", items_type: "date" },
      scores: { type: "array", items_type: "number" },
      counts: { type: "array", items_type: "integer" },
      flags: { type: "array", items_type: "boolean" },
      things: { type: "array", items_type: "object" },
      grid: { type: "array", items_type: "array" },
      sizes: {
        type: "array",
        items_type: "enum",
        enum_values: ["s", "m"],
      },
    });
    const good = {
      names: ["a", ""],
      links: ["https://example.test/a"],
      mails: ["a@example.test"],
      times: ["2026-01-01T00:00:00Z", "2026-01-01"],
      days: ["2026-02-28"],
      scores: [1.5, -2],
      counts: [3],
      flags: [true, false],
      things: [{}, { a: 1 }],
      grid: [[], [1, "x"]],
      sizes: ["s", "m"],
    };
    expect(judge(good).success).toBe(true);

    const bad: [string, unknown[]][] = [
      ["names", ["a", 42]],
      ["names", [{ x: 1 }]],
      ["names", [null]],
      ["names", [["a"]]],
      ["names", ["a\u0000b"]],
      ["links", ["https://example.test", "not a url"]],
      ["mails", ["nobody"]],
      ["times", ["2026-01-01T00:00:00"]],
      ["days", ["2026-02-30"]],
      ["scores", ["1"]],
      ["counts", [1.5]],
      ["flags", ["true"]],
      ["things", ["text"]],
      ["things", [[]]],
      ["things", [null]],
      ["grid", [{}]],
      ["sizes", ["xl"]],
    ];
    for (const [field, value] of bad) {
      const result = judge({ ...good, [field]: value });
      expect(result.success, `${field} ${JSON.stringify(value)}`).toBe(false);
      if (!result.success) {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.field).toMatch(
          new RegExp(`^${field}\\.\\d+$`),
        );
      }
    }
  });

  it("takes an empty array, an absent field and null on an optional one", () => {
    register({ names: { type: "array", items_type: "string" } });
    expect(judge({ names: [] }).success).toBe(true);
    expect(judge({}).success).toBe(true);
    const nulled = judge({ names: null });
    expect(nulled.success).toBe(true);
    if (nulled.success) expect(nulled.data.names).toBeUndefined();
  });

  it("refuses null on a required array, and a non-array", () => {
    register({
      names: { type: "array", items_type: "string", required: true },
    });
    expect(judge({ names: null }).success).toBe(false);
    expect(judge({ names: "a" }).success).toBe(false);
    expect(judge({ names: {} }).success).toBe(false);
  });

  it("still holds the array to maxItems, and counts it before its elements", () => {
    register({ names: { type: "array", items_type: "string", maxItems: 2 } });
    expect(judge({ names: ["a", "b"] }).success).toBe(true);
    expect(judge({ names: ["a", "b", "c"] }).success).toBe(false);
    expect(judge({ names: ["a", 1, "c"] }).success).toBe(false);
  });

  it("checks the universal attachments and links on a type that declares neither", () => {
    register({});
    expect(judge({ links: ["a"], attachments: [{ id: "x" }] }).success).toBe(
      true,
    );
    expect(judge({ links: [1] }).success).toBe(false);
    expect(judge({ attachments: ["x"] }).success).toBe(false);
    expect(judge({ attachments: [{}, 1] }).success).toBe(false);
  });

  it("checks a subtype's inherited array field", () => {
    register({ names: { type: "array", items_type: "string" } });
    registerTypeSchema({
      id: CHILD,
      version: 1,
      parent: TYPE,
      fields: {},
    });
    expect(validateProperties(CHILD, { names: ["a"] }).success).toBe(true);
    expect(validateProperties(CHILD, { names: [1] }).success).toBe(false);
  });

  it("leaves elements unchecked where items_type names no field type", () => {
    register({
      odd: { type: "array", items_type: "somethingelse" },
      bare: { type: "array" },
    });
    expect(judge({ odd: [1, {}, null], bare: [1, "x"] }).success).toBe(true);
  });

  it("checks an edge type's array property the same way", () => {
    const declared: Record<string, FieldDefinition> = {
      roles: { type: "array", items_type: "string" },
    };
    expect(validateDeclaredProperties(declared, { roles: ["a"] }).success).toBe(
      true,
    );
    expect(validateDeclaredProperties(declared, { roles: [1] }).success).toBe(
      false,
    );
  });
});
