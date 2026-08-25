/**
 * The sign-up-closed refusal.
 *
 * It has to do two things that pull against each other: say nothing about
 * whether an address has an account anywhere, and still leave a reader able
 * to work out what went wrong. Naming the host is what reconciles them,
 * because the host is already in the address bar and an account holder on a
 * different instance otherwise reads the refusal as being about them.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  renderSignInLinkFailedPage,
  configuredHost,
} from "./sign-in-link-page.js";

const original = process.env.MARFA_AUTH_BASE_URL;
afterEach(() => {
  if (original === undefined) delete process.env.MARFA_AUTH_BASE_URL;
  else process.env.MARFA_AUTH_BASE_URL = original;
});

describe("the sign-up-closed page", () => {
  it("names the host it applies to", () => {
    const html = renderSignInLinkFailedPage({
      returnTo: "/",
      reason: "signup_closed",
      host: "staging.marfa.so",
    });
    expect(html).toContain("staging.marfa.so");
    expect(html).toContain("already exist there");
  });

  it("says nothing about whether the address has an account", () => {
    // The property the reticence exists for. If this copy ever varies on
    // whether the address is known, sign-in becomes a way to enumerate
    // which addresses hold accounts.
    const html = renderSignInLinkFailedPage({
      returnTo: "/",
      reason: "signup_closed",
      host: "staging.marfa.so",
    });
    for (const leak of [
      "no account",
      "not found",
      "unknown",
      "does not exist",
    ]) {
      expect(html.toLowerCase()).not.toContain(leak);
    }
  });

  it("offers no retry, because another link bounces the same way", () => {
    const html = renderSignInLinkFailedPage({
      returnTo: "/",
      reason: "signup_closed",
      host: "staging.marfa.so",
    });
    expect(html).not.toContain("Send another link");
  });

  it("reads as it did before when no host is configured", () => {
    const html = renderSignInLinkFailedPage({
      returnTo: "/",
      reason: "signup_closed",
    });
    expect(html).toContain("already exist here");
  });

  it("escapes a host rather than trusting it", () => {
    const html = renderSignInLinkFailedPage({
      returnTo: "/",
      reason: "signup_closed",
      host: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("configuredHost", () => {
  it("takes the host from the configured base URL", () => {
    process.env.MARFA_AUTH_BASE_URL = "https://staging.marfa.so";
    expect(configuredHost()).toBe("staging.marfa.so");
  });

  it("keeps a non-default port, since that is part of which server this is", () => {
    process.env.MARFA_AUTH_BASE_URL = "http://localhost:8787";
    expect(configuredHost()).toBe("localhost:8787");
  });

  it("yields nothing rather than throwing on a malformed value", () => {
    // This runs while rendering an error page, which is the worst place to
    // raise a second error.
    process.env.MARFA_AUTH_BASE_URL = "not a url";
    expect(configuredHost()).toBeUndefined();
  });

  it("yields nothing when unset", () => {
    delete process.env.MARFA_AUTH_BASE_URL;
    expect(configuredHost()).toBeUndefined();
  });
});
