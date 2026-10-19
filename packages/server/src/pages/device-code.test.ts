import { describe, expect, it } from "vitest";
import { formatDeviceCode } from "./device-code.js";

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
