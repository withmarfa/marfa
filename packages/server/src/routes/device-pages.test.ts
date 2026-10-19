import { authAssetUrl } from "./auth-static.js";
import { describe, it, expect } from "vitest";
import { renderDevicePage } from "./test-render.js";

/**
 * The page where a person types a device's code. The approval screen is in
 * device-approval.test.ts, and the handler-side round trip (RFC 8628
 * polling) is in device-grant.test.ts.
 */

describe("renderDevicePage", () => {
  it("links to the shared stylesheet and has no inline <style>", () => {
    const html = renderDevicePage({ prefilled: "" });
    expect(html).toContain(
      `<link rel="stylesheet" href="${authAssetUrl("auth.css")}" nonce="test-nonce">`,
    );
    expect(html).not.toContain("<style>");
  });

  it("renders the user_code form posting to /auth/device", () => {
    const html = renderDevicePage({ prefilled: "" });
    expect(html).toContain('<form method="POST" action="/auth/device"');
    expect(html).toContain('name="user_code"');
    expect(html).toContain("Continue");
  });

  it("uses the monospace code input class", () => {
    const html = renderDevicePage({ prefilled: "" });
    expect(html).toContain('class="field__input--code"');
  });

  it("pre-fills the user_code from params, escaped", () => {
    const html = renderDevicePage({ prefilled: "ABCD-1234" });
    expect(html).toContain('value="ABCD-1234"');
  });

  it("escapes injected user_code values", () => {
    const html = renderDevicePage({ prefilled: '"><script>x</script>' });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("surfaces error codes under the code field with role=alert", () => {
    const html = renderDevicePage({ prefilled: "", error: "invalid_code" });
    // Single-field form, so the error renders inline at the code input, not a
    // top banner.
    expect(html).toContain('class="field field--error"');
    expect(html).toContain('class="field__error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("recognized. Check for typos");
    expect(html).not.toContain('class="banner banner--error"');
  });

  it("falls back to a generic message for unknown error codes", () => {
    const html = renderDevicePage({ prefilled: "", error: "??" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
  });
});
