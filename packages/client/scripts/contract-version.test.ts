import { describe, expect, it } from "vitest";
import { contractVersionOf } from "./contract-version.js";

describe("the contract version a document states", () => {
  it("reads digits with no leading zero", () => {
    expect(contractVersionOf("0")).toBe(0);
    expect(contractVersionOf("1")).toBe(1);
    expect(contractVersionOf("12")).toBe(12);
  });

  it("refuses anything else, however close to a number", () => {
    for (const spelling of ["1.0", "01", "00", "", "1 ", "v1", "1.0.0", "-1"]) {
      expect(() => contractVersionOf(spelling), spelling).toThrow(
        /not a contract version/,
      );
    }
  });
});
