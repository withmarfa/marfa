import { describe, expect, it } from "vitest";
import {
  appSignInName,
  browserSignInName,
  keySignInName,
  SIGN_IN_NAME_MAX,
  usableSignInName,
} from "./sign-in-names.js";

describe("a browser's sign-in name", () => {
  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      "Safari on macOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      "Chrome on macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      "Firefox on Linux",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari on iOS",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.0.0 Mobile/15E148 Safari/604.1",
      "Chrome on iPadOS",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    [
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      "Chrome on ChromeOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0",
      "Opera on Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0",
      "Firefox on macOS",
    ],
  ])("names %s", (userAgent, name) => {
    expect(browserSignInName(userAgent)).toBe(name);
  });

  it("names a client it does not know by its first product", () => {
    expect(browserSignInName("curl/8.7.1")).toBe("curl");
    expect(browserSignInName("owner-sign-ins browser 3")).toBe(
      "owner-sign-ins",
    );
  });

  it("names a browser it cannot read at all as a browser", () => {
    expect(browserSignInName(null)).toBe("A browser");
    expect(browserSignInName("")).toBe("A browser");
    expect(browserSignInName("   ")).toBe("A browser");
    expect(browserSignInName("(;;)")).toBe("A browser");
  });

  it("keeps a product name it does not know short and printable", () => {
    const name = browserSignInName(`${"x".repeat(500)}/1.0`);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(browserSignInName("bad\u0000name/1")).toBe("A browser");
    expect(browserSignInName("curl\u202e/1")).toBe("A browser");
    expect(browserSignInName("curl\u0085/1")).toBe("A browser");
  });
});

describe("an app's sign-in name", () => {
  it("is the owner's own name, then the registered name, then the client id", () => {
    expect(appSignInName("Work laptop", "marfa on laptop", "c1")).toBe(
      "Work laptop",
    );
    expect(appSignInName(undefined, "marfa on laptop", "c1")).toBe(
      "marfa on laptop",
    );
    expect(appSignInName(undefined, null, "c1")).toBe("c1");
    expect(appSignInName("  ", "  ", "c1")).toBe("c1");
  });
});

describe("a name a sign-in can be shown by", () => {
  it.each([
    [
      "a carriage return and an erase-line escape",
      "marfa\r\u001b[2Kforged row",
    ],
    ["a newline", "line one\nline two"],
    ["a C1 control", "next\u0085line"],
    ["a right-to-left override", "evil\u202eexe.txt"],
    ["a first-strong isolate", "evil\u2068name"],
    ["more than the longest name", "x".repeat(SIGN_IN_NAME_MAX + 1)],
    ["only spaces", "   "],
  ])("is no name when it holds %s", (_what, name) => {
    expect(usableSignInName(name)).toBeUndefined();
    expect(appSignInName(undefined, name, "client-1")).toBe("client-1");
    expect(appSignInName(name, "registered", "client-1")).toBe("registered");
    expect(keySignInName(name, "key-1")).toBe("key-1");
  });

  it("is the name, trimmed, when it holds printable text up to the longest name", () => {
    expect(usableSignInName("  Marfa app on MacBook Pro  ")).toBe(
      "Marfa app on MacBook Pro",
    );
    expect(usableSignInName("x".repeat(SIGN_IN_NAME_MAX))).toHaveLength(
      SIGN_IN_NAME_MAX,
    );
    expect(keySignInName("Work laptop", "key-1")).toBe("Work laptop");
    expect(usableSignInName("Café \u{1F600} naïve")).toBe(
      "Café \u{1F600} naïve",
    );
  });
});
