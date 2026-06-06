import { describe, it, expect } from "vitest";
import type { ParsedScope } from "@withmarfa/shared";
import {
  renderDevicePage,
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
} from "./device-pages.js";

/**
 * Behaviour-preserving smoke for the three device-flow page renderers.
 * The handler-side smoke (RFC 8628 polling round-trip) lives in
 * device-grant.test.ts; this file asserts the HTML shape directly.
 */

const SCOPES: ParsedScope[] = [{ typePattern: "core.note", operation: "read" }];

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

  it("surfaces error codes as a banner with role=alert", () => {
    const html = renderDevicePage({ prefilled: "", error: "invalid_code" });
    expect(html).toContain('class="banner banner--error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("recognised. Check for typos");
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
    expect(html).toContain('class="client-name">marfa CLI');
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

  it("renders the description for each scope when provided", () => {
    const html = renderDeviceConsentScreen(PARAMS);
    expect(html).toContain("Text you created.");
    expect(html).toContain("<code>core.note:read</code>");
  });

  it("escapes a malicious client name", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      clientName: "<script>x</script>",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders OIDC scopes as the bare literal, not <literal>:none", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      scopes: [
        {
          typePattern: "openid",
          operation: "none",
          kind: "oidc",
          oidcScope: "openid",
        },
        { typePattern: "core.note", operation: "read" },
      ],
    });
    expect(html).toContain("<code>openid</code>");
    expect(html).not.toContain("openid:none");
  });
});

describe("renderDeviceDecisionPage", () => {
  it("renders a success banner when approved", () => {
    const html = renderDeviceDecisionPage({ approved: true });
    expect(html).toContain('class="banner banner--success"');
    expect(html).toContain("You&#39;re signed in");
    expect(html).toContain("return to your other device");
  });

  it("renders an error banner when denied", () => {
    const html = renderDeviceDecisionPage({ approved: false });
    expect(html).toContain('class="banner banner--error"');
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
