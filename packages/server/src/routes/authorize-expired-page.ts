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
 * it safe to render at all, so this renderer deliberately takes no
 * parameters.
 *
 * Recovery starts at the app for the same reason. A "try again" control
 * here could only point back at the request that just failed, and the
 * only party able to mint a fresh one is the client.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { confirmIcon } from "./auth-html.js";

/** Renders the expired-authorize-request page as a full HTML document. */
export function renderAuthorizeExpiredPage(): string {
  const bodyHtml = `
    ${confirmIcon("alert")}
    <h1 class="title">This request has expired</h1>
    <p class="sub" role="alert">Sign-in requests time out after a few minutes. Go back to the app you were signing in to and start again.</p>
  `;

  return renderAuthLayout({
    title: "This request has expired",
    bodyHtml,
    centered: true,
  });
}
