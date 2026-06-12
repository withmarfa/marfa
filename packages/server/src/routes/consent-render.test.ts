import { describe, it, expect } from "vitest";
import type { ParsedScope } from "@withmarfa/shared";
import { renderConsentScreen } from "./consent.js";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";

/**
 * Shape-asserting smoke for `renderConsentScreen`. Covers:
 *
 * - Layout / contract: shared stylesheet link, no inline `<style>`,
 *   form posts to `/auth/authorize/decision` with the signed
 *   `oauth_query` round-tripped verbatim, scope checkboxes named
 *   `scopes` with the literal as `value`, Allow/Deny buttons carry
 *   `name="accept" value="true|false"`, wide card variant.
 *
 * - Re-consent diff variant: added / kept / removed group rendering,
 *   heading copy switch, removed rows strikethrough-classed.
 *
 * - Error banner: rendered when `errorMessage` is set, escaped against
 *   XSS, absent otherwise.
 *
 * - Polish-pass shape: title + lede only (no avatar / no eyebrow),
 *   sections rendered as plain labelled groups, toggle-switch
 *   markup wrapping a real checkbox, primary "Allow access" button.
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

describe("renderConsentScreen — layout + form contract", () => {
  it("links to the shared stylesheet and carries no inline <style> block", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).not.toContain("<style>");
  });

  it("escapes the client name in the body", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      clientName: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("threads scope literals + plain-English descriptions into rows", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('value="core.note:read"');
    expect(html).toContain('value="core.note:write"');
    expect(html).toContain('value="core.task:read"');
    expect(html).toContain("Text content you created.");
    expect(html).toContain("Tasks and todos.");
  });

  it("POSTs to the Marfa decision handler with oauth_query + client_id hidden", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain(
      '<form method="POST" action="/auth/authorize/decision"',
    );
    expect(html).toContain('name="client_id" value="client-abc"');
    expect(html).toContain('name="oauth_query"');
    expect(html).toContain("response_type=code");
    expect(html).toContain("sig=somesignaturehash");
    // PKCE / state / redirect_uri are inside oauth_query, not separate hidden fields.
    expect(html).not.toContain('name="code"');
    expect(html).not.toContain('name="redirect_uri"');
    expect(html).not.toContain('name="code_challenge"');
    expect(html).not.toContain('name="state"');
    expect(html).not.toContain('name="response_type"');
  });

  it("renders Allow + Deny buttons with accept=true|false (plugin contract)", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toMatch(
      /<button[^>]*name="accept"[^>]*value="true"[^>]*>Allow access<\/button>/,
    );
    expect(html).toMatch(
      /<button[^>]*name="accept"[^>]*value="false"[^>]*>Deny<\/button>/,
    );
  });

  it("uses the wide card variant", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('class="card card--wide"');
  });

  it("hides scope literals (no monospace pills in the consent rows)", () => {
    const html = renderConsentScreen(PARAMS);
    // The literals exist as the checkbox `value`, but nothing renders
    // them as visible monospace pills the way the old design did.
    expect(html).not.toContain('class="scope-row__literal"');
    expect(html).not.toContain('class="scope-literal"');
  });
});

describe("renderConsentScreen — flat (first-time) sections", () => {
  it("renders a Read + Read &amp; write section when both kinds present", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain(">Read<");
    expect(html).toContain(">Read &amp; write<");
  });

  it("renders an Identity section when OIDC scopes are present", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [
        { kind: "oidc", typePattern: "openid", oidcScope: "openid" },
        { kind: "oidc", typePattern: "email", oidcScope: "email" },
        ...SCOPES,
      ] as ParsedScope[],
      descriptions: {
        ...PARAMS.descriptions,
        openid: "Confirm your identity.",
        email: "See your email address.",
      },
    });
    expect(html).toContain(">Identity<");
    expect(html).toContain('value="openid"');
    expect(html).toContain('value="email"');
    expect(html).toContain("Confirm your identity.");
  });

  it("omits sections with no scopes (no empty Read block)", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      scopes: [{ typePattern: "core.note", operation: "write" }],
    });
    expect(html).not.toContain(">Read<");
    expect(html).toContain(">Read &amp; write<");
  });

  it("renders a 'N enabled' count next to each section label", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toMatch(
      /Read<\/span>\s*<span class="section__count"[^>]*>2 enabled</,
    );
    expect(html).toMatch(
      /Read &amp; write<\/span>\s*<span class="section__count"[^>]*>1 enabled</,
    );
  });

  it("renders sections as <details> collapsed by default", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toMatch(/<details class="section"[^>]*data-section/);
    expect(html).not.toMatch(/<details[^>]*\sopen[^>]*data-section/);
  });
});

describe("renderConsentScreen — re-consent diff", () => {
  it("renders kept / added / removed groups when priorScopes is supplied", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read", "core.task:write"],
    });
    expect(html).toContain("section--kept");
    expect(html).toContain("section--added");
    expect(html).toContain("section--removed");
    expect(html).toContain("New permissions");
    expect(html).toContain("Previously granted");
    expect(html).toContain("No longer requested");
    expect(html).not.toContain(">Read<");
    expect(html).not.toContain(">Read &amp; write<");
  });

  it("kept group carries scopes present in BOTH prev + next", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read"],
    });
    expect(html).toMatch(/section--kept[\s\S]*?value="core\.note:read"/);
  });

  it("added group carries scopes new in next", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read"],
    });
    expect(html).toMatch(/section--added[\s\S]*?value="core\.note:write"/);
    expect(html).toMatch(/section--added[\s\S]*?value="core\.task:read"/);
  });

  it("removed group carries scopes from prev that next omits, with strikethrough class", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read", "core.task:write"],
    });
    expect(html).toMatch(/section--removed[\s\S]*?Tasks and todos\./);
    expect(html).toContain("scope-row--removed");
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
    expect(flat).toContain("Allow access");
    expect(flat).toContain("asking to access your Marfa space");

    const diff = renderConsentScreen({
      ...PARAMS,
      priorScopes: ["core.note:read"],
    });
    expect(diff).toContain("Update access");
    expect(diff).toContain("needs different permissions");
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

describe("renderConsentScreen — error banner", () => {
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

describe("renderConsentScreen — polish-pass shape", () => {
  it("renders an H1 title + client-name lede (no avatar, no eyebrow)", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('class="consent-title"');
    expect(html).toContain('class="consent-lede"');
    expect(html).toMatch(/<span class="client-name">Test CLI<\/span>/);
    expect(html).not.toContain("consent-avatar");
    expect(html).not.toContain("consent-eyebrow");
  });

  it("wraps each scope checkbox in a toggle-switch", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('class="toggle"');
    expect(html).toContain('class="toggle__track"');
    expect(html).toMatch(
      /<input type="checkbox" name="scopes" value="core\.note:read" checked>/,
    );
  });

  it("renders the revocation footnote", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain('class="consent-footnote"');
    expect(html).toContain("Security settings");
  });

  it("ships the live-count enhancement script (keeps 'X enabled' accurate as toggles flip)", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain("data-section");
    expect(html).toContain("data-section-count");
    expect(html).toMatch(/<script>[\s\S]*data-section-count[\s\S]*<\/script>/);
  });

  it("renders Allow + Deny stacked, primary above a ghost secondary", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).toContain("actions--stacked");
    expect(html).toContain("btn--ghost");
    // Primary "Allow access" renders before the ghost "Deny".
    expect(html.indexOf("Allow access")).toBeLessThan(html.indexOf(">Deny<"));
  });
});

describe("renderConsentScreen — unverified-app indicator", () => {
  it("renders the unverified badge + warning notice for a public/DCR client", () => {
    const html = renderConsentScreen({ ...PARAMS, unverified: true });
    expect(html).toContain('class="unverified-badge"');
    expect(html).toContain("Unverified app");
    // Caution block above the form, escalated as a warn alert.
    expect(html).toContain('class="alert alert--warn"');
    expect(html).toContain("This app is unverified");
  });

  it("places the badge inline next to the self-asserted client name", () => {
    const html = renderConsentScreen({ ...PARAMS, unverified: true });
    expect(html).toMatch(
      /<span class="client-name">Test CLI<\/span>\s*<span class="unverified-badge"/,
    );
  });

  it("omits the badge + notice when unverified is false or absent", () => {
    const off = renderConsentScreen({ ...PARAMS, unverified: false });
    expect(off).not.toContain("unverified-badge");
    expect(off).not.toContain("alert--warn");
    expect(off).not.toContain("This app is unverified");

    const absent = renderConsentScreen(PARAMS);
    expect(absent).not.toContain("unverified-badge");
    expect(absent).not.toContain("alert--warn");
  });

  it("still escapes a hostile client name when the badge is shown", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      clientName: "<script>alert(1)</script>",
      unverified: true,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('class="unverified-badge"');
  });

  it("shows the badge in the re-consent diff variant too", () => {
    const html = renderConsentScreen({
      ...PARAMS,
      unverified: true,
      priorScopes: ["core.note:read"],
    });
    expect(html).toContain('class="unverified-badge"');
    expect(html).toContain("Update access");
  });
});

describe("renderConsentScreen — four-bucket bundle view", () => {
  // A representative requested set: each maps to one default bundle, plus
  // offline_access which belongs to none (residual).
  const BUNDLE_SCOPES: ParsedScope[] = [
    { typePattern: "core.*", operation: "read" },
    { typePattern: "core.*", operation: "write" },
    {
      typePattern: "openid",
      operation: "none",
      kind: "oidc",
      oidcScope: "openid",
    },
    { typePattern: "system.connection", operation: "read" },
    {
      typePattern: "offline_access",
      operation: "none",
      kind: "oidc",
      oidcScope: "offline_access",
    },
  ];
  const BUNDLE_PARAMS = {
    ...PARAMS,
    scopes: BUNDLE_SCOPES,
    bundles: DEFAULT_PERMISSION_BUNDLES,
  };

  it("renders the four bundle labels each with a master toggle", () => {
    const html = renderConsentScreen(BUNDLE_PARAMS);
    for (const label of [
      "Read your stuff",
      "Write your stuff",
      "Your profile",
      "Connected services",
    ]) {
      expect(html).toContain(label);
    }
    for (const id of ["read", "write", "profile", "connected"]) {
      expect(html).toContain(`data-bundle-toggle="${id}"`);
    }
  });

  it("preserves the form contract — granular scope checkboxes as bundle members", () => {
    const html = renderConsentScreen(BUNDLE_PARAMS);
    expect(html).toContain('value="core.*:read"');
    expect(html).toContain('value="core.*:write"');
    expect(html).toContain('data-bundle-member="read"');
    expect(html).toContain('data-bundle-member="write"');
    // Granular tucked away; a Customise control reveals it.
    expect(html).toContain("data-bundle-scopes");
    expect(html).toContain("Customise permissions");
  });

  it("puts a scope belonging to no bundle under a residual group (still granted)", () => {
    const html = renderConsentScreen(BUNDLE_PARAMS);
    expect(html).toContain("bundle--residual");
    expect(html).toContain('value="offline_access"');
  });

  it("does not render the flat section markup in bundle view", () => {
    const html = renderConsentScreen(BUNDLE_PARAMS);
    expect(html).toContain('class="bundle-row"');
    // Flat section headers are not rendered (the script may still reference
    // the data attributes; assert on rendered markup only).
    expect(html).not.toContain('class="section__label"');
  });

  it("falls back to the flat section view when no bundles are passed", () => {
    const html = renderConsentScreen(PARAMS);
    expect(html).not.toContain('class="bundle-row"');
    expect(html).toContain('class="section__label"');
  });
});
