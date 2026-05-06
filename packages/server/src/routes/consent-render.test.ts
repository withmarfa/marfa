import { describe, it, expect } from "vitest";
import type { ParsedScope } from "@mymehq/shared";
import { renderConsentScreen } from "./consent.js";

/**
 * Wave C PR4 — behaviour-preserving smoke for `renderConsentScreen`
 * after the layout extraction. The handler-side smoke (POST /authorize
 * round-trip) lives in oauth.test.ts; this file asserts the HTML shape
 * directly so a future tweak to the layout helper can't silently
 * break the consent surface.
 */

const SCOPES: ParsedScope[] = [
  { typePattern: "core.note", operation: "read" },
  { typePattern: "core.note", operation: "write" },
  { typePattern: "core.task", operation: "read" },
];

const PARAMS = {
  clientName: "Test CLI",
  scopes: SCOPES,
  clientId: "client-abc",
  redirectUri: "http://localhost:9999/cb",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  state: "xyz",
  responseType: "code",
  descriptions: {
    "core.note": "Text content you created.",
    "core.task": "Tasks and todos.",
  },
};

describe("renderConsentScreen (Wave C PR4)", () => {
  it("links to the shared stylesheet and carries no inline <style> block", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).not.toContain("<style>");
  });

  it("escapes the client name in the title", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      clientName: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a separate read + write section when both kinds present", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain("<h2>Read access</h2>");
    expect(html).toContain("<h2>Read and write access</h2>");
  });

  it("threads scope literals + plain-English descriptions into rows", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('value="core.note:read"');
    expect(html).toContain('value="core.note:write"');
    expect(html).toContain('value="core.task:read"');
    expect(html).toContain("Text content you created.");
    expect(html).toContain("Tasks and todos.");
  });

  it("preserves the POST target + hidden OAuth round-trip fields", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('<form method="POST" action="/auth/authorize"');
    expect(html).toContain('name="client_id" value="client-abc"');
    expect(html).toContain('name="redirect_uri"');
    expect(html).toContain('name="code_challenge"');
    expect(html).toContain('name="code_challenge_method"');
    expect(html).toContain('name="state"');
    expect(html).toContain('name="response_type"');
  });

  it("renders Approve + Deny buttons", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toMatch(/<button[^>]*value="approve"[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*value="deny"[^>]*>Deny<\/button>/);
  });

  it("uses the wide card variant", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('class="card card--wide"');
  });

  it("omits the read section when no read scopes", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [{ typePattern: "core.note", operation: "write" }],
    });
    expect(html).not.toContain("Read access</h2>");
    expect(html).toContain("Read and write access</h2>");
  });

  it("omits the write section when no write scopes", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [{ typePattern: "core.note", operation: "read" }],
    });
    expect(html).toContain("Read access</h2>");
    expect(html).not.toContain("Read and write access</h2>");
  });
});
