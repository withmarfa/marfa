import { describe, expect, it } from "vitest";
import {
  findLoneSurrogate,
  isWellFormedText,
  toWellFormedText,
  truncateText,
} from "./well-formed.js";

const HIGH = "\ud83d";
const LOW = "\ude00";

describe("isWellFormedText", () => {
  it("accepts a surrogate pair, plain text and the empty string", () => {
    expect(isWellFormedText("😀")).toBe(true);
    expect(isWellFormedText(`a${HIGH}${LOW}b`)).toBe(true);
    expect(isWellFormedText("plain")).toBe(true);
    expect(isWellFormedText("")).toBe(true);
  });

  it("refuses a lone high, a lone low and a reversed pair", () => {
    expect(isWellFormedText(HIGH)).toBe(false);
    expect(isWellFormedText(`a${HIGH}b`)).toBe(false);
    expect(isWellFormedText(LOW)).toBe(false);
    expect(isWellFormedText(`${LOW}${HIGH}`)).toBe(false);
    expect(isWellFormedText(`${HIGH}${HIGH}${LOW}`)).toBe(false);
    expect(isWellFormedText(`${HIGH}${LOW}${LOW}`)).toBe(false);
  });
});

describe("toWellFormedText", () => {
  it("replaces each lone surrogate with U+FFFD and keeps pairs", () => {
    expect(toWellFormedText(`a${HIGH}b${LOW}😀`)).toBe("a\ufffdb\ufffd😀");
    expect(toWellFormedText("😀")).toBe("😀");
  });
});

describe("truncateText", () => {
  it("cuts plain text at the cap and leaves shorter text alone", () => {
    expect(truncateText("abcdef", 3)).toBe("abc");
    expect(truncateText("abc", 3)).toBe("abc");
    expect(truncateText("abc", 10)).toBe("abc");
    expect(truncateText("abc", 0)).toBe("");
  });

  it("keeps a pair that fits and gives up one unit rather than split it", () => {
    expect(truncateText("ab😀cd", 4)).toBe("ab😀");
    expect(truncateText("ab😀cd", 3)).toBe("ab");
    expect(truncateText("😀", 1)).toBe("");
    expect(truncateText("😀", 2)).toBe("😀");
  });

  it("does not repair a surrogate that was already alone", () => {
    expect(truncateText(`ab${HIGH}cd`, 3)).toBe(`ab${HIGH}`);
  });
});

describe("findLoneSurrogate", () => {
  it("returns null for a value with only well-formed text", () => {
    expect(findLoneSurrogate({ a: ["x", { b: "😀" }], c: 1, d: null })).toBe(
      null,
    );
    expect(findLoneSurrogate("plain")).toBe(null);
    expect(findLoneSurrogate(7)).toBe(null);
    expect(findLoneSurrogate(null)).toBe(null);
  });

  it("points at a lone high surrogate", () => {
    expect(findLoneSurrogate({ body: `x${HIGH}` })).toBe("/body");
  });

  it("points at a lone low surrogate", () => {
    expect(findLoneSurrogate({ body: LOW })).toBe("/body");
  });

  it("points at a reversed pair", () => {
    expect(findLoneSurrogate({ body: `${LOW}${HIGH}` })).toBe("/body");
  });

  it("points at a string at the root", () => {
    expect(findLoneSurrogate(HIGH)).toBe("");
  });

  it("points at an object key, by the member it names", () => {
    expect(findLoneSurrogate({ properties: { [`k${HIGH}`]: 1 } })).toBe(
      "/properties/k\ufffd",
    );
  });

  it("finds a string nested in arrays and objects", () => {
    expect(
      findLoneSurrogate({
        items: [{ ok: "a" }, { properties: { list: ["fine", [HIGH]] } }],
      }),
    ).toBe("/items/1/properties/list/1/0");
  });

  it("escapes ~ and / in the pointer", () => {
    expect(findLoneSurrogate({ "a/b": { "c~d": HIGH } })).toBe("/a~1b/c~0d");
  });

  it("returns the first offender in document order", () => {
    expect(findLoneSurrogate({ a: "ok", b: HIGH, c: LOW })).toBe("/b");
  });

  it("never returns a pointer that is itself not well-formed", () => {
    const pointer = findLoneSurrogate({ [HIGH]: { [LOW]: 1 } });
    expect(pointer).not.toBe(null);
    expect(isWellFormedText(pointer ?? "")).toBe(true);
  });

  it("walks a very deep value without exhausting the stack", () => {
    let deep: unknown = HIGH;
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(findLoneSurrogate(deep)).toBe("/0".repeat(200_000));
  });

  it("reads an own __proto__ key like any other", () => {
    const parsed: unknown = JSON.parse('{"__proto__":"\\ud83d"}');
    expect(findLoneSurrogate(parsed)).toBe("/__proto__");
  });
});
