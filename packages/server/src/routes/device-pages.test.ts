import { describe, it, expect } from "vitest";
import { pageAssetUrl } from "../pages/assets.js";
import { DEVICE_CODE_LIFETIME_MINUTES } from "../auth/device-code-lifetime.js";
import {
  pageField,
  pageFieldError,
  pageForms,
  visibleText,
} from "../pages/reading.js";
import { renderDevicePage } from "./test-render.js";

/**
 * The page where a person types a device's code, read as a person and a form
 * read it. The approval screen is in device-approval.test.ts, and the
 * handler-side round trip (RFC 8628 polling) is in device-grant.test.ts.
 */

describe("renderDevicePage", () => {
  it("uses the shared page system, with no inline style, handler or script of its own", () => {
    const html = renderDevicePage({ prefilled: "" });
    expect(html).toContain(`href="${pageAssetUrl("pages.css")}"`);
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/);
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(`src="${pageAssetUrl("pages.js")}"`);
    // The script only writes the code as it is typed.
    expect(visibleText(html)).not.toContain("needs JavaScript");
  });

  it("asks for the code in one field, posting it to /auth/device", () => {
    const html = renderDevicePage({ prefilled: "" });
    const text = visibleText(html);
    expect(text).toContain("Connect a device");
    expect(text).toContain("Enter the code shown on your device.");
    expect(pageForms(html).map((form) => [form.method, form.action])).toEqual([
      ["post", "/auth/device"],
    ]);
    const code = pageField(html, "user_code");
    expect(code).toMatchObject({ type: "text", autofocus: true });
    expect(text).toContain("Code");
    expect(html).toMatch(/placeholder="XXXX-XXXX"/);
    expect(text).toContain("Continue");
  });

  it("says how long a code lasts, from the lifetime the codes are issued with", () => {
    expect(DEVICE_CODE_LIFETIME_MINUTES).toBe(10);
    expect(visibleText(renderDevicePage({ prefilled: "" }))).toContain(
      "Codes end after 10 minutes.",
    );
  });

  it("pre-fills the code from params, escaped", () => {
    expect(
      pageField(renderDevicePage({ prefilled: "ABCD-1234" }), "user_code")
        ?.value,
    ).toBe("ABCD-1234");
    const hostile = renderDevicePage({ prefilled: '"><script>x</script>' });
    expect(hostile).not.toContain("<script>x</script>");
  });

  it("says a code that is wrong, and asks to check it", () => {
    const html = renderDevicePage({ prefilled: "", error: "invalid_code" });
    expect(pageFieldError(html, "user_code")).toBe(
      "That code isn't right. Check it against your device and try again.",
    );
    expect(html).toContain('aria-invalid="true"');
    expect(visibleText(html)).not.toContain("Codes end after");
  });

  it("says a code that has expired, and sends the person to the device for a new one", () => {
    const html = renderDevicePage({ prefilled: "", error: "expired_code" });
    expect(pageFieldError(html, "user_code")).toBe(
      "That code has expired. Start again on your device to get a new one.",
    );
    expect(html).toContain('aria-invalid="true"');
    expect(visibleText(html)).not.toContain("Codes end after");
  });

  it("says a code already used and a missing code in their own words", () => {
    expect(
      pageFieldError(
        renderDevicePage({ prefilled: "", error: "already_resolved" }),
        "user_code",
      ),
    ).toContain("already been used");
    expect(
      pageFieldError(
        renderDevicePage({ prefilled: "", error: "missing_code" }),
        "user_code",
      ),
    ).toBe("Enter the code shown on your device.");
  });

  it("names the wait in whole minutes after too many codes, and no minutes without one", () => {
    const wait = (retryAfter?: number): string | undefined =>
      pageFieldError(
        renderDevicePage({
          prefilled: "",
          error: "too_many_attempts",
          retryAfter,
        }),
        "user_code",
      );
    expect(wait(1)).toBe(
      "Too many codes have been tried. Try again in 1 minute.",
    );
    expect(wait(61)).toBe(
      "Too many codes have been tried. Try again in 2 minutes.",
    );
    expect(wait(900)).toBe(
      "Too many codes have been tried. Try again in 15 minutes.",
    );
    expect(wait()).toBe("Too many codes have been tried. Try again later.");
  });

  it("falls back to a generic message for unknown error codes", () => {
    expect(
      pageFieldError(
        renderDevicePage({ prefilled: "", error: "??" }),
        "user_code",
      ),
    ).toContain("Something went wrong");
  });
});
