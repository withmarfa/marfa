import { describe, expect, it } from "vitest";
import { z } from "zod";
import { maxStringLength, minStringLength } from "./string-length.js";

describe("maxStringLength", () => {
  it("counts supplementary characters as two UTF-16 units", () => {
    const schema = maxStringLength(z.string(), 5);
    expect(schema.safeParse("😀abc").success).toBe(true);
    expect(schema.safeParse("😀abcd").success).toBe(false);
    expect(schema.safeParse("abcde").success).toBe(true);
    expect(schema.safeParse("abcdef").success).toBe(false);
  });

  it("measures after the schema's trim and retains its lower bound", () => {
    const schema = maxStringLength(z.string().trim().min(1), 5);
    expect(schema.parse("  😀abc  ")).toBe("😀abc");
    expect(schema.safeParse("  😀abcd  ").success).toBe(false);
    expect(schema.safeParse("   ").success).toBe(false);
  });

  it("retains the published maximum in the JSON schema", () => {
    expect(z.toJSONSchema(maxStringLength(z.string(), 5)).maxLength).toBe(5);
  });
});

describe("minStringLength", () => {
  it("preserves supplementary-character acceptance and rejects shorter secrets", () => {
    const schema = minStringLength(z.string(), 32, "secret too short");
    expect(schema.safeParse("😀".repeat(16)).success).toBe(true);
    expect(schema.safeParse("😀".repeat(15) + "a").success).toBe(false);
    expect(schema.safeParse("a".repeat(32)).success).toBe(true);
    expect(schema.safeParse("a".repeat(31)).success).toBe(false);
    expect(schema.safeParse(32).success).toBe(false);
    expect(z.toJSONSchema(schema).minLength).toBe(32);
  });
});
