/**
 * Result page for a sign-in link that did not work, rendered by
 * `GET /auth/sign-in/complete` when the magic-link verify bounced.
 *
 * The verify step consumes its token atomically and reports one code,
 * `INVALID_TOKEN`, for a link that had already been used and for one that had
 * timed out. Those are genuinely indistinguishable by the time we are asked,
 * so the copy names both rather than picking one and being wrong half the
 * time. Telling a user their link expired when they had in fact already used
 * it sends them looking for a clock problem that isn't there.
 *
 * The way forward is a fresh link, so the primary action asks for one. It
 * carries `return_to` through, which is what puts the user back where they
 * started rather than at the root.
 *
 * One bounce is not a dead link at all: when sign-up is closed, a link
 * resolving to an address with no account is refused deliberately. The
 * retry copy is actively wrong there — another link bounces the same way,
 * so offering one loops the user forever. That case gets its own copy and
 * no retry button, on the same reasoning the paragraph above uses for the
 * expiry pair: telling somebody the wrong cause sends them looking for a
 * problem that isn't theirs.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml, buildQuery, confirmIcon } from "./auth-html.js";

interface SignInLinkFailedParams {
  /** Where the user was heading before sign-in interrupted them. Threaded
   *  onto the "send another" link so a fresh attempt resumes rather than
   *  restarts. */
  returnTo: string;
  /** Why the verify bounced. Defaults to the `INVALID_TOKEN` pair (spent
   *  or timed out). `signup_closed` is the magic-link plugin refusing to
   *  create an account on an instance that has sign-up switched off. */
  reason?: "expired" | "signup_closed";
  /**
   * The host this instance answers as, named in the sign-up-closed copy.
   *
   * Taken from the configured base URL rather than the request, because the
   * request's host is whatever the client sent and this string is rendered
   * back to them. Omitted when that is not configured, and the copy then
   * reads as it did before rather than naming a host it is guessing at.
   */
  host?: string;
}

/**
 * The host this instance answers as, or undefined when it is not configured.
 *
 * Read from the configured base URL rather than the request, because the
 * request's host is client-supplied and this value is rendered back to the
 * client. A malformed value yields nothing rather than throwing on an error
 * page, which is the one place a second failure is least welcome.
 */
export function configuredHost(): string | undefined {
  const raw = process.env.MARFA_AUTH_BASE_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).host || undefined;
  } catch {
    return undefined;
  }
}

/** Renders the dead-sign-in-link page as a full HTML document. */
export function renderSignInLinkFailedPage(
  params: SignInLinkFailedParams,
): string {
  if (params.reason === "signup_closed") {
    const title = "This space isn't open for new accounts";
    // Naming the host is the whole of this copy's job beyond the refusal.
    // The refusal itself stays deliberately silent about whether the address
    // has an account, so that sign-in cannot be used to discover which
    // addresses exist, and naming the host leaks nothing the address bar does
    // not already show. What it fixes is the reading: an account holder on
    // another instance sees a message that appears to be about their account
    // rather than about which server they are on, and goes looking for a
    // problem that is not theirs.
    const where = params.host
      ? `Sign-in links on ${escapeHtml(params.host)} only work for accounts that already exist there`
      : "Sign-in links only work for accounts that already exist here";
    return renderAuthLayout({
      title,
      bodyHtml: `
    ${confirmIcon("alert")}
    <h1 class="title">${title}</h1>
    <p class="sub" role="alert">${where}, and this space isn't accepting new ones. An account on a different Marfa server won't work here. If you should have an account, ask whoever runs this space.</p>
  `,
      centered: true,
    });
  }

  const retryHref = `/auth/sign-in?${buildQuery({
    mode: "magic",
    return_to: params.returnTo,
  })}`;
  const bodyHtml = `
    ${confirmIcon("alert")}
    <h1 class="title">That sign-in link didn't work</h1>
    <p class="sub" role="alert">A sign-in link works once and lasts a few minutes. This one had already been used, or it had run out of time. Send yourself another and it will work.</p>
    <div class="actions">
      <a href="${escapeHtml(retryHref)}" class="btn btn--primary">Send another link</a>
    </div>
  `;
  return renderAuthLayout({
    title: "That sign-in link didn't work",
    bodyHtml,
    centered: true,
  });
}
