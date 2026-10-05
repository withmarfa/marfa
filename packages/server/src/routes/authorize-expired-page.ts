/**
 * The page an authorization request lands on once it can no longer
 * produce a code.
 *
 * The OAuth Provider plugin signs each authorize request with a short
 * expiry, and that window has to cover the user's entire authentication
 * journey — a magic-link round trip, or a sign-up with an email
 * verification hop, routinely outlasts it. So reaching this page is an
 * ordinary thing for an honest user to do, not a developer error, and it
 * gets the same treatment as every other terminal auth screen.
 *
 * **Nothing is interpolated, by design.** A request that fails
 * verification is one nobody signed: the client name and the permission
 * list on it would be whoever crafted the URL's to choose, and a page
 * built from them, served by the real issuer on the real origin, is the
 * payload rather than the defense against it. Fixed copy is what makes
 * it safe to render at all, so this renderer takes a verdict and nothing
 * else.
 *
 * **Why the verdict is worth showing.** The two outcomes used to share
 * one screen, on the reasoning that the user's next move is the same
 * either way and that naming the difference tells a prober something.
 * The first half held; the second did not survive contact. A request
 * that timed out and one whose signature did not verify are different
 * events with different causes, and collapsing them cost days of
 * diagnosis on a corruption bug that presented, every time, as an
 * expiry that had not happened. Nothing here is interpolated and
 * nothing secret is disclosed: someone who forged a signature already
 * knows they forged it, while the honest user gets a sentence that
 * matches what actually occurred.
 *
 * Recovery starts at the app either way. A "try again" control here
 * could only point back at the request that just failed, and the only
 * party able to mint a fresh one is the client.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { confirmIcon } from "./auth-html.js";

/** Why the request could not proceed: the non-valid arms of
 *  `SignedQueryVerdict`, plus the states the authorize route refuses in its
 *  own right. A new failure mode has to choose its words here rather than
 *  inheriting somebody else's. */
export type AuthorizeFailure = "expired" | "unverifiable";

const COPY: Record<AuthorizeFailure, { title: string; sub: string }> = {
  expired: {
    title: "This request has expired",
    sub: "Sign-in requests time out after a few minutes. Go back to the app you were signing in to and start again.",
  },
  unverifiable: {
    title: "We could not verify this request",
    sub: "This sign-in request is not one we recognize, so we stopped rather than continue with it. Go back to the app you were signing in to and start again.",
  },
};

/** Renders the failed-authorize-request page as a full HTML document. */
export function renderAuthorizeExpiredPage(
  nonce: string,
  failure: AuthorizeFailure = "expired",
): string {
  const { title, sub } = COPY[failure];
  const bodyHtml = `
    ${confirmIcon("alert")}
    <h1 class="title">${title}</h1>
    <p class="sub" role="alert">${sub}</p>
  `;

  return renderAuthLayout({ title, bodyHtml, centered: true, nonce });
}
