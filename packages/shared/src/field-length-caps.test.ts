import { afterEach, describe, expect, it } from "vitest";
import {
  registerTypeSchema,
  unregisterTypeSchema,
  validateProperties,
} from "./type-registry.js";
import type { TypeSchema } from "@withmarfa/types";

// Per-field length / element caps are defense-in-depth, independent of the
// server's global request-body size limit. They bound a single field even
// when the overall payload is small. Defaults: 100_000 chars for strings,
// 10_000 elements for arrays; per-field `maxLength` / `maxItems` overrides
// raise or lower them.

const TENANT = "tenant-field-caps-test";

const DEFAULT_STRING_CAP = 100_000;
const DEFAULT_ARRAY_CAP = 10_000;

function register(id: string, fields: TypeSchema["fields"]): void {
  registerTypeSchema({ id, version: 1, fields }, TENANT);
}

afterEach(() => {
  for (const id of [
    "test.caps.default",
    "test.caps.string_override",
    "test.caps.array_override",
  ]) {
    unregisterTypeSchema(id, TENANT);
  }
});

describe("per-field length caps (default)", () => {
  it("accepts a string at the default cap and rejects one over it", () => {
    register("test.caps.default", {
      text: { type: "string" },
      tags: { type: "array" },
    });

    const atCap = validateProperties(
      "test.caps.default",
      { text: "a".repeat(DEFAULT_STRING_CAP) },
      { tenantId: TENANT },
    );
    expect(atCap.success).toBe(true);

    const overCap = validateProperties(
      "test.caps.default",
      { text: "a".repeat(DEFAULT_STRING_CAP + 1) },
      { tenantId: TENANT },
    );
    expect(overCap.success).toBe(false);
  });

  it("rejects an array over the default element cap", () => {
    register("test.caps.default", {
      text: { type: "string" },
      tags: { type: "array" },
    });

    const atCap = validateProperties(
      "test.caps.default",
      { tags: new Array(DEFAULT_ARRAY_CAP).fill("x") },
      { tenantId: TENANT },
    );
    expect(atCap.success).toBe(true);

    const overCap = validateProperties(
      "test.caps.default",
      { tags: new Array(DEFAULT_ARRAY_CAP + 1).fill("x") },
      { tenantId: TENANT },
    );
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
      { tenantId: TENANT },
    );
    expect(overDefaultUnderOverride.success).toBe(true);

    const overOverride = validateProperties(
      "test.caps.string_override",
      { text: "a".repeat(250_001) },
      { tenantId: TENANT },
    );
    expect(overOverride.success).toBe(false);
  });

  it("honors a higher maxItems override on an array field", () => {
    register("test.caps.array_override", {
      tags: { type: "array", maxItems: 25_000 },
    });

    const overDefaultUnderOverride = validateProperties(
      "test.caps.array_override",
      { tags: new Array(DEFAULT_ARRAY_CAP + 5_000).fill("x") },
      { tenantId: TENANT },
    );
    expect(overDefaultUnderOverride.success).toBe(true);

    const overOverride = validateProperties(
      "test.caps.array_override",
      { tags: new Array(25_001).fill("x") },
      { tenantId: TENANT },
    );
    expect(overOverride.success).toBe(false);
  });
});
