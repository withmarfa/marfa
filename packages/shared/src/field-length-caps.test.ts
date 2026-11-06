import { afterEach, describe, expect, it } from "vitest";
import {
  registerTypeSchema,
  unregisterTypeSchema,
  validateProperties,
} from "./type-registry.js";
import type { TypeSchema } from "@withmarfa/types";

// Per-field length / element caps are defense-in-depth, independent of the
// server's global request-body size limit. They bound a single field even
// when the overall payload is small. Defaults: 1_000_000 UTF-16 code units for
// the field a type names as its body, 100_000 for any other string, 10_000
// elements for arrays; per-field `maxLength` / `maxItems` overrides raise or
// lower them.

const DEFAULT_STRING_CAP = 100_000;
const DEFAULT_BODY_CAP = 1_000_000;
const DEFAULT_ARRAY_CAP = 10_000;
// Two UTF-16 code units, and one Unicode code point.
const ASTRAL = "\u{1F600}";

function register(id: string, fields: TypeSchema["fields"]): void {
  registerTypeSchema({ id, version: 1, fields });
}

afterEach(() => {
  for (const id of [
    "test.caps.default",
    "test.caps.string_override",
    "test.caps.array_override",
    "test.caps.child_renames",
    "test.caps.child_inherits",
    "test.caps.body",
  ]) {
    unregisterTypeSchema(id);
  }
});

describe("per-field length caps (default)", () => {
  it("accepts a string at the default cap and rejects one over it", () => {
    register("test.caps.default", {
      text: { type: "string" },
      tags: { type: "array" },
    });

    const atCap = validateProperties("test.caps.default", {
      text: "a".repeat(DEFAULT_STRING_CAP),
    });
    expect(atCap.success).toBe(true);

    const overCap = validateProperties("test.caps.default", {
      text: "a".repeat(DEFAULT_STRING_CAP + 1),
    });
    expect(overCap.success).toBe(false);
  });

  it("rejects an array over the default element cap", () => {
    register("test.caps.default", {
      text: { type: "string" },
      tags: { type: "array" },
    });

    const atCap = validateProperties("test.caps.default", {
      tags: new Array(DEFAULT_ARRAY_CAP).fill("x"),
    });
    expect(atCap.success).toBe(true);

    const overCap = validateProperties("test.caps.default", {
      tags: new Array(DEFAULT_ARRAY_CAP + 1).fill("x"),
    });
    expect(overCap.success).toBe(false);
  });
});

describe("per-field length caps (overrides)", () => {
  it("honors a higher maxLength override on a string field", () => {
    register("test.caps.string_override", {
      // Raise the cap well past the 100k default.
      text: { type: "string", maxLength: 250_000 },
    });

    const overDefaultUnderOverride = validateProperties(
      "test.caps.string_override",
      { text: "a".repeat(DEFAULT_STRING_CAP + 50_000) },
    );
    expect(overDefaultUnderOverride.success).toBe(true);

    const overOverride = validateProperties("test.caps.string_override", {
      text: "a".repeat(250_001),
    });
    expect(overOverride.success).toBe(false);
  });

  it("honors a higher maxItems override on an array field", () => {
    register("test.caps.array_override", {
      tags: { type: "array", maxItems: 25_000 },
    });

    const overDefaultUnderOverride = validateProperties(
      "test.caps.array_override",
      { tags: new Array(DEFAULT_ARRAY_CAP + 5_000).fill("x") },
    );
    expect(overDefaultUnderOverride.success).toBe(true);

    const overOverride = validateProperties("test.caps.array_override", {
      tags: new Array(25_001).fill("x"),
    });
    expect(overOverride.success).toBe(false);
  });
});

describe("per-field length caps (the field a type names as its body)", () => {
  const verdict = (type: string, field: string, value: string) => {
    const judged = validateProperties(type, { [field]: value });
    return judged.success
      ? "accepted"
      : [...new Set(judged.errors.map((e) => e.field))];
  };

  function registerBody(
    fields: TypeSchema["fields"],
    bodyField?: string,
  ): void {
    registerTypeSchema({
      id: "test.caps.body",
      version: 1,
      fields,
      ...(bodyField === undefined
        ? {}
        : { display_hints: { body_field: bodyField } }),
    });
  }

  it("holds a named body to 1,000,000 units and another text field to 100,000, naming the field", () => {
    registerBody({ body: { type: "string" }, other: { type: "string" } }, "body");

    expect(
      verdict("test.caps.body", "body", "a".repeat(DEFAULT_BODY_CAP)),
    ).toBe("accepted");
    expect(
      verdict("test.caps.body", "body", "a".repeat(DEFAULT_BODY_CAP + 1)),
    ).toEqual(["body"]);
    expect(
      verdict("test.caps.body", "other", "a".repeat(DEFAULT_STRING_CAP)),
    ).toBe("accepted");
    expect(
      verdict("test.caps.body", "other", "a".repeat(DEFAULT_STRING_CAP + 1)),
    ).toEqual(["other"]);
  });

  it("counts a character outside the Basic Multilingual Plane as two units against both caps", () => {
    registerBody({ body: { type: "string" }, other: { type: "string" } }, "body");

    expect(
      verdict(
        "test.caps.body",
        "body",
        "a".repeat(DEFAULT_BODY_CAP - 2) + ASTRAL,
      ),
    ).toBe("accepted");
    expect(
      verdict(
        "test.caps.body",
        "body",
        "a".repeat(DEFAULT_BODY_CAP - 1) + ASTRAL,
      ),
    ).toEqual(["body"]);
    expect(
      verdict(
        "test.caps.body",
        "other",
        "a".repeat(DEFAULT_STRING_CAP - 2) + ASTRAL,
      ),
    ).toBe("accepted");
    expect(
      verdict(
        "test.caps.body",
        "other",
        "a".repeat(DEFAULT_STRING_CAP - 1) + ASTRAL,
      ),
    ).toEqual(["other"]);
  });

  it("follows a body named by a parent, and a child that names another", () => {
    registerBody(
      { description: { type: "string" }, body: { type: "string" } },
      "description",
    );
    registerTypeSchema({
      id: "test.caps.child_inherits",
      version: 1,
      parent: "test.caps.body",
      fields: {},
    });
    registerTypeSchema({
      id: "test.caps.child_renames",
      version: 1,
      parent: "test.caps.body",
      fields: {},
      display_hints: { body_field: "body" },
    });
    const long = "a".repeat(DEFAULT_STRING_CAP + 1);

    expect(verdict("test.caps.body", "description", long)).toBe("accepted");
    expect(verdict("test.caps.body", "body", long)).toEqual(["body"]);
    expect(verdict("test.caps.child_inherits", "description", long)).toBe(
      "accepted",
    );
    expect(verdict("test.caps.child_inherits", "body", long)).toEqual(["body"]);
    expect(verdict("test.caps.child_renames", "description", long)).toEqual([
      "description",
    ]);
    expect(verdict("test.caps.child_renames", "body", long)).toBe("accepted");
  });

  it("follows a parent whose hint changes, for a child judged before the change", () => {
    registerBody({ text: { type: "string" } }, "text");
    registerTypeSchema({
      id: "test.caps.child_inherits",
      version: 1,
      parent: "test.caps.body",
      fields: {},
    });
    const long = "a".repeat(DEFAULT_STRING_CAP + 1);
    expect(verdict("test.caps.child_inherits", "text", long)).toBe("accepted");

    registerBody({ text: { type: "string" } });

    expect(verdict("test.caps.child_inherits", "text", long)).toEqual(["text"]);
  });

  it("holds a field called body to 100,000 where the type names no body", () => {
    registerBody({ body: { type: "string" } });

    expect(
      verdict("test.caps.body", "body", "a".repeat(DEFAULT_STRING_CAP)),
    ).toBe("accepted");
    expect(
      verdict("test.caps.body", "body", "a".repeat(DEFAULT_STRING_CAP + 1)),
    ).toEqual(["body"]);
  });

  it("lets a body field's own maxLength win, lower or higher", () => {
    registerBody({ body: { type: "string", maxLength: 50 } }, "body");
    expect(verdict("test.caps.body", "body", "a".repeat(50))).toBe("accepted");
    expect(verdict("test.caps.body", "body", "a".repeat(51))).toEqual(["body"]);

    registerBody({ body: { type: "string", maxLength: 2_000_000 } }, "body");
    expect(
      verdict("test.caps.body", "body", "a".repeat(DEFAULT_BODY_CAP + 1)),
    ).toBe("accepted");
    expect(verdict("test.caps.body", "body", "a".repeat(2_000_001))).toEqual([
      "body",
    ]);
  });
});
