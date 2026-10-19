/**
 * What a person sees at the end of a browser logout.
 *
 * The OAuth Provider plugin's RP-initiated logout ends the session and then
 * redirects, but only when the app's `post_logout_redirect_uri` exactly
 * matches one it registered. On any other outcome it falls off the end of its
 * handler and returns undefined, which serializes as an empty 200: the
 * session really is gone, and the person is looking at a blank document with
 * no indication that anything worked or any way onward.
 *
 * So this is the floor rather than the happy path. A correctly registered
 * client still gets its redirect and never arrives here. A deployment that
 * has misregistered one gets a page that tells the truth instead of a blank
 * tab, which is the difference between a small configuration bug and a
 * logout that looks broken.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { confirmIcon } from "./auth-html.js";

/** Renders the end-of-logout page as a full HTML document. */
export function renderSignedOutPage(nonce: string): string {
  const bodyHtml = `
    ${confirmIcon("check")}
    <h1 class="title">You're signed out</h1>
    <p class="sub" role="status">Your session on this device has ended. You can close this tab, or sign in again from the app you were using.</p>
  `;

  return renderAuthLayout({
    title: "You're signed out",
    bodyHtml,
    centered: true,
    nonce,
  });
}
