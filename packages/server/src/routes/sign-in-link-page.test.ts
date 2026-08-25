import { describe, it, expect } from "vitest";
import {
  renderSignInLinkFailedPage,
  hostFromBaseUrl,
} from "./sign-in-link-page.js";

/**
 * The dead-sign-in-link page, and the sign-up-closed variant beside it.
 *
 * The two cases are one route and two entirely different messages, and the
 * failure mode being pinned here is telling somebody the wrong cause: a
 * closed sign-up rendered with the expiry copy invites a retry that bounces
 * identically, forever. The route-level half of this — that the configured
 * host actually reaches the renderer — is in `sign-in-complete.test.ts`,
 * because that is where the call site is.
 */
/**
 * Every `sub` paragraph on the page, in order.
 *
 * Returned as a list rather than joined so a test can assert the count as
 * well as the content: a second paragraph is the shape an accidental
 * disclosure takes, and a containment check cannot see one.
 */
function subParagraphs(html: string): string[] {
  return [...html.matchAll(/<p class="sub"[^>]*>([\s\S]*?)<\/p>/g)].map(
    (m) => m[1]?.trim() ?? "",
  );
}

describe("the sign-up-closed page", () => {
  it("names the host it applies to", () => {
    const html = renderSignInLinkFailedPage({
      returnTo: "/",
      reason: "signup_closed",
      host: "staging.marfa.so",
    });
    expect(html).toContain("Sign-in links on staging.marfa.so");
    expect(html).toContain("only work for accounts that already exist here");
  });

  /**
   * Pinned as the whole of what the page says, rather than as a phrase
   * it must contain.
   *
   * Two earlier versions were weaker. The first asserted the copy did not
   * match `no account`, `not registered` or `unknown address`, which
   * passes for "we don't have a user with that email" and every other way
   * of saying the same thing. The second pinned the sentence with
   * `toContain`, which catches a rewording and misses an addition — and
   * an accidental leak arrives as an extra helpful sentence far more often
   * than as a rewrite of the careful one.
   *
   * So this extracts every `sub` paragraph, asserts there is exactly one,
   * and compares it entire. The property is that sign-in cannot be used to
   * discover which addresses hold accounts; the assertion is that the page
   * says this and nothing else.
   */
  it("speaks about the space and never about the address", () => {
    const html = renderSignInLinkFailedPage({
      returnTo: "/",
      reason: "signup_closed",
      host: "staging.marfa.so",
    });
    expect(subParagraphs(html)).toEqual([
      "Sign-in links on staging.marfa.so only work for accounts that already " +
        "exist here, and this space isn't accepting new ones. An account on " +
        "a different Marfa server won't work here. If you should have an " +
        "account, ask whoever runs this space.",
    ]);
  });

  it("offers no retry, because another link bounces the same way", () => {
    const html = renderSignInLinkFailedPage({
      returnTo: "/",
      reason: "signup_closed",
      host: "staging.marfa.so",
    });
    expect(html).not.toContain("Send another link");
  });

  it("names no host when there is none worth naming", () => {
    const html = renderSignInLinkFailedPage({
      returnTo: "/",
      reason: "signup_closed",
    });
    expect(html).toContain("only work for accounts that already exist here");
    expect(html).not.toContain("Sign-in links on ");
  });

  /**
   * The deictic has to be the same word throughout.
   *
   * An earlier draft said links "only work for accounts that already exist
   * there" and then that another server's account "won't work here", both
   * denoting this server. The reader is by definition unsure which server
   * they are on, so the copy cannot afford two words for it.
   */
  it("uses one word for this server throughout", () => {
    const html = renderSignInLinkFailedPage({
      returnTo: "/",
      reason: "signup_closed",
      host: "staging.marfa.so",
    });
    expect(html).not.toContain("already exist there");
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

describe("the dead-link page", () => {
  it("names both causes, because they are indistinguishable by now", () => {
    const html = renderSignInLinkFailedPage({ returnTo: "/" });
    expect(html).toContain("already been used, or it had run out of time");
  });

  it("offers a fresh link that resumes where the user was heading", () => {
    const html = renderSignInLinkFailedPage({ returnTo: "/settings/keys" });
    expect(html).toContain("Send another link");
    expect(html).toContain("mode=magic");
    expect(html).toContain("return_to=%2Fsettings%2Fkeys");
  });
});

describe("hostFromBaseUrl", () => {
  it("takes the host from a configured base URL", () => {
    expect(hostFromBaseUrl("https://staging.marfa.so")).toBe(
      "staging.marfa.so",
    );
  });

  it("keeps a non-default port, since that is part of which server this is", () => {
    expect(hostFromBaseUrl("https://staging.marfa.so:8787")).toBe(
      "staging.marfa.so:8787",
    );
  });

  it("yields nothing rather than throwing on a malformed value", () => {
    // This renders an error page. A second failure here is the least
    // welcome one anywhere in the surface.
    expect(hostFromBaseUrl("not a url")).toBeUndefined();
  });

  it("yields nothing for an absent or empty base URL", () => {
    // A deployment that ships the variable blank rather than unset lands
    // here rather than on the localhost fallback, and both must be silent.
    expect(hostFromBaseUrl(undefined)).toBeUndefined();
    expect(hostFromBaseUrl("")).toBeUndefined();
  });

  /**
   * The rule that makes the whole change safe, and the one worth breaking
   * on purpose.
   *
   * With `MARFA_AUTH_BASE_URL` unset, config resolves to a localhost URL.
   * Naming it tells somebody who reached this page at a real domain
   * something that cannot be true of the server they are talking to, which
   * is a worse version of the confusion this copy exists to remove.
   */
  it("refuses a loopback host, however the value arrived", () => {
    for (const value of [
      "http://localhost:8600",
      "http://localhost",
      // Upper case included deliberately: the URL parser lower-cases the
      // hostname, and this pins that rather than a folding step in our code.
      "http://LOCALHOST:8600",
      "http://127.0.0.1:8600",
      "http://0.0.0.0:8600",
      "http://[::1]:8600",
      // The IPv6 counterparts of the two above. `[::]` was missing while
      // the header claimed to cover unspecified hosts.
      "http://[::]:8600",
      "http://[0:0:0:0:0:0:0:1]:8600",
      "http://[::ffff:127.0.0.1]:8600",
      // Shorthand spellings the URL parser folds before we see them. Here
      // to pin that it does, since the set has no entries for them.
      "http://127.1",
      "http://2130706433",
      "http://0x7f000001",
      "http://0",
      // A trailing dot is a legitimate fully-qualified spelling, and the
      // parser strips it from `127.0.0.1.` but not from `localhost.`.
      "http://localhost.:8600",
      "http://127.0.0.1.:8600",
    ]) {
      expect(hostFromBaseUrl(value), value).toBeUndefined();
    }
  });

  it("still names a real host that merely looks local", () => {
    // The refusal is on the hostname, not on the string containing it.
    expect(hostFromBaseUrl("https://localhost.marfa.so")).toBe(
      "localhost.marfa.so",
    );
    expect(hostFromBaseUrl("https://marfa.local")).toBe("marfa.local");
    // A real host keeps its trailing dot: the dot is stripped for the
    // lookup only, not from what the page renders.
    expect(hostFromBaseUrl("https://marfa.so.")).toBe("marfa.so.");
  });
});
