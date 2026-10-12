import { describe, expect, it } from "vitest";
import { byteDifference } from "./bytes.js";

describe("byteDifference", () => {
  const size = 8 * 1024 * 1024;

  it("finds nothing between two copies of the same bytes", () => {
    expect(
      byteDifference(Buffer.alloc(size, 42), Buffer.alloc(size, 42)),
    ).toBeNull();
    expect(byteDifference(new Uint8Array(0), Buffer.alloc(0))).toBeNull();
  });

  it("names the lengths and the first offset where one byte differs", () => {
    const changed = Buffer.alloc(size, 42);
    changed[size - 3] = 43;
    expect(byteDifference(changed, Buffer.alloc(size, 42))).toBe(
      `${String(size)} bytes where ${String(size)} were expected, the first difference at offset ${String(size - 3)}`,
    );
  });

  it("names the end of the shorter as the first difference when one is a prefix of the other", () => {
    const whole = Buffer.alloc(size, 42);
    expect(byteDifference(whole.subarray(0, 1000), whole)).toBe(
      `1000 bytes where ${String(size)} were expected, the first difference at offset 1000`,
    );
    expect(byteDifference(whole, whole.subarray(0, 1000))).toBe(
      `${String(size)} bytes where 1000 were expected, the first difference at offset 1000`,
    );
  });
});
