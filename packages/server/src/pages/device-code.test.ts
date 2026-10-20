import { describe, expect, it } from "vitest";
import {
  charactersBefore,
  formatDeviceCode,
  positionAfter,
} from "./device-code.js";

describe("formatDeviceCode", () => {
  it("writes capitals with a dash after the fourth character", () => {
    expect(formatDeviceCode("a")).toBe("A");
    expect(formatDeviceCode("abcd")).toBe("ABCD");
    expect(formatDeviceCode("abcde")).toBe("ABCD-E");
    expect(formatDeviceCode("abcdefgh")).toBe("ABCD-EFGH");
  });

  it("takes any case, spaces and dashes, and keeps no more than eight characters", () => {
    expect(formatDeviceCode(" abcd - efgh ")).toBe("ABCD-EFGH");
    expect(formatDeviceCode("ab cd ef gh jk")).toBe("ABCD-EFGH");
    expect(formatDeviceCode("ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(formatDeviceCode("--")).toBe("");
  });
});

describe("the cursor across a rewrite", () => {
  it("counts the letters and digits before it, whatever else was typed", () => {
    expect(charactersBefore("ab cd-ef", 5)).toBe(4);
    expect(charactersBefore("ABCD-E", 6)).toBe(5);
    expect(charactersBefore("--", 2)).toBe(0);
  });

  it("puts it after the same characters in the formatted code, past the dash once there is one", () => {
    expect(positionAfter("ABCD-EFGH", 2)).toBe(2);
    expect(positionAfter("ABCD-EFGH", 4)).toBe(4);
    expect(positionAfter("ABCD-EFGH", 5)).toBe(6);
    expect(positionAfter("ABCD-EFGH", 8)).toBe(9);
    expect(positionAfter("ABCD", 9)).toBe(4);
  });
});
