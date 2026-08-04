import { describe, it, expect } from "vitest";
import { renderEmail } from "./email-layout.js";
import { renderVerifyEmailEmail } from "./verify-email.js";
import { renderMagicLinkEmail } from "./magic-link.js";
import { renderResetPasswordEmail } from "./reset-password.js";
import { renderAccountDeleteConfirmEmail } from "./account-delete-confirm.js";
import { renderAccountPendingDeletionEmail } from "./account-pending-deletion.js";
import { renderAccountDeleteCancelEmail } from "./account-delete-cancel.js";

describe("renderEmail", () => {
  it("returns subject, html, and text", () => {
    const out = renderEmail({
      subject: "Test subject",
      heading: "Test heading",
      intro: ["First line."],
    });
    expect(out.subject).toBe("Test subject");
    expect(out.html.length).toBeGreaterThan(0);
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("renders the Marfa wordmark, heading, button label, and href", () => {
    const { html } = renderEmail({
      subject: "Sub",
      heading: "Welcome aboard",
      intro: ["Hello."],
      button: { label: "Get started", url: "https://example.com/go" },
    });
    expect(html).toContain("Marfa");
    expect(html).toContain("Welcome aboard");
    expect(html).toContain("Get started");
    expect(html).toContain('href="https://example.com/go"');
  });

  it("uses the monochrome primary and never the old GitHub blue", () => {
    const { html } = renderEmail({
      subject: "Sub",
      heading: "Heading",
      intro: ["Body."],
      button: { label: "Go", url: "https://example.com" },
    });
    expect(html).toContain("#171717");
    expect(html).not.toContain("#1f6feb");
  });

  it("escapes HTML metacharacters in heading and url", () => {
    const { html } = renderEmail({
      subject: "Sub",
      heading: `A <b>bold</b> & "quoted" 'heading'`,
      intro: ["Body."],
      button: { label: "Go", url: `https://example.com/?a=1&b=<2>"x"` },
    });
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    // React escapes apostrophes as &#x27; (hex form), not &#39;.
    expect(html).toContain("&#x27;");
    // The raw, unescaped url must not appear in an attribute.
    expect(html).not.toContain('href="https://example.com/?a=1&b=<2>"x""');
  });

  it("builds the text part from heading and button url", () => {
    const { text } = renderEmail({
      subject: "Sub",
      heading: "My heading",
      intro: ["Para one."],
      button: { label: "Click", url: "https://example.com/link" },
    });
    expect(text).toContain("My heading");
    expect(text).toContain("https://example.com/link");
    expect(text).toContain("Para one.");
  });

  it("renders the danger callout when supplied", () => {
    const { html, text } = renderEmail({
      subject: "Sub",
      heading: "Heading",
      intro: ["Body."],
      callout: "This is irreversible.",
    });
    expect(html).toContain("This is irreversible.");
    expect(text).toContain("This is irreversible.");
  });

  it("never prints the full URL in the HTML body, only as the fallback href", () => {
    const longUrl =
      "https://staging.marfa.so/auth/verify-email?token=averylongopaquetokenvalue123456&callbackURL=%2F";
    const { html, text } = renderEmail({
      subject: "Sub",
      heading: "Heading",
      intro: ["Body."],
      button: { label: "Go", url: longUrl },
    });
    // The fallback is a short anchor, not the raw URL printed as text.
    expect(html).toContain("Button not working?");
    expect(html).toContain("Open the link directly");
    // The URL lives in the anchor's href (ampersands HTML-escaped there).
    expect(html).toContain("token=averylongopaquetokenvalue123456");
    expect(html).toContain("&amp;callbackURL");
    // The visible body never spells the long URL out as text.
    expect(html).not.toContain("Or paste this URL");
    expect(html).not.toContain(`>${longUrl}<`);
    // The plain-text part still carries the full pasteable URL verbatim.
    expect(text).toContain(longUrl);
  });

  it("omits the fallback link when showFallbackLink is false", () => {
    const { html } = renderEmail({
      subject: "Sub",
      heading: "Heading",
      intro: ["Body."],
      button: { label: "Go", url: "https://example.com/secret" },
      showFallbackLink: false,
    });
    expect(html).not.toContain("Button not working?");
  });
});

describe("template render smoke", () => {
  const url = "https://staging.marfa.so/auth/x?token=abc";
  const cases = [
    {
      name: "verify-email",
      out: renderVerifyEmailEmail({ url }),
      subject: "Verify your email",
    },
    {
      name: "magic-link",
      out: renderMagicLinkEmail({ url }),
      subject: "Your Marfa sign-in link",
    },
    {
      name: "reset-password",
      out: renderResetPasswordEmail({ url }),
      subject: "Reset your Marfa password",
    },
    {
      name: "account-delete-confirm",
      out: renderAccountDeleteConfirmEmail({ url }),
      subject: "Confirm your account deletion",
    },
    {
      name: "account-pending-deletion",
      out: renderAccountPendingDeletionEmail({
        url,
        deletionDate: "2026-07-01",
        graceDays: 30,
      }),
      subject: "Your Marfa account is scheduled for deletion",
    },
    {
      name: "account-delete-cancel",
      out: renderAccountDeleteCancelEmail({ url, deletionDate: "2026-07-01" }),
      subject: "A sign-in was attempted on your account",
    },
  ];

  for (const { name, out, subject } of cases) {
    it(`${name} returns non-empty html/text with its real subject`, () => {
      expect(out.subject).toBe(subject);
      expect(out.html.length).toBeGreaterThan(0);
      expect(out.text.length).toBeGreaterThan(0);
      expect(out.html).toContain("Marfa");
      expect(out.html).toContain(url);
      expect(out.html).not.toContain("#1f6feb");
    });
  }

  it("account-pending-deletion surfaces the grace-window callout copy", () => {
    const out = renderAccountPendingDeletionEmail({
      url,
      deletionDate: "2026-07-01",
      graceDays: 30,
    });
    expect(out.html).toContain("will be deleted in 30 days, on 2026-07-01");
    expect(out.html).toContain("Cancel deletion");
  });
});
