import { afterEach, describe, expect, it } from "vitest";
import { hasInvalidPunycodeLabel } from "./url-host.js";
import {
  registerTypeSchema,
  unregisterTypeSchema,
  validateProperties,
} from "./type-registry.js";

const TYPE = "test.url.host";

afterEach(() => {
  unregisterTypeSchema(TYPE);
});

function judges(written: string): boolean {
  registerTypeSchema({
    id: TYPE,
    version: 1,
    fields: { url: { type: "url" } },
  });
  return validateProperties(TYPE, { url: written }).success;
}

// Node 22 and 24 refuse the first group in the URL parser and Node 26 takes
// most of it, so each of these has one answer only if Marfa gives it itself.
const REFUSED = [
  "http://xn--",
  "http://xn--/",
  "http://xn--%41",
  "http://XN--%41/p",
  "http://xn--a",
  "http://xn--!",
  "http://xn--%7E",
  "http://xn--_",
  "http:xn--",
  "http://bücher.xn--",
  "http://xn--a.münchen.de/",
  "http://a.xn--.b/",
  "http://user:pw@xn--:8080/p",
  "http://%78n--/",
  "ws://xn--",
  "file://xn--/",
  "http://xn--abc-/",
  "http://xn--mnchen-3ya-/",
  "http://a.b.c.xn--pokxncvks",
  "http://xn--é/",
  "http://xn--%e9/",
];

const TAKEN = [
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

describe("a url with a label that starts xn-- and is not valid Punycode", () => {
  it.each(REFUSED)("refuses %s", (written) => {
    expect(judges(written)).toBe(false);
  });

  it.each(TAKEN)("takes %s", (written) => {
    expect(hasInvalidPunycodeLabel(written)).toBe(false);
    expect(judges(written)).toBe(true);
  });

  it("is what refuses the value where the platform takes it", () => {
    const platformTakes = REFUSED.filter((written) => URL.canParse(written));
    for (const written of platformTakes) {
      expect(hasInvalidPunycodeLabel(written), written).toBe(true);
    }
  });
});
