import { describe, expect, it } from "vitest";
import { localHref } from "./href.js";

describe("localHref", () => {
  it.each(["/", "/keys", "/keys/3?page=2#top", "/a/b"])(
    "accepts %j",
    (href) => {
      expect(localHref(href)).toBe(href);
    },
  );

  it.each([
    ["a tab before a second slash", "/\t/evil.com"],
    ["a newline before a second slash", "/\n/evil.com"],
    ["a carriage return before a second slash", "/\r/evil.com"],
    ["a protocol-relative address", "//evil.com"],
    ["a backslash", "/\\evil.com"],
    ["a script address", "javascript:alert(1)"],
    ["an absolute address", "https://evil.com/"],
    ["a bare word", "keys"],
    ["an empty string", ""],
    ["a control character later on", "/keys\u0000"],
    ["a delete character", "/keys\u007f"],
    ["a trailing newline", "/keys\n"],
  ])("refuses %s", (_name, href) => {
    expect(() => localHref(href)).toThrow(/address/i);
  });

  it("is not a string", () => {
    expect(() => localHref(undefined as unknown as string)).toThrow(/address/i);
  });

  it("takes a query or fragment alone only when the caller says it is relative", () => {
    for (const href of ["", "?page=2", "#main"]) {
      expect(() => localHref(href)).toThrow(/address/i);
      expect(localHref(href, { relative: true })).toBe(href);
    }
    expect(() => localHref("?a\t=1", { relative: true })).toThrow(/address/i);
    expect(() => localHref("keys", { relative: true })).toThrow(/address/i);
  });
});
