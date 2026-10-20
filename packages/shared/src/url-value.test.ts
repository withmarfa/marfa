import { afterEach, describe, expect, it } from "vitest";
import {
  registerTypeSchema,
  unregisterTypeSchema,
  validateProperties,
} from "./type-registry.js";

const TYPE = "test.url.value";

afterEach(() => {
  unregisterTypeSchema(TYPE);
});

function judge(written: unknown, field: "url" | "sites" = "url") {
  registerTypeSchema({
    id: TYPE,
    version: 1,
    fields: {
      url: { type: "url" },
      sites: { type: "array", items_type: "url" },
    },
  });
  return validateProperties(TYPE, {
    [field]: field === "sites" ? [written] : written,
  });
}

// Node 22 and 24 refuse the hosts below that start `xn--` and are not valid
// Punycode, and Node 26 takes them, so the platform's `URL` gives three
// answers. The URL Standard takes any host that is ASCII once its percent
// escapes are decoded, whatever IDNA would say of its labels.
const TAKEN = [
  "http://xn--",
  "http://xn--/",
  "http://xn--%41",
  "http://XN--%41/p",
  "http://xn--a",
  "http://xn--!",
  "http://xn--%7E",
  "http://xn--_",
  "http:xn--",
  "http://%78n--/",
  "http://a.xn--/",
  "http://user:pw@xn--:8080/p",
  "ws://xn--",
  "file://xn--/",
  "http://xn--abc-/",
  "http://a.b.c.xn--pokxncvks",
  "http://xn--xn---yna/",
  "http://xn----pfa.xn--4db/",
  "http://xn--mnchen-3ya.de/",
  "HTTP://XN--MNCHEN-3YA.DE/",
  "http://xn--80ak6aa92e.com/",
  "http://xn--mnchen-3ya.xn--mnchen-3yb/",
  "https://münchen.de/straße",
  "https://example.com/xn--",
  "https://example.com/?q=xn--",
  "http://user:xn--@example.com/",
  "http://[::1]/",
  "http://1.2.3.4/",
  "mailto:xn--@example.com",
  "foo://xn--/",
  "foo://xn--%41/",
];

// A host with a character that is not ASCII after its escapes are decoded has
// to be valid IDNA, and a decoded host may not hold a forbidden code point.
const REFUSED = [
  "http://xn--é/",
  "http://xn--%e9/",
  "http://xn--%c3%a9/",
  "http://xn--%2f/",
  "http://xn--%20/",
  "http://xn--%3a80/",
  "http://xn--%2541/",
  "http://xn--a%00/",
  "https://xn--a b/",
  "http://xn--[::1]/",
  "http://bücher.xn--",
  "http://xn--a.münchen.de/",
  "http://xn--.1",
  "http://xn--a.256/",
  "//example.com",
  "http://example.com:99999",
  "not a url",
  "",
  "   ",
];

describe("a url value", () => {
  it.each(TAKEN)("takes %s whatever Node judges it", (written) => {
    expect(judge(written).success).toBe(true);
    expect(judge(written, "sites").success).toBe(true);
  });

  it.each(REFUSED)("refuses %j with the message Invalid URL", (written) => {
    for (const field of ["url", "sites"] as const) {
      const result = judge(written, field);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors).toEqual([
          {
            field: field === "url" ? "url" : "sites.0",
            message: "Invalid URL",
          },
        ]);
      }
    }
  });

  it("refuses what is not text", () => {
    for (const written of [1, true, {}, []]) {
      expect(judge(written).success, JSON.stringify(written)).toBe(false);
    }
  });

  it.each([
    ["  https://example.com/a  ", "https://example.com/a"],
    ["　https://example.com/a　", "https://example.com/a"],
    ["﻿https://example.com/a﻿", "https://example.com/a"],
    [" https://example.com/a ", "https://example.com/a"],
    ["https://exa\tmple.com/\na\r", "https://example.com/a"],
    ["HTTP://XN--MNCHEN-3YA.DE/x", "HTTP://XN--MNCHEN-3YA.DE/x"],
  ])("stores %j as %j", (written, stored) => {
    const result = judge(written);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.url).toBe(stored);
  });

  it("refuses a value padded with a character trim does not remove", () => {
    expect(judge("\u0085https://example.com/").success).toBe(false);
    expect(judge("​https://example.com/").success).toBe(false);
  });
});
