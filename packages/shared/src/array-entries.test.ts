import { afterEach, describe, expect, it } from "vitest";
import {
  registerTypeSchema,
  unregisterTypeSchema,
  validateProperties,
} from "./type-registry.js";

const TYPE = "test.entries.parent";

afterEach(() => {
  unregisterTypeSchema(TYPE);
});

function register(): void {
  registerTypeSchema({
    id: TYPE,
    version: 1,
    fields: {
      list: {
        type: "array",
        items_type: "object",
        items_fields: {
          v: { type: "string" },
          u: { type: "url" },
        },
      },
    },
  });
}

const fieldsOf = (result: ReturnType<typeof validateProperties>) =>
  result.success ? [] : result.errors.map((error) => error.field);

describe("an entry of a list is stored as the server holds a value", () => {
  it("stores a url member trimmed and without tabs and line breaks (types/url-stored)", () => {
    register();
    const result = validateProperties(TYPE, {
      list: [
        { u: "  https://example.com/b\t " },
        { v: "  kept  ", u: "https://exa\nmple.com/c" },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.list).toEqual([
      { u: "https://example.com/b" },
      { v: "  kept  ", u: "https://example.com/c" },
    ]);
  });

  it("refuses a url member the standard refuses, naming it", () => {
    register();
    expect(
      fieldsOf(validateProperties(TYPE, { list: [{ u: "not a url" }] })),
    ).toEqual(["list.0.u"]);
  });

  it("refuses an undeclared member named __proto__, which JSON.parse makes an own key", () => {
    register();
    const sent = JSON.parse(
      '{"list":[{"v":"a","__proto__":{"x":1}}]}',
    ) as Record<string, unknown>;
    const first = (sent.list as object[])[0];
    expect(first && Object.hasOwn(first, "__proto__")).toBe(true);
    expect(fieldsOf(validateProperties(TYPE, sent))).toEqual([
      "list.0.__proto__",
    ]);
  });

  it("takes the entry once the __proto__ member is gone, so the refusal is not the entry's shape", () => {
    register();
    const sent = JSON.parse('{"list":[{"v":"a"}]}') as Record<string, unknown>;
    expect(validateProperties(TYPE, sent).success).toBe(true);
  });

  it("refuses a lone __proto__ member as an undeclared one, not as an empty entry", () => {
    register();
    const sent = JSON.parse('{"list":[{"__proto__":1}]}') as Record<
      string,
      unknown
    >;
    expect(fieldsOf(validateProperties(TYPE, sent))).toEqual([
      "list.0.__proto__",
    ]);
  });
});
