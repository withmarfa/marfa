import { describe, expect, it } from "vitest";
import {
  findInexactIntegers,
  inexactIntegerMessage,
  isKeptInteger,
} from "./exact-integers.js";

describe("isKeptInteger", () => {
  it.each([
    "0",
    "9007199254740991",
    "-9007199254740991",
    "9007199254740992",
    "10000000000000000",
    "1152921504606847000",
    "-1152921504606847000",
    "9223372036854776000",
    "18446744073709552000",
    "100000000000000000000",
    "999999999999999900000",
  ])(
    "keeps %s, which is the digits JavaScript prints for its float",
    (source) => {
      expect(isKeptInteger(source)).toBe(true);
      expect(String(Number(source))).toBe(source);
    },
  );

  it.each([
    "9007199254740993",
    "-9007199254740993",
    "1152921504606846976",
    "-1152921504606846976",
    "9223372036854775808",
    "18446744073709551615",
    "1500000000000000001",
    "9223372036854775807",
    "-9223372036854775808123",
    "999999999999999868928",
    "1000000000000000000000",
    "1000000000000000000001",
    "9".repeat(400),
  ])(
    "refuses %s, which is not the digits JavaScript prints for its float",
    (source) => {
      expect(isKeptInteger(source)).toBe(false);
    },
  );
});

it.each(["0", "-0", "-9007199254740991", "9007199254740992"])(
  "keeps %s, a safe integer, whatever JavaScript prints",
  (source) => {
    expect(isKeptInteger(source)).toBe(true);
  },
);

describe("inexactIntegerMessage", () => {
  it.each([
    [
      "1152921504606846976",
      "Must be a whole number that a 64-bit float keeps digit for digit, not 1152921504606846976, which it keeps as 1152921504606847000. Send it as a string.",
    ],
    [
      "-9007199254740993",
      "Must be a whole number that a 64-bit float keeps digit for digit, not -9007199254740993, which it keeps as -9007199254740992. Send it as a string.",
    ],
    [
      "1000000000000000000000",
      "Must be a whole number that a 64-bit float keeps digit for digit, not 1000000000000000000000, which it keeps as 1e+21. Send it as a string.",
    ],
  ])("names the digits a float keeps for %s", (source, message) => {
    expect(inexactIntegerMessage(source)).toBe(message);
  });

  it("names no digits for a number beyond a float's largest", () => {
    const source = "9".repeat(400);
    expect(inexactIntegerMessage(source)).toBe(
      `Must be a whole number that a 64-bit float keeps digit for digit, not ${source}. Send it as a string.`,
    );
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

  it("finds 2^60 written in full and leaves the digits a float prints", () => {
    expect(
      findInexactIntegers('{"a":1152921504606846976,"b":1152921504606847000}'),
    ).toEqual([{ source: "1152921504606846976", path: ["a"] }]);
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
