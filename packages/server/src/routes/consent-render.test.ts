import { describe, it, expect } from "vitest";
import type { ParsedScope } from "@mymehq/shared";
import { renderConsentScreen } from "./consent.js";

/**
 * Wave C PR4 — behaviour-preserving smoke for `renderConsentScreen`
 * after the layout extraction. T-131 rewrote the form shape to match
 * the @better-auth/oauth-provider plugin: the form now POSTs back to
 * `/auth/oauth2/consent` with a pre-minted `code` (no PKCE/state in
 * hidden fields). This test file asserts the HTML shape directly so
 * a future tweak to the layout helper can't silently break the
 * consent surface.
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
  code: "preminted-auth-code-xyz",
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

  it("POSTs to the plugin's consent endpoint with code + client_id hidden", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain(
      '<form method="POST" action="/auth/oauth2/consent"',
    );
    expect(html).toContain('name="client_id" value="client-abc"');
    expect(html).toContain('name="code" value="preminted-auth-code-xyz"');
    // PKCE / state / redirect_uri are bound to the code server-side; they
    // must NOT appear in the form (the plugin rejects redundant params).
    expect(html).not.toContain('name="redirect_uri"');
    expect(html).not.toContain('name="code_challenge"');
    expect(html).not.toContain('name="state"');
    expect(html).not.toContain('name="response_type"');
  });

  it("renders Approve + Deny buttons with accept=true|false (plugin contract)", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toMatch(
      /<button[^>]*name="accept"[^>]*value="true"[^>]*>Approve<\/button>/,
    );
    expect(html).toMatch(
      /<button[^>]*name="accept"[^>]*value="false"[^>]*>Deny<\/button>/,
    );
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

describe("renderConsentScreen — re-consent diff (Wave C PR5 / T-032)", () => {
  it("renders the kept / added / removed groups when priorScopes is supplied", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      // PARAMS.scopes = note:read, note:write, task:read
      priorScopes: ["core.note:read", "core.task:write"],
    });
    expect(html).toContain('class="section section--kept"');
    expect(html).toContain('class="section section--added"');
    expect(html).toContain('class="section section--removed"');
    expect(html).toContain("Previously granted</h2>");
    expect(html).toContain("New permissions</h2>");
    expect(html).toContain("No longer requested</h2>");
    // Flat sections must NOT render in diff mode.
    expect(html).not.toContain("Read access</h2>");
    expect(html).not.toContain("Read and write access</h2>");
  });

  it("kept group carries scopes present in BOTH prev + next", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read"],
    });
    // core.note:read is in both → kept
    expect(html).toMatch(
      /section--kept[\s\S]*?core\.note:read[\s\S]*?(?:section--|<\/div>)/,
    );
  });

  it("added group carries scopes new in next", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read"],
    });
    // core.note:write + core.task:read are added (new in next)
    expect(html).toMatch(/section--added[\s\S]*?core\.note:write/);
    expect(html).toMatch(/section--added[\s\S]*?core\.task:read/);
  });

  it("removed group carries scopes from prev that next omits, with strikethrough class", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read", "core.task:write"],
    });
    expect(html).toMatch(/section--removed[\s\S]*?core\.task:write/);
    expect(html).toContain('class="scope-row scope-row--removed"');
  });

  it("omits a diff group when its set is empty", () => {
    // Identical prev + next → only "Previously granted" renders.
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read", "core.note:write", "core.task:read"],
    });
    expect(html).toContain("Previously granted");
    expect(html).not.toContain("New permissions");
    expect(html).not.toContain("No longer requested");
  });

  it("changes the heading copy in the diff variant", () => {
    const flat = renderConsentScreen(PARAMS);
    expect(flat).toContain("wants to access your data");

    const diff = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read"],
    });
    expect(diff).toContain("requesting updated access");
  });

  it("removed scopes render their plain-English description", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read", "core.task:write"],
    });
    // Removed: core.task:write → "Tasks and todos." description
    expect(html).toMatch(/section--removed[\s\S]*?Tasks and todos/);
  });
});
