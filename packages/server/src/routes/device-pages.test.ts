import { describe, it, expect } from "vitest";
import type { ParsedScope } from "@withmarfa/shared";
import {
  renderDevicePage,
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
} from "./device-pages.js";

/**
 * Behavior-preserving smoke for the three device-flow page renderers.
 * The handler-side smoke (RFC 8628 polling round-trip) lives in
 * device-grant.test.ts; this file asserts the HTML shape directly.
 */

const SCOPES: ParsedScope[] = [
  { kind: "type", typePattern: "core.note", operation: "read" },
];

describe("renderDevicePage", () => {
  it("links to the shared stylesheet and has no inline <style>", () => {
    const html = renderDevicePage({ prefilled: "" });
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
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

describe("renderDeviceConsentScreen", () => {
  const PARAMS = {
    clientName: "marfa CLI",
    scopes: SCOPES,
    userCode: "ABCD-1234",
    descriptions: { "core.note": "Text you created." },
  };

  it("links to the shared stylesheet and has no inline <style>", () => {
    const html = renderDeviceConsentScreen(PARAMS);
    expect(html).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(html).not.toContain("<style>");
  });

  it("threads client name + user_code into the lede", () => {
    const html = renderDeviceConsentScreen(PARAMS);
    expect(html).toContain("<b>marfa CLI</b>");
    expect(html).toContain("ABCD-1234");
  });

  it("renders an Approve and Deny POST form pair", () => {
    const html = renderDeviceConsentScreen(PARAMS);
    const matches = html.match(
      /<form method="POST" action="\/auth\/device\/consent"/g,
    );
    expect(matches?.length).toBe(2);
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="deny"');
  });

  it("renders the plain-English description for each scope (no code literals)", () => {
    const html = renderDeviceConsentScreen(PARAMS);
    expect(html).toContain("Text you created.");
    expect(html).not.toContain("core.note:read");
  });

  it("renders each capability as a .crow check row", () => {
    const html = renderDeviceConsentScreen(PARAMS);
    expect(html).toContain('class="crow"');
    expect(html).toContain("Text you created.");
  });

  it("renders the user_code whole in a code tile, not an entry field", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      userCode: "WDJB-MJHT",
    });
    expect(html).toContain('class="codetile"');
    expect(html).toContain("WDJB-MJHT");
    // The display is not a real form input — no entry <input> for the code.
    expect(html).not.toContain('class="field__input--code"');
  });

  it("escapes a malicious client name", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      clientName: "<script>x</script>",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("maps OIDC scopes to friendly labels, never the raw literal", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      scopes: [
        {
          typePattern: "openid",
          operation: "none",
          kind: "oidc",
          oidcScope: "openid",
        },
        {
          typePattern: "email",
          operation: "none",
          kind: "oidc",
          oidcScope: "email",
        },
        { kind: "type", typePattern: "core.note", operation: "read" },
      ],
    });
    // The consent screen's words, not this screen's own. Both surfaces now
    // read the same literal the same way; this screen used to say "Confirm
    // who you are" and "See your email address" from a map of its own.
    expect(html).toContain("Confirm your identity");
    expect(html).toContain("Your email address");
    // The raw OIDC literal must not surface as a capability row.
    expect(html).not.toContain(">openid<");
    expect(html).not.toContain("openid:none");
  });

  it("dedupes human labels across multiple scopes (no repeated lines)", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      // core.note read + write both resolve to the same human label; the
      // device flow used to render it twice.
      scopes: [
        { kind: "type", typePattern: "core.note", operation: "read" },
        { kind: "type", typePattern: "core.note", operation: "write" },
      ],
      descriptions: { "core.note": "Text you created." },
    });
    const occurrences = html.split("Text you created.").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("renderDeviceDecisionPage", () => {
  it("confirms the sign-in when approved", () => {
    const html = renderDeviceDecisionPage({ approved: true });
    expect(html).toContain('role="status"');
    expect(html).toContain("You&#39;re signed in");
    expect(html).toContain("return to your other device");
  });

  it("confirms the denial when denied", () => {
    const html = renderDeviceDecisionPage({ approved: false });
    expect(html).toContain('role="status"');
    expect(html).toContain("You denied the request");
  });

  it("links to the shared stylesheet on both branches", () => {
    expect(renderDeviceDecisionPage({ approved: true })).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
    expect(renderDeviceDecisionPage({ approved: false })).toContain(
      '<link rel="stylesheet" href="/auth/static/auth.css">',
    );
  });
});
