import { describe, expect, it } from "vitest";
import { generateId, isValidId } from "./ids.js";

describe("generateId", () => {
  it("produces a valid UUIDv7 string", () => {
    const id = generateId();
    expect(isValidId(id)).toBe(true);
  });

  it("produces unique values on successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it("produces time-sortable IDs (later IDs sort after earlier ones)", () => {
    const first = generateId();
    const second = generateId();
    expect(first < second).toBe(true);
  });
});

describe("isValidId", () => {
  it("accepts valid UUIDv7 strings", () => {
    expect(isValidId("019537a0-7b80-7000-8000-000000000000")).toBe(true);
  });

  it("accepts generated IDs", () => {
    const id = generateId();
    expect(isValidId(id)).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidId("")).toBe(false);
  });

  it("rejects UUIDv4 strings (version nibble is 4, not 7)", () => {
    expect(isValidId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("rejects strings that are too short", () => {
    expect(isValidId("019537a0-7b80-7000")).toBe(false);
  });

  it("rejects strings without hyphens", () => {
    expect(isValidId("019537a07b8070008000000000000000")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidId("019537a0-7b80-7000-8000-00000000zzzz")).toBe(false);
  });
});
