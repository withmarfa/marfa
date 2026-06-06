import { describe, it, expect } from "vitest";
import { renderAuthLayout } from "./auth-layout.js";

/**
 * `renderAuthLayout` is the shared scaffold. Tests cover:
 *   - Document shape (DOCTYPE / html / head / body)
 *   - Title rendered + escaped
 *   - Stylesheet `<link>` points at /auth/static/auth.css
 *   - bodyHtml interpolated verbatim (NOT escaped — caller's
 *     responsibility)
 *   - aria-label override threads through
 *   - `wide: true` switches the card class
 */

describe("renderAuthLayout", () => {
  it("renders a complete HTML document with DOCTYPE + viewport meta", () => {
    const html = renderAuthLayout({ title: "Hi", bodyHtml: "<p>x</p>" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(html).toContain("</html>");
  });

  it("links to /auth/static/auth.css", () => {
    const html = renderAuthLayout({ title: "x", bodyHtml: "" });
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
  });

  it("renders title verbatim into <title>", () => {
    const html = renderAuthLayout({
      title: "Sign in to Marfa",
      bodyHtml: "",
    });
    expect(html).toContain("<title>Sign in to Marfa</title>");
  });

  it("escapes HTML in title to prevent injection", () => {
    const html = renderAuthLayout({
      title: "<script>alert(1)</script>",
      bodyHtml: "",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does NOT escape bodyHtml — caller is responsible", () => {
    const html = renderAuthLayout({
      title: "x",
      bodyHtml: '<form action="/x"><input name="y"></form>',
    });
    expect(html).toContain('<form action="/x"><input name="y"></form>');
  });

  it("renders the body inside <main class=card>", () => {
    const html = renderAuthLayout({
      title: "x",
      bodyHtml: "<h1>Hello</h1>",
    });
    expect(html).toMatch(
      /<main class="card"[^>]*>\s*<h1>Hello<\/h1>\s*<\/main>/,
    );
  });

  it("uses card--wide when wide=true", () => {
    const html = renderAuthLayout({
      title: "x",
      bodyHtml: "",
      wide: true,
    });
    expect(html).toContain('class="card card--wide"');
  });

  it("aria-label defaults to title", () => {
    const html = renderAuthLayout({ title: "Sign in", bodyHtml: "" });
    expect(html).toContain('aria-label="Sign in"');
  });

  it("aria-label override threads through escaped", () => {
    const html = renderAuthLayout({
      title: "Authorize CLI",
      ariaLabel: "Approval result",
      bodyHtml: "",
    });
    expect(html).toContain('aria-label="Approval result"');
    expect(html).toContain("<title>Authorize CLI</title>");
  });
});
