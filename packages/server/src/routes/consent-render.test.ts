import { describe, it, expect } from "vitest";
import type { ParsedScope } from "@mymehq/shared";
import { renderConsentScreen } from "./consent.js";

/**
 * Wave C PR4 — behaviour-preserving smoke for `renderConsentScreen`
 * after the layout extraction. T-131 rewrote the form shape to match
 * the @better-auth/oauth-provider plugin: the form now POSTs back to
 * `/auth/authorize/decision` (Myme handler, which proxies to
 * `/auth/oauth2/consent`) with a single `oauth_query` hidden field
 * carrying the plugin's full signed authorize-request query string.
 * This test file asserts the HTML shape directly so a future tweak
 * to the layout helper can't silently break the consent surface.
 */

const SCOPES: ParsedScope[] = [
  { typePattern: "core.note", operation: "read" },
  { typePattern: "core.note", operation: "write" },
  { typePattern: "core.task", operation: "read" },
];

const SIGNED_OAUTH_QUERY =
  "response_type=code&client_id=client-abc&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&scope=core.note%3Aread&state=abc&code_challenge=def&code_challenge_method=S256&exp=1778957000&sig=somesignaturehash";

const PARAMS = {
  clientName: "Test CLI",
  scopes: SCOPES,
  clientId: "client-abc",
  oauthQuery: SIGNED_OAUTH_QUERY,
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

  it("POSTs to the Myme decision handler with oauth_query + client_id hidden", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain(
      '<form method="POST" action="/auth/authorize/decision"',
    );
    expect(html).toContain('name="client_id" value="client-abc"');
    // oauth_query carries the plugin's signed authorize-request params
    // verbatim. The form must round-trip the full signed string —
    // re-hashing or partial copying would break the plugin's
    // signature check. We assert the field exists with the leading
    // `response_type=` segment (HTML-escaping of `=` is a no-op).
    expect(html).toContain('name="oauth_query"');
    expect(html).toContain("response_type=code");
    expect(html).toContain("sig=somesignaturehash");
    // No pre-minted code: the plugin doesn't mint one until /oauth2/consent.
    expect(html).not.toContain('name="code"');
    // No raw PKCE / state / redirect_uri hidden fields — they live
    // INSIDE oauth_query, not as separate form fields.
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

// ---------------------------------------------------------------------------
// T-131 fix-up: F2 error banner + F11 description coverage for OIDC + edge
// ---------------------------------------------------------------------------

describe("renderConsentScreen — error banner (T-131 F2)", () => {
  it("omits the alert div when errorMessage is undefined", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).not.toContain("alert--error");
  });

  it("renders an alert div when errorMessage is set", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      errorMessage: "Approve needs at least one permission ticked.",
    });
    expect(html).toContain('class="alert alert--error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Approve needs at least one permission ticked.");
  });

  it("escapes HTML in errorMessage (XSS guard)", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      errorMessage: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
