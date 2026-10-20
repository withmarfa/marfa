import { describe, expect, it } from "vitest";
import { findInexactIntegers, isKeptInteger } from "./exact-integers.js";

describe("isKeptInteger", () => {
  it.each([
    "0",
    "-0",
    "9007199254740991",
    "-9007199254740991",
    "9007199254740992",
    "1152921504606846976",
    "1152921504606847000",
    "9223372036854775808",
    "9223372036854776000",
    "1000000000000000000000",
    "-1152921504606846976",
  ])("keeps %s, which names one float as it is written", (source) => {
    expect(isKeptInteger(source)).toBe(true);
  });

  it.each([
    "9007199254740993",
    "-9007199254740993",
    "1500000000000000001",
    "9223372036854775807",
    "-9223372036854775808123",
    "1000000000000000000001",
    "9".repeat(400),
  ])("refuses %s, which a float would change", (source) => {
    expect(isKeptInteger(source)).toBe(false);
  });
});

describe("findInexactIntegers", () => {
  it("names where each number sits, outermost first", () => {
    const text = JSON.stringify({
      items: [
        { properties: { ok: 1 } },
        { properties: { id64: 0, list: [1, { deep: 0 }] } },
      ],
    })
      .replace('"id64":0', '"id64":1500000000000000001')
      .replace('"deep":0', '"deep":-9007199254740993');
    expect(findInexactIntegers(text)).toEqual([
      {
        source: "1500000000000000001",
        path: ["items", "1", "properties", "id64"],
      },
      {
        source: "-9007199254740993",
        path: ["items", "1", "properties", "list", "1", "deep"],
      },
    ]);
  });

  it("leaves a number with a fraction or an exponent alone", () => {
    expect(
      findInexactIntegers(
        '{"a":1.5,"b":1e300,"c":1500000000000000001.5,"d":15000000000000000010e0,"e":2E20}',
      ),
    ).toEqual([]);
  });

  it("leaves digits inside a string alone", () => {
    expect(findInexactIntegers('{"a":"1500000000000000001"}')).toEqual([]);
  });

  it("names a member whose key is empty", () => {
    expect(findInexactIntegers('{"":{"":1500000000000000001}}')).toEqual([
      { source: "1500000000000000001", path: ["", ""] },
    ]);
  });

  it("reads a number at the root as the whole text", () => {
    expect(findInexactIntegers("1500000000000000001")).toEqual([
      { source: "1500000000000000001", path: [] },
    ]);
  });

  it("finds nothing in text that is not JSON", () => {
    expect(findInexactIntegers("{1500000000000000001")).toEqual([]);
  });
});
